import { createHash } from 'node:crypto'

import type { VersionRef } from '../../learning/contracts'
import { LearningRegistry } from '../../learning/registry'
import {
	fitTextProcedureRequest,
	type ProcedurePorts,
	type ProcedureProposal,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	type SelectionOutcome,
	selectTextProcedure,
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
import type { NeuronStore, StateRecord } from '../../stores'

export interface AdaptiveTextModelProfile {
	readonly ref: VersionRef
	readonly provider: ProcedurePorts['provider']
	readonly tokens: ProcedurePorts['tokens']
}

export interface AdaptiveTextProcedureEvaluation {
	readonly model: VersionRef
	readonly profile: VersionRef
	readonly evidenceRefs: readonly string[]
}

export interface AdaptiveTextSelectionCatalogueEntry {
	readonly token: string
	readonly expectedEffect: string
	readonly profile: TextProfileSnapshot<TextLearningConfig>
	readonly evaluation: AdaptiveTextProcedureEvaluation
}

export interface AdaptiveTextSelectionRuntime {
	readonly catalogue: readonly AdaptiveTextSelectionCatalogueEntry[]
	readonly limits: {
		readonly maxContextCharacters: number
		readonly maxLearnedChanges: number
		readonly maxPendingInputs: number
		readonly maxFeedbackEntries: number
	}
	readonly feedback: () => Promise<readonly string[]>
}

export interface AdaptiveTextLearningRuntime {
	readonly models: readonly AdaptiveTextModelProfile[]
	readonly stateIds: TextStateIds
	readonly inputIds: { next(): string }
	readonly clock: TextStateClock
	readonly scheduler: TextStateScheduler
	readonly policy: TextStatePolicy & { readonly selectionStateId: string }
	readonly countInputTokens: (inputs: readonly TextInput[]) => number
	readonly onError: (error: unknown) => void
	readonly selection?: AdaptiveTextSelectionRuntime
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
	readonly activation?: TextActivationResult
	readonly state: AdaptiveTextLearningState
}

export interface AdaptiveTextFlushOutput {
	readonly runs: readonly TextRunResult[]
	readonly activation?: TextActivationResult
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

interface SelectionMetadata {
	readonly kind: 'adaptive-text-selection'
	readonly mode: TextLearningConfig['selection']['mode']
	readonly reviewedAt: string
	readonly committedRuns: number
	readonly learnedStateRevision: number
	readonly outcome:
		| 'activated'
		| 'candidate'
		| 'no_change'
		| 'defer'
		| 'failure'
	readonly procedure: VersionRef
	readonly profile: VersionRef
	readonly reason?: string
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
	return left.id === right.id && left.version === right.version
}

function sameStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	)
}

function sameLens(
	left: TextLearningConfig['lens'],
	right: TextLearningConfig['lens'],
): boolean {
	return (
		left.purpose === right.purpose &&
		left.incomingTextRole === right.incomingTextRole &&
		sameStrings(left.developerInstructions, right.developerInstructions) &&
		sameStrings(left.instructionPrecedence, right.instructionPrecedence)
	)
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

function asMetadata(
	record: StateRecord | undefined,
): SelectionMetadata | undefined {
	if (
		record === undefined ||
		typeof record.value !== 'object' ||
		record.value === null
	)
		return undefined
	const value = record.value as { kind?: unknown }
	return value.kind === 'adaptive-text-selection'
		? (record.value as SelectionMetadata)
		: undefined
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class AdaptiveTextRuntime {
	readonly #store: NeuronStore
	readonly #runtime: AdaptiveTextLearningRuntime
	readonly #coordinator: LearningCoordinator<TextLearningConfig>
	readonly #registry = new LearningRegistry()
	#latestActivation: TextActivationResult | undefined
	#visibleState: AdaptiveTextLearningState | undefined
	#selectionTimer: unknown
	readonly #activeOperations = new Set<Promise<void>>()
	#disposed = false

	constructor(store: NeuronStore, runtime: AdaptiveTextLearningRuntime) {
		this.#store = store
		this.#runtime = runtime
		positive(runtime.policy.maxRetainedProfiles, 'policy.maxRetainedProfiles')
		positive(runtime.policy.maxFlushRuns, 'policy.maxFlushRuns')
		if (!runtime.policy.selectionStateId)
			throw new Error('policy.selectionStateId is required')
		if (runtime.selection !== undefined) {
			positive(
				runtime.selection.limits.maxContextCharacters,
				'selection.maxContextCharacters',
			)
			positive(
				runtime.selection.limits.maxLearnedChanges,
				'selection.maxLearnedChanges',
			)
			positive(
				runtime.selection.limits.maxPendingInputs,
				'selection.maxPendingInputs',
			)
			positive(
				runtime.selection.limits.maxFeedbackEntries,
				'selection.maxFeedbackEntries',
			)
		}
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
				const activation = await this.#maybeReview()
				if (activation !== undefined) this.#latestActivation = activation
				await this.#refreshVisibleState()
				await this.#armSelectionTimer()
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
		if (
			profile.configuration.selection.mode === 'periodic' &&
			this.#runtime.selection === undefined
		) {
			throw new Error(
				'periodic adaptive text selection requires a selection runtime',
			)
		}
		const result = await this.#coordinator.initialize(profile)
		await this.#refreshVisibleState()
		await this.#armSelectionTimer()
		return result
	}

	async learn(inputs: readonly TextInput[]): Promise<AdaptiveTextLearnOutput> {
		return this.#trackOperation(async () => {
			const { enqueued, runs } = await this.#coordinator.learnBatch(inputs)
			await this.#refreshVisibleState()
			const activation = this.#takeActivation()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				status: 'managed',
				mode: 'adaptive-text',
				enqueued,
				...(runs.length > 0 ? { runs } : {}),
				...(activation ? { activation } : {}),
				state,
			}
		})
	}

	async flush(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#trackOperation(async () => {
			const runs = await this.#coordinator.flush(signal)
			await this.#refreshVisibleState()
			const activation = this.#takeActivation()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				runs,
				...(activation ? { activation } : {}),
				state,
			}
		})
	}

	async resume(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#trackOperation(async () => {
			const runs = await this.#coordinator.resume(signal)
			await this.#refreshVisibleState()
			const activation = this.#takeActivation()
			const state = this.#visibleState
			if (state === undefined)
				throw new Error('adaptive text runtime is not initialized')
			return {
				runs,
				...(activation ? { activation } : {}),
				state,
			}
		})
	}

	/**
	 * Publishes a new immutable profile whose configuration is derived from
	 * the active one. Used for developer and Brain instruction changes; the
	 * model-driven selector can never change the lens. Pending work moves to
	 * the new profile through the existing supersede path, and learned memory
	 * is unchanged. Returns `busy` while a learning run is in progress.
	 */
	async updateConfiguration(
		change: (configuration: TextLearningConfig) => TextLearningConfig,
	): Promise<TextActivationResult> {
		return this.#trackOperation(async () => {
			const result = await this.#coordinator.review(async (_selection, activate) => {
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
			})
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
		if (this.#selectionTimer !== undefined)
			this.#runtime.scheduler.cancel(this.#selectionTimer)
		this.#selectionTimer = undefined
		await this.#coordinator.dispose()
		await Promise.all([...this.#activeOperations])
	}

	#takeActivation(): TextActivationResult | undefined {
		const activation = this.#latestActivation
		this.#latestActivation = undefined
		return activation
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

	async #armSelectionTimer(): Promise<void> {
		if (this.#selectionTimer !== undefined)
			this.#runtime.scheduler.cancel(this.#selectionTimer)
		this.#selectionTimer = undefined
		if (this.#disposed) return
		const active = await this.#coordinator.activeProfile()
		if (active.configuration.selection.mode !== 'periodic') return
		const previous = asMetadata(
			await this.#store.state.get(this.#runtime.policy.selectionStateId),
		)
		const committedRuns = (await this.#store.learningAttempts.list()).length
		if (
			committedRuns - (previous?.committedRuns ?? 0) <
			active.configuration.selection.minCommittedRuns
		)
			return
		const base = previous?.reviewedAt ?? active.createdAt
		const dueAt = new Date(
			Date.parse(base) + active.configuration.selection.minElapsedMs,
		).toISOString()
		this.#selectionTimer = this.#runtime.scheduler.schedule(dueAt, () => {
			this.#selectionTimer = undefined
			if (this.#disposed) return
			void this.#trackOperation(() => this.#runTimedReview()).catch(
				this.#runtime.onError,
			)
		})
	}

	async #runTimedReview(): Promise<void> {
		if (this.#disposed) return
		try {
			const activation = await this.#maybeReview()
			if (activation !== undefined) this.#latestActivation = activation
			await this.#refreshVisibleState()
			await this.#armSelectionTimer()
		} catch (error) {
			this.#runtime.onError(error)
		}
	}

	async #maybeReview(
		signal?: AbortSignal,
	): Promise<TextActivationResult | undefined> {
		const active = await this.#coordinator.activeProfile()
		if (active.configuration.selection.mode !== 'periodic') return undefined
		const selection = this.#runtime.selection
		if (selection === undefined)
			throw new Error(
				'periodic adaptive text selection requires a selection runtime',
			)
		const histories = await this.#store.learningHistory.list()
		const attempts = await this.#store.learningAttempts.list()
		const currentState = await this.#coordinator.snapshot()
		const previous = asMetadata(
			await this.#store.state.get(this.#runtime.policy.selectionStateId),
		)
		const committedSinceReview =
			attempts.length - (previous?.committedRuns ?? 0)
		const elapsedBase = previous?.reviewedAt ?? active.createdAt
		const elapsed =
			Date.parse(this.#runtime.clock.now()) - Date.parse(elapsedBase)
		if (
			committedSinceReview < active.configuration.selection.minCommittedRuns ||
			elapsed < active.configuration.selection.minElapsedMs
		)
			return undefined
		return this.#coordinator.review(async (state, activate) => {
			const current = await this.#coordinator.activeProfile()
			const eligible = selection.catalogue.filter((entry) =>
				this.#eligible(entry, current),
			)
			if (eligible.length === 0) {
				await this.#recordSelection(
					current,
					attempts.length,
					currentState.learnedStateRevision,
					'failure',
					'no explicitly evaluated automatic procedure is eligible',
				)
				return undefined
			}
			const memory = await this.#store.understanding.get(
				this.#runtime.policy.narrativeMemoryId,
			)
			const changes = (await this.#store.memoryChanges.list())
				.filter(
					(entry) => entry.summary !== undefined && entry.summary.length > 0,
				)
				.slice(-selection.limits.maxLearnedChanges)
				.map((entry) => entry.summary as string)
			const pending = (await this.#store.pendingWork.list())
				.flatMap((work) =>
					(work.inputs ?? []).map((entry) => ({
						entry,
						createdAt: work.created_at,
					})),
				)
				.slice(0, selection.limits.maxPendingInputs)
				.map(({ entry, createdAt }) => ({
					deliveryId: entry.id,
					text: entry.text,
					observedAt: entry.observed_at ?? createdAt,
					...(entry.event_id ? { eventId: entry.event_id } : {}),
					...(entry.urgency ? { urgency: entry.urgency } : {}),
				}))
			const feedback = (await selection.feedback()).slice(
				0,
				selection.limits.maxFeedbackEntries,
			)
			const allowed = eligible.slice(
				0,
				active.configuration.selection.maxCatalogueEntries,
			)
			const selectorModel = model(this.#runtime, current.configuration.model)
			const reviewedAt = this.#runtime.clock.now()
			const context = {
				currentNarrative: typeof memory?.data === 'string' ? memory.data : '',
				changes,
				pending,
				feedback,
			}
			let outcome: SelectionOutcome
			try {
				outcome = await selectTextProcedure(
					{
						review: {
							id: this.#runtime.stateIds.next('activation'),
							trigger: 'periodic',
							contextDigest: digest(context),
							evidenceRefs: histories
								.slice(-selection.limits.maxLearnedChanges)
								.map(({ id }) => id),
						},
						lens: current.configuration.lens,
						state,
						currentNarrative: context.currentNarrative,
						learnedChanges: changes,
						pending,
						feedback,
						metrics: {
							committedRuns: attempts.length,
							deferredRuns: (await this.#store.pendingWork.list()).filter(
								({ retry_count }) => retry_count > 0,
							).length,
							failedRuns: (await this.#store.processedInputs.list()).filter(
								({ outcome: value }) => value === 'terminal-failure',
							).length,
							meanBatchItems:
								histories.length === 0
									? 0
									: histories.reduce(
											(total, entry) => total + entry.input_ids.length,
											0,
										) / histories.length,
							...(previous ? { elapsedSinceSelectionMs: elapsed } : {}),
						},
						allowed: allowed.map(({ token, expectedEffect, profile }) => ({
							token,
							expectedEffect,
							procedure: profile.configuration.activeProcedure,
						})),
						limits: {
							loadedContextTokens:
								current.configuration.generation.loadedContextTokens,
							reservedOutputTokens:
								current.configuration.generation.reservedOutputTokens,
							maxContextCharacters: selection.limits.maxContextCharacters,
							maxCatalogueEntries:
								current.configuration.selection.maxCatalogueEntries,
						},
						signal: signal ?? new AbortController().signal,
					},
					selectorModel,
				)
			} catch {
				await this.#writeSelection({
					kind: 'adaptive-text-selection',
					mode: current.configuration.selection.mode,
					reviewedAt,
					committedRuns: attempts.length,
					learnedStateRevision: currentState.learnedStateRevision,
					outcome: 'failure',
					procedure: current.configuration.activeProcedure,
					profile: current.ref,
					reason: 'selector operation failed',
				})
				return undefined
			}
			if (outcome.status !== 'candidate') {
				await this.#writeSelection({
					kind: 'adaptive-text-selection',
					mode: current.configuration.selection.mode,
					reviewedAt,
					committedRuns: attempts.length,
					learnedStateRevision: currentState.learnedStateRevision,
					outcome: outcome.status,
					procedure: current.configuration.activeProcedure,
					profile: current.ref,
					reason: 'reason' in outcome ? outcome.reason : outcome.code,
				})
				return undefined
			}
			const selectedProfiles = allowed.filter(
				(entry) =>
					sameRef(
						entry.profile.configuration.activeProcedure,
						outcome.procedure,
					) && entry.expectedEffect === outcome.expectedEffectHypothesis,
			)
			if (selectedProfiles.length !== 1) {
				await this.#recordSelection(
					current,
					attempts.length,
					currentState.learnedStateRevision,
					'failure',
					'selector candidate does not identify exactly one evaluated profile',
				)
				return undefined
			}
			const selected = selectedProfiles[0]
			if (selected === undefined) return undefined
			if (!current.configuration.selection.autoActivatePreEvaluated) {
				await this.#recordSelection(
					current,
					attempts.length,
					currentState.learnedStateRevision,
					'candidate',
					outcome.expectedEffectHypothesis,
				)
				return undefined
			}
			let activation: TextActivationResult
			try {
				activation = await activate(selected.profile)
			} catch {
				await this.#recordSelection(
					current,
					attempts.length,
					currentState.learnedStateRevision,
					'failure',
					'selected profile activation failed',
				)
				return undefined
			}
			await this.#writeSelection({
				kind: 'adaptive-text-selection',
				mode: current.configuration.selection.mode,
				reviewedAt,
				committedRuns: attempts.length,
				learnedStateRevision: currentState.learnedStateRevision,
				outcome: activation.status === 'activated' ? 'activated' : 'failure',
				procedure: selected.profile.configuration.activeProcedure,
				profile: selected.profile.ref,
				reason: activation.status,
			})
			return activation
		})
	}

	#eligible(
		entry: AdaptiveTextSelectionCatalogueEntry,
		current: TextProfileSnapshot<TextLearningConfig>,
	): boolean {
		return (
			entry.token.length > 0 &&
			entry.expectedEffect.length > 0 &&
			entry.evaluation.evidenceRefs.length > 0 &&
			entry.evaluation.evidenceRefs.every(
				(reference) => reference.length > 0,
			) &&
			sameRef(entry.evaluation.model, entry.profile.configuration.model) &&
			sameRef(
				entry.profile.configuration.model,
				entry.profile.bindings.model,
			) &&
			this.#runtime.models.some(({ ref }) =>
				sameRef(ref, entry.profile.configuration.model),
			) &&
			sameRef(entry.evaluation.profile, entry.profile.ref) &&
			sameRef(
				entry.profile.configuration.activeProcedure,
				entry.profile.bindings.procedure,
			) &&
			entry.profile.bindings.neuron.id === current.bindings.neuron.id &&
			entry.profile.bindings.neuron.incarnation ===
				current.bindings.neuron.incarnation &&
			entry.profile.bindings.neuron.ownership_revision ===
				current.bindings.neuron.ownership_revision &&
			sameLens(entry.profile.configuration.lens, current.configuration.lens) &&
			current.configuration.allowedProcedures.some((procedure) =>
				sameRef(procedure, entry.profile.configuration.activeProcedure),
			)
		)
	}

	async #recordSelection(
		profile: TextProfileSnapshot<TextLearningConfig>,
		committedRuns: number,
		learnedStateRevision: number,
		outcome: SelectionMetadata['outcome'],
		reason: string,
	): Promise<void> {
		await this.#writeSelection({
			kind: 'adaptive-text-selection',
			mode: profile.configuration.selection.mode,
			reviewedAt: this.#runtime.clock.now(),
			committedRuns,
			learnedStateRevision,
			outcome,
			procedure: profile.configuration.activeProcedure,
			profile: profile.ref,
			reason,
		})
	}

	async #writeSelection(value: SelectionMetadata): Promise<void> {
		const id = this.#runtime.policy.selectionStateId
		const existing = await this.#store.state.get(id)
		if (existing)
			await this.#store.state.update(id, {
				value,
				updated_at: value.reviewedAt,
			})
		else
			await this.#store.state.add({ id, value, updated_at: value.reviewedAt })
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
