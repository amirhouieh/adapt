import type { VersionRef } from '../../learning/contracts'
import { LearningRegistry } from '../../learning/registry'
import {
	fitTextProcedureRequest,
	type ProcedurePorts,
	type ProcedureProposal,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	type TextLearningConfig,
	validateTextLearningConfig,
} from '../../learning/text-procedures'
import {
	LearningCoordinator,
	type TextActivationResult,
	type TextCoordinatorSnapshot,
	type TextEnqueueResult,
	type TextInput,
	TextLearningStateStore,
	type TextProcedureDecision,
	type TextProfileSnapshot,
	type TextRunResult,
	type TextStateClock,
	type TextStateIds,
	type TextStatePolicy,
	type TextStateScheduler,
} from '../../learning/text-state'
import type { NeuronStore } from '../../stores'

export interface AdaptiveTextModelProfile {
	readonly ref: VersionRef
	readonly provider: ProcedurePorts['provider']
	readonly tokens: ProcedurePorts['tokens']
}

export interface AdaptiveTextLearningRuntime {
	readonly models: readonly AdaptiveTextModelProfile[]
	readonly stateIds: TextStateIds
	readonly inputIds: { next(): string }
	readonly clock: TextStateClock
	readonly scheduler: TextStateScheduler
	readonly policy: TextStatePolicy
	readonly countInputTokens: (inputs: readonly TextInput[]) => number
	readonly onError: (error: unknown) => void
}

export interface AdaptiveTextLearningConfig {
	readonly mode: 'adaptive'
	readonly initialProfile: TextProfileSnapshot<TextLearningConfig>
	readonly runtime: AdaptiveTextLearningRuntime
}

export interface AdaptiveTextLearnOutput {
	readonly status: 'managed'
	readonly mode: 'adaptive-text'
	readonly enqueued: readonly TextEnqueueResult[]
	readonly runs?: readonly TextRunResult[]
	readonly state: AdaptiveTextLearningState
}

export interface AdaptiveTextFlushOutput {
	readonly runs: readonly TextRunResult[]
	readonly state: AdaptiveTextLearningState
}

export interface AdaptiveTextLearningState extends TextCoordinatorSnapshot {
	readonly capacity: readonly {
		readonly workId: string
		readonly reason: string
		readonly memoryRevision: number
		readonly configurationRevision: number
	}[]
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
	return left.id === right.id && left.version === right.version
}

function positive(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${label} must be a positive safe integer`)
}

function model(
	runtime: AdaptiveTextLearningRuntime,
	ref: VersionRef,
): AdaptiveTextModelProfile {
	const matches = runtime.models.filter((entry) => sameRef(entry.ref, ref))
	if (matches.length !== 1)
		throw new Error(
			`adaptive text model profile ${ref.id}@${ref.version} must resolve exactly once`,
		)
	const resolved = matches[0]
	if (resolved === undefined)
		throw new Error('adaptive text model profile is unavailable')
	return resolved
}

function proposalRecord(proposal: ProcedureProposal): unknown {
	return {
		pins: proposal.pins,
		trace: proposal.trace,
		result: proposal.result,
		execution: {
			nodes: proposal.execution.nodes.map(({ nodeId, operation, status }) => ({
				nodeId,
				operation,
				status,
			})),
			pending: proposal.execution.pending,
			budget: proposal.execution.budget,
		},
	}
}

function decision(proposal: ProcedureProposal): TextProcedureDecision {
	const result = proposal.result
	const stored = proposalRecord(proposal)
	if (result.outcome === 'no_change') {
		return { status: 'no_change', proposal: stored, reason: result.reason }
	}
	if (result.outcome === 'defer') {
		return { status: 'defer', proposal: stored, reason: result.reason }
	}
	if (result.outcome === 'failure') {
		return {
			status: 'failure',
			proposal: stored,
			code: result.code,
			retryable: result.retryable,
			reason: result.reason,
		}
	}
	if (
		typeof result.patch !== 'object' ||
		result.patch === null ||
		!('type' in result.patch)
	) {
		return {
			status: 'failure',
			proposal: stored,
			code: 'invalid_patch',
			retryable: false,
			reason: 'procedure returned an invalid narrative patch',
		}
	}
	const patch = result.patch as { type?: unknown; text?: unknown }
	if (patch.type === 'clear') {
		return {
			status: 'clear',
			proposal: stored,
			explanation: result.explanation,
		}
	}
	if (patch.type === 'replace' && typeof patch.text === 'string') {
		return {
			status: 'change',
			narrative: patch.text,
			proposal: stored,
			explanation: result.explanation,
		}
	}
	return {
		status: 'failure',
		proposal: stored,
		code: 'invalid_patch',
		retryable: false,
		reason: 'procedure returned an unsupported narrative patch',
	}
}

export class AdaptiveTextRuntime {
	readonly #store: NeuronStore
	readonly #runtime: AdaptiveTextLearningRuntime
	readonly #coordinator: LearningCoordinator<TextLearningConfig>
	readonly #registry = new LearningRegistry()
	#visibleState: AdaptiveTextLearningState | undefined
	readonly #activeOperations = new Set<Promise<void>>()
	#disposed = false

	constructor(store: NeuronStore, runtime: AdaptiveTextLearningRuntime) {
		this.#store = store
		this.#runtime = runtime
		positive(runtime.policy.maxRetainedProfiles, 'policy.maxRetainedProfiles')
		positive(runtime.policy.maxFlushRuns, 'policy.maxFlushRuns')
		registerAdaptiveTextProcedures(this.#registry)
		const state = new TextLearningStateStore<TextLearningConfig>({
			store,
			ids: runtime.stateIds,
			clock: runtime.clock,
			policy: runtime.policy,
			countInputTokens: runtime.countInputTokens,
			fitsRequest: (input) =>
				fitTextProcedureRequest(
					input as Parameters<typeof fitTextProcedureRequest>[0],
					model(runtime, (input.configuration as TextLearningConfig).model)
						.tokens,
				),
		})
		this.#coordinator = new LearningCoordinator({
			state,
			clock: runtime.clock,
			scheduler: runtime.scheduler,
			policy: runtime.policy,
			onError: runtime.onError,
			onSettled: async () => {
				if (this.#disposed) return
				await this.#refreshVisibleState()
			},
			runProcedure: async (snapshot) =>
				decision(
					await runTextProcedure(snapshot, {
						registry: this.#registry,
						...model(runtime, snapshot.pins.model),
						clock: runtime.clock,
					}),
				),
		})
	}

	async initialize(
		profile: TextProfileSnapshot<TextLearningConfig>,
	): Promise<'initialized' | 'restored'> {
		model(this.#runtime, profile.configuration.model)
		const result = await this.#coordinator.initialize(profile)
		await this.#refreshVisibleState()
		return result
	}

	async learn(inputs: readonly TextInput[]): Promise<AdaptiveTextLearnOutput> {
		return this.#trackOperation(async () => {
			const { enqueued, runs } = await this.#coordinator.learnBatch(inputs)
			await this.#refreshVisibleState()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				status: 'managed',
				mode: 'adaptive-text',
				enqueued,
				...(runs.length > 0 ? { runs } : {}),
				state,
			}
		})
	}

	async flush(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#trackOperation(async () => {
			const runs = await this.#coordinator.flush(signal)
			await this.#refreshVisibleState()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				runs,
				state,
			}
		})
	}

	async resume(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#trackOperation(async () => {
			const runs = await this.#coordinator.resume(signal)
			await this.#refreshVisibleState()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				runs,
				state,
			}
		})
	}

	/**
	 * Publishes a new immutable profile whose configuration is derived from
	 * the active one. Used for developer and Brain instruction changes. Pending work moves to
	 * the new profile through the existing supersede path, and learned memory
	 * is unchanged. Returns `busy` while a learning run is in progress.
	 */
	async updateConfiguration(
		change: (configuration: TextLearningConfig) => TextLearningConfig,
	): Promise<TextActivationResult> {
		return this.#trackOperation(async () => {
			const result = await this.#coordinator.review(
				async (_selection, activate) => {
					const current = await this.#coordinator.activeProfile()
					const configuration = change(current.configuration)
					validateTextLearningConfig(configuration)
					model(this.#runtime, configuration.model)
					const revision = current.revision + 1
					const base = current.ref.version.replace(/\.r\d+$/, '')
					const ref = { id: current.ref.id, version: `${base}.r${revision}` }
					return activate({
						ref,
						revision,
						configuration,
						createdAt: this.#runtime.clock.now(),
						bindings: {
							...current.bindings,
							profile: ref,
							profile_revision: revision,
							procedure: configuration.activeProcedure,
							model: configuration.model,
						},
					})
				},
			)
			await this.#refreshVisibleState()
			return result
		})
	}

	async snapshot(): Promise<AdaptiveTextLearningState> {
		await this.#refreshVisibleState()
		const state = this.#visibleState
		if (state === undefined)
			throw new Error('adaptive text runtime is not initialized')
		return state
	}

	queryStatus(): AdaptiveTextLearningState | undefined {
		return this.#visibleState
	}

	async dispose(): Promise<void> {
		this.#disposed = true
		await this.#coordinator.dispose()
		await Promise.all([...this.#activeOperations])
	}

	async #refreshVisibleState(): Promise<void> {
		const snapshot = await this.#coordinator.snapshot()
		const capacity = (await this.#store.state.list()).flatMap((record) => {
			if (typeof record.value !== 'object' || record.value === null) return []
			const value = record.value as {
				kind?: unknown
				record?: unknown
				workId?: unknown
				reason?: unknown
				memoryRevision?: unknown
				configurationRevision?: unknown
			}
			if (
				value.kind !== this.#runtime.policy.stateKind ||
				value.record !== 'capacity' ||
				typeof value.workId !== 'string' ||
				typeof value.reason !== 'string' ||
				typeof value.memoryRevision !== 'number' ||
				typeof value.configurationRevision !== 'number'
			)
				return []
			return [
				{
					workId: value.workId,
					reason: value.reason,
					memoryRevision: value.memoryRevision,
					configurationRevision: value.configurationRevision,
				},
			]
		})
		this.#visibleState = { ...snapshot, capacity }
	}

	async #trackOperation<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		if (this.#disposed) throw new Error('adaptive text runtime is disposed')
		let complete: (() => void) | undefined
		const completed = new Promise<void>((resolve) => {
			complete = resolve
		})
		this.#activeOperations.add(completed)
		try {
			return await operation()
		} finally {
			this.#activeOperations.delete(completed)
			complete?.()
		}
	}
}
