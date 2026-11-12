import type {
	TextActivationResult,
	TextCoordinatorConfiguration,
	TextCoordinatorSnapshot,
	TextEnqueueResult,
	TextInput,
	TextProcedureDecision,
	TextProfileSnapshot,
	TextRunProcedure,
	TextRunResult,
	TextSelectionStatePin,
	TextStateClock,
	TextStatePolicy,
	TextStateScheduler,
} from './contracts'
import type { TextLearningStateStore } from './store'

export interface CreateLearningCoordinatorOptions<
	TConfiguration extends TextCoordinatorConfiguration,
> {
	readonly state: TextLearningStateStore<TConfiguration>
	readonly runProcedure: TextRunProcedure<TConfiguration>
	readonly clock: TextStateClock
	readonly scheduler: TextStateScheduler
	readonly policy: TextStatePolicy
	readonly onError: (error: unknown) => void
	readonly onSettled?: (
		result: Extract<TextRunResult, { readonly status: 'settled' }>,
	) => void | Promise<void>
}

export interface TextBatchEnqueueResult {
	readonly enqueued: readonly TextEnqueueResult[]
	readonly runs: readonly TextRunResult[]
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new Error('text learning cancelled')
}

export class LearningCoordinator<
	TConfiguration extends
		TextCoordinatorConfiguration = TextCoordinatorConfiguration,
> {
	private tail = Promise.resolve()
	private notificationTail = Promise.resolve()
	private timer: unknown
	private timerGeneration = 0
	private stopped = false

	constructor(
		private readonly options: CreateLearningCoordinatorOptions<TConfiguration>,
	) {}

	initialize(
		profile: TextProfileSnapshot<TConfiguration>,
	): Promise<'initialized' | 'restored'> {
		return this.options.state.initialize(profile)
	}

	activeProfile(): Promise<TextProfileSnapshot<TConfiguration>> {
		return this.options.state.activeProfile()
	}

	async learn(input: TextInput): Promise<TextEnqueueResult> {
		const result = await this.learnBatch([input])
		const first = result.enqueued[0]
		if (first === undefined)
			throw new Error('single input enqueue produced no result')
		return first
	}

	async learnBatch(
		inputs: readonly TextInput[],
	): Promise<TextBatchEnqueueResult> {
		this.requireActive()
		// Keep one public batch indivisible from timers and concurrent learners.
		// This can delay persistence behind an active attempt; until this promise
		// resolves the caller has no enqueue acknowledgement and may retry its stable IDs.
		const { enqueued, runs } = await this.serial(async () => {
			const batched: TextEnqueueResult[] = []
			for (const input of inputs)
				batched.push(await this.options.state.enqueue(input))
			return {
				enqueued: batched,
				runs: batched.some(({ status }) => status === 'queued')
					? await this.runAvailable(false, this.options.policy.maxFlushRuns)
					: [],
			}
		})
		await this.notifySettled(runs)
		await this.armTimer()
		return { enqueued, runs }
	}

	async flush(signal?: AbortSignal): Promise<readonly TextRunResult[]> {
		this.requireActive()
		if (signal?.aborted) throw abortError(signal)
		const results = await this.serial(() =>
			this.runAvailable(true, this.options.policy.maxFlushRuns, signal),
		)
		await this.notifySettled(results)
		await this.armTimer()
		return results
	}

	async resume(signal?: AbortSignal): Promise<readonly TextRunResult[]> {
		this.requireActive()
		if (signal?.aborted) throw abortError(signal)
		const results = await this.serial(async () => {
			const recovered: TextRunResult[] = []
			const candidate = await this.options.state.recoverCandidate()
			if (candidate)
				recovered.push(
					await this.settle(
						candidate.runId,
						candidate.candidateId,
						candidate.decision,
					),
				)
			else {
				const run = await this.options.state.recoverRun()
				if (run) recovered.push(await this.execute(run, signal))
			}
			return [
				...recovered,
				...(await this.runAvailable(
					false,
					this.options.policy.maxFlushRuns,
					signal,
				)),
			]
		})
		await this.notifySettled(results)
		await this.armTimer()
		return results
	}

	async activate(
		profile: TextProfileSnapshot<TConfiguration>,
		selectedFrom: TextSelectionStatePin,
	): Promise<TextActivationResult> {
		this.requireActive()
		const result = await this.serial(() =>
			this.options.state.activate(profile, selectedFrom),
		)
		await this.armTimer()
		return result
	}

	selectionState(): Promise<TextSelectionStatePin> {
		return this.options.state.selectionState()
	}

	snapshot(): Promise<TextCoordinatorSnapshot> {
		return this.options.state.snapshot()
	}

	async review<TResult>(
		operation: (
			state: TextSelectionStatePin,
			activate: (
				profile: TextProfileSnapshot<TConfiguration>,
			) => Promise<TextActivationResult>,
		) => Promise<TResult>,
	): Promise<TResult> {
		this.requireActive()
		return this.serial(async () => {
			const selection = await this.options.state.selectionState()
			return operation(selection, (profile) =>
				this.options.state.activate(profile, selection),
			)
		})
	}

	async dispose(): Promise<void> {
		this.stopped = true
		this.timerGeneration += 1
		if (this.timer !== undefined) this.options.scheduler.cancel(this.timer)
		this.timer = undefined
		await this.tail
		await this.notificationTail
		await this.tail
	}

	private async runAvailable(
		force: boolean,
		maxRuns: number,
		signal?: AbortSignal,
	): Promise<TextRunResult[]> {
		const results: TextRunResult[] = []
		for (let index = 0; index < maxRuns; index += 1) {
			if (signal?.aborted) throw abortError(signal)
			const begun = await this.options.state.beginRun(force)
			if (begun.status === 'idle') break
			if (begun.status === 'memory-capacity') {
				results.push({
					status: 'memory-capacity',
					reason: begun.reason ?? 'request capacity prevents a complete input',
				})
				break
			}
			if (!begun.snapshot) throw new Error('started text run has no snapshot')
			results.push(await this.execute(begun.snapshot, signal))
		}
		return results
	}

	private async execute(
		snapshot: Omit<Parameters<TextRunProcedure<TConfiguration>>[0], 'signal'>,
		signal?: AbortSignal,
	): Promise<TextRunResult> {
		const controller = new AbortController()
		const abort = () => controller.abort(signal?.reason)
		if (signal?.aborted) abort()
		else signal?.addEventListener('abort', abort, { once: true })
		let decision: TextProcedureDecision
		try {
			decision = await this.options.runProcedure({
				...snapshot,
				signal: controller.signal,
			})
		} catch (error) {
			decision = {
				status: 'failure',
				code: 'procedure-error',
				retryable: true,
				reason: error instanceof Error ? error.message : String(error),
			}
		} finally {
			signal?.removeEventListener('abort', abort)
		}
		if (
			decision.status === 'change' &&
			decision.narrative === snapshot.memory.text
		) {
			decision = {
				status: 'no_change',
				proposal: decision.proposal,
				completion: decision.completion,
				reason: decision.explanation,
			}
		}
		if (
			decision.status === 'change' &&
			decision.narrative.length > snapshot.configuration.memory.maxCharacters
		) {
			decision = {
				status: 'failure',
				code: 'capacity_exceeded',
				retryable: false,
				reason: 'candidate narrative exceeds configured memory capacity',
				proposal: decision.proposal,
			}
		}
		if (
			decision.status === 'clear' &&
			!snapshot.configuration.memory.allowExplicitClear
		) {
			decision = {
				status: 'failure',
				code: 'clear_not_allowed',
				retryable: false,
				reason: 'active profile does not allow explicit clear',
				proposal: decision.proposal,
			}
		}
		const candidateId = await this.options.state.persistCandidate(
			snapshot.runId,
			decision,
		)
		return this.settle(snapshot.runId, candidateId, decision)
	}

	private async settle(
		runId: string,
		candidateId: string,
		decision: TextProcedureDecision,
	): Promise<TextRunResult> {
		if (decision.status === 'defer') {
			const result = await this.options.state.defer(
				runId,
				candidateId,
				decision.reason,
			)
			return result.terminal
				? { status: 'terminal-failure', runId, code: 'retry_exhausted' }
				: { status: 'deferred', runId, retryAt: result.retryAt as string }
		}
		if (decision.status === 'failure') {
			const result = await this.options.state.defer(
				runId,
				candidateId,
				decision.reason,
				!decision.retryable,
			)
			return result.terminal
				? { status: 'terminal-failure', runId, code: decision.code }
				: { status: 'deferred', runId, retryAt: result.retryAt as string }
		}
		const commit = await this.options.state.commitCandidate(candidateId)
		if (commit.status === 'conflict') {
			const replacementAttemptId = await this.options.state.supersede(
				runId,
				commit.reason,
			)
			return { status: 'superseded', runId, replacementAttemptId }
		}
		if (commit.status === 'failure') {
			const deferred = await this.options.state.defer(
				runId,
				candidateId,
				commit.error,
			)
			return deferred.terminal
				? { status: 'terminal-failure', runId, code: 'commit_failure' }
				: { status: 'deferred', runId, retryAt: deferred.retryAt as string }
		}
		return { status: 'settled', runId, commit }
	}

	private async armTimer(): Promise<void> {
		const generation = ++this.timerGeneration
		if (this.stopped) return
		if (this.timer !== undefined) this.options.scheduler.cancel(this.timer)
		this.timer = undefined
		const dueAt = await this.options.state.earliestDueAt()
		if (this.stopped || generation !== this.timerGeneration || !dueAt) return
		const handle = this.options.scheduler.schedule(dueAt, () => {
			if (this.stopped || generation !== this.timerGeneration) return
			this.timerGeneration += 1
			this.timer = undefined
			void this.resume().catch(this.options.onError)
		})
		if (this.stopped || generation !== this.timerGeneration) {
			this.options.scheduler.cancel(handle)
			return
		}
		this.timer = handle
	}

	private async notifySettled(
		results: readonly TextRunResult[],
	): Promise<void> {
		if (this.options.onSettled === undefined) return
		const notify = async () => {
			for (const result of results) {
				if (result.status === 'settled') await this.options.onSettled?.(result)
			}
		}
		const task = this.notificationTail.then(notify, notify)
		this.notificationTail = task.then(
			() => undefined,
			() => undefined,
		)
		await task
	}

	private serial<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		const result = this.tail.then(operation, operation)
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private requireActive(): void {
		if (this.stopped) throw new Error('text learning coordinator is disposed')
	}
}
