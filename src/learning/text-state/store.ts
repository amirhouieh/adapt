import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
	LearningCommitInput,
	LearningCommitResult,
	LearningRevisionRecord,
	LearningVersionBindings,
	NeuronStore,
	PendingWorkRecord,
	StateRecord,
} from '../../stores/types'
import type {
	TextActivationResult,
	TextCoordinatorConfiguration,
	TextCoordinatorSnapshot,
	TextEnqueueResult,
	TextInput,
	TextProcedureDecision,
	TextProcedureStateSnapshot,
	TextProfileSnapshot,
	TextSelectionStatePin,
	TextStateClock,
	TextStateIds,
	TextStatePolicy,
} from './contracts'

type StateValue<TConfiguration extends TextCoordinatorConfiguration> =
	| {
			kind: string
			record: 'head'
			profileStateId: string
			profile: TextProfileSnapshot<TConfiguration>
	  }
	| {
			kind: string
			record: 'profile'
			profile: TextProfileSnapshot<TConfiguration>
	  }
	| RunState
	| CandidateState
	| {
			kind: string
			record: 'capacity'
			workId: string
			memoryRevision: number
			configurationRevision: number
			reason: string
			createdAt: string
	  }
	| {
			kind: string
			record: 'supersede'
			oldAttemptId: string
			replacementAttemptId: string
			reason: string
			createdAt: string
	  }
	| {
			kind: string
			record: 'activation'
			previousProfile: { id: string; version: string }
			profile: { id: string; version: string }
			createdAt: string
	  }
	| {
			kind: string
			record: 'terminal-failure'
			attemptId: string
			inputIds: string[]
			code: string
			createdAt: string
	  }

interface RunState {
	kind: string
	record: 'run'
	status: 'running' | 'candidate'
	runId: string
	pendingWorkId: string
	attemptId: string
	inputIds: string[]
	bindings: LearningVersionBindings
	memoryRevision: number
	configurationRevision: number
	learnedStateRevision: number
	createdAt: string
}

interface CandidateState {
	kind: string
	record: 'candidate'
	candidateId: string
	runId: string
	decision: TextProcedureDecision
	createdAt: string
}

interface BeginRunResult<TConfiguration extends TextCoordinatorConfiguration> {
	readonly status: 'started' | 'idle' | 'memory-capacity'
	readonly snapshot?: Omit<TextProcedureStateSnapshot<TConfiguration>, 'signal'>
	readonly nextDueAt?: string
	readonly reason?: string
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value === null || typeof value !== 'object') return value
	const result = Object.create(null) as Record<string, unknown>
	for (const key of Object.keys(value).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const entry = (value as Record<string, unknown>)[key]
		if (entry !== undefined) result[key] = canonical(entry)
	}
	return result
}

function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value)
	return (
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === value
	)
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
	return new Date(Date.parse(timestamp) + milliseconds).toISOString()
}

function requirePositive(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${name} must be a positive safe integer`)
}

function requireNonnegative(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a nonnegative safe integer`)
}

function stateValue<TConfiguration extends TextCoordinatorConfiguration>(
	record: StateRecord | undefined,
	policy: TextStatePolicy,
): StateValue<TConfiguration> | undefined {
	if (!record || typeof record.value !== 'object' || record.value === null)
		return undefined
	const value = record.value as { kind?: unknown; record?: unknown }
	if (value.kind !== policy.stateKind || typeof value.record !== 'string')
		return undefined
	return record.value as StateValue<TConfiguration>
}

function revisionOrInitial(
	record: LearningRevisionRecord | undefined,
): Required<
	Pick<
		LearningRevisionRecord,
		'memory_revision' | 'config_revision' | 'learned_state_revision'
	>
> &
	LearningRevisionRecord {
	const memoryRevision = record?.memory_revision ?? 0
	return {
		id: 'current',
		memory_revision: memoryRevision,
		config_revision: record?.config_revision ?? 0,
		learned_state_revision: record?.learned_state_revision ?? memoryRevision,
		...(record?.active_bindings
			? { active_bindings: record.active_bindings }
			: {}),
		...(record?.updated_at ? { updated_at: record.updated_at } : {}),
	}
}

function inputDigest(input: TextInput): string {
	return digest({
		deliveryId: input.deliveryId,
		eventId: input.eventId,
		text: input.text,
		observedAt: input.observedAt,
		urgency: input.urgency,
	})
}

function selectionPin(
	bindings: LearningVersionBindings,
	learnedStateRevision: number,
): TextSelectionStatePin {
	return {
		neuron: {
			id: bindings.neuron.id,
			incarnation: bindings.neuron.incarnation,
			ownershipRevision: bindings.neuron.ownership_revision,
		},
		learnedStateRevision,
		procedure: bindings.procedure,
		profile: bindings.profile,
		profileRevision: bindings.profile_revision,
		model: bindings.model,
		allowedCatalogueDigest: bindings.allowed_catalogue_digest,
		referencedDefinitionDigest: bindings.referenced_definition_digest,
	}
}

export interface CreateTextStateStoreOptions {
	readonly store: NeuronStore
	readonly ids: TextStateIds
	readonly clock: TextStateClock
	readonly policy: TextStatePolicy
	readonly countInputTokens: (inputs: readonly TextInput[]) => number
	readonly fitsRequest: (input: {
		readonly configuration: TextCoordinatorConfiguration
		readonly memory: { readonly text: string; readonly revision: number }
		readonly inputs: readonly TextInput[]
	}) =>
		| { readonly status: 'fits' }
		| {
				readonly status: 'input-too-large'
				readonly deliveryId: string
				readonly reason: string
		  }
		| { readonly status: 'memory-capacity'; readonly reason: string }
}

export class TextLearningStateStore<
	TConfiguration extends
		TextCoordinatorConfiguration = TextCoordinatorConfiguration,
> {
	constructor(private readonly options: CreateTextStateStoreOptions) {
		if (
			!options.policy.headStateId ||
			!options.policy.narrativeMemoryId ||
			!options.policy.stateKind
		)
			throw new Error('text state ids and kind are required')
		requirePositive(options.policy.maxRetainedProfiles, 'maxRetainedProfiles')
		requirePositive(options.policy.maxFlushRuns, 'maxFlushRuns')
	}

	async initialize(
		profile: TextProfileSnapshot<TConfiguration>,
	): Promise<'initialized' | 'restored'> {
		this.validateProfile(profile)
		const now = this.options.clock.now()
		return this.options.store.runAtomic((store) => {
			const existingHead = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			if (existingHead) {
				if (existingHead.record !== 'head')
					throw new Error('configured text head id is occupied')
				if (!isDeepStrictEqual(existingHead.profile, profile))
					throw new Error(
						'durable text profile does not match supplied initialization',
					)
				return 'restored'
			}
			const profileStateId = this.options.ids.next('profile')
			store.state.add({
				id: profileStateId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'profile',
					profile,
				},
				updated_at: now,
			})
			store.state.add({
				id: this.options.policy.headStateId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'head',
					profileStateId,
					profile,
				},
				updated_at: now,
			})
			const current = revisionOrInitial(store.learningRevisions.get('current'))
			const next: LearningRevisionRecord = {
				...current,
				active_bindings: profile.bindings,
				updated_at: now,
			}
			if (store.learningRevisions.get('current')) {
				const { id: _id, ...changes } = next
				store.learningRevisions.update('current', changes)
			} else store.learningRevisions.add(next)
			return 'initialized'
		})
	}

	async activeProfile(): Promise<TextProfileSnapshot<TConfiguration>> {
		return this.options.store.runAtomic((store) => {
			const head = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			if (!head || head.record !== 'head')
				throw new Error('text learning profile is not initialized')
			return head.profile
		})
	}

	async enqueue(input: TextInput): Promise<TextEnqueueResult> {
		if (
			!input.deliveryId ||
			typeof input.text !== 'string' ||
			!validTimestamp(input.observedAt)
		)
			throw new Error(
				'delivery id, text, and normalized observedAt are required',
			)
		const profile = await this.activeProfile()
		if (input.text.length > profile.configuration.input.maxItemCharacters)
			return { status: 'input_too_large' }
		const now = this.options.clock.now()
		const dueAt = addMilliseconds(
			now,
			profile.configuration.batching.maxDelayMs,
		)
		const identityDigest = inputDigest(input)
		return this.options.store.runAtomic((store) => {
			const processedByAge = store.processedInputs
				.list()
				.sort(
					(left, right) =>
						right.processed_at.localeCompare(left.processed_at) ||
						right.id.localeCompare(left.id),
				)
			for (const [index, record] of processedByAge.entries()) {
				if (
					index >= profile.configuration.idempotence.maxProcessedIds ||
					(record.expires_at !== undefined && record.expires_at <= now)
				)
					store.processedInputs.delete(record.id)
			}
			const pending = store.pendingInputs.get(input.deliveryId)
			if (pending)
				return pending.identity_digest === identityDigest
					? { status: 'deduplicated', coverage: 'pending' }
					: { status: 'conflict', reason: 'delivery-id-reused' }
			const processed = store.processedInputs.get(input.deliveryId)
			if (processed)
				return processed.identity_digest === identityDigest
					? { status: 'deduplicated', coverage: 'processed' }
					: { status: 'conflict', reason: 'delivery-id-reused' }
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			if (!isDeepStrictEqual(revision.active_bindings, profile.bindings))
				throw new Error('active profile changed while enqueueing')
			const runningWorkIds = new Set(
				store.state.list().flatMap((record) => {
					const value = stateValue<TConfiguration>(record, this.options.policy)
					return value?.record === 'run' ? [value.pendingWorkId] : []
				}),
			)
			const bucket = store.pendingWork
				.list()
				.filter(
					(work) =>
						work.status === 'pending' &&
						!runningWorkIds.has(work.id) &&
						isDeepStrictEqual(work.bindings, profile.bindings),
				)
				.sort(
					(left, right) =>
						left.created_at.localeCompare(right.created_at) ||
						left.id.localeCompare(right.id),
				)[0]
			const storedInput = {
				id: input.deliveryId,
				text: input.text,
				...(input.eventId ? { event_id: input.eventId } : {}),
				observed_at: input.observedAt,
				...(input.urgency ? { urgency: input.urgency } : {}),
				identity_digest: identityDigest,
			}
			let workId: string
			let attemptId: string
			if (bucket) {
				workId = bucket.id
				attemptId = bucket.attempt_id
				store.pendingWork.update(bucket.id, {
					input_ids: [...bucket.input_ids, input.deliveryId],
					inputs: [...(bucket.inputs ?? []), storedInput],
					available_at:
						bucket.available_at <= dueAt ? bucket.available_at : dueAt,
					updated_at: now,
				})
			} else {
				workId = this.options.ids.next('work')
				attemptId = this.options.ids.next('attempt')
				store.pendingWork.add({
					id: workId,
					attempt_id: attemptId,
					input_ids: [input.deliveryId],
					inputs: [storedInput],
					bindings: profile.bindings,
					status: 'pending',
					retry_count: 0,
					available_at: dueAt,
					created_at: now,
					updated_at: now,
				})
			}
			store.pendingInputs.add({
				id: input.deliveryId,
				pending_work_id: workId,
				attempt_id: attemptId,
				created_at: now,
				identity_digest: identityDigest,
			})
			return { status: 'queued', dueAt }
		})
	}

	async beginRun(force: boolean): Promise<BeginRunResult<TConfiguration>> {
		const now = this.options.clock.now()
		const runId = this.options.ids.next('run')
		const capacityId = this.options.ids.next('supersede')
		return this.options.store.runAtomic((store) => {
			const existing = store.state.list().some((record) => {
				const value = stateValue<TConfiguration>(record, this.options.policy)
				return value?.record === 'run'
			})
			if (existing) return { status: 'idle' }
			const head = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			if (!head || head.record !== 'head')
				throw new Error('text learning profile is not initialized')
			const config = head.profile.configuration
			const work = store.pendingWork
				.list()
				.filter(
					(entry) =>
						entry.status === 'pending' &&
						entry.inputs &&
						entry.inputs.length > 0,
				)
				.sort(
					(left, right) =>
						left.available_at.localeCompare(right.available_at) ||
						left.created_at.localeCompare(right.created_at) ||
						left.id.localeCompare(right.id),
				)[0]
			if (!work?.inputs) return { status: 'idle' }
			const currentRevision = revisionOrInitial(
				store.learningRevisions.get('current'),
			)
			const blocked = store.state
				.list()
				.map((record) =>
					stateValue<TConfiguration>(record, this.options.policy),
				)
				.find(
					(value) => value?.record === 'capacity' && value.workId === work.id,
				)
			if (blocked?.record === 'capacity') {
				if (
					blocked.memoryRevision === currentRevision.memory_revision &&
					blocked.configurationRevision === currentRevision.config_revision
				) {
					return force
						? { status: 'memory-capacity', reason: blocked.reason }
						: { status: 'idle' }
				}
				for (const record of store.state.list()) {
					const value = stateValue<TConfiguration>(record, this.options.policy)
					if (value?.record === 'capacity' && value.workId === work.id)
						store.state.delete(record.id)
				}
			}
			const allInputs = work.inputs.map(
				(entry): TextInput => ({
					deliveryId: entry.id,
					text: entry.text,
					observedAt: entry.observed_at ?? work.created_at,
					...(entry.event_id ? { eventId: entry.event_id } : {}),
					...(entry.urgency ? { urgency: entry.urgency } : {}),
				}),
			)
			const characters = allInputs.reduce(
				(total, entry) => total + entry.text.length,
				0,
			)
			const urgent =
				config.batching.acceptCallerUrgency &&
				allInputs.some((entry) => entry.urgency === 'urgent')
			const retryBackoffActive = work.retry_count > 0 && work.available_at > now
			const ready =
				!retryBackoffActive &&
				(force ||
					work.available_at <= now ||
					allInputs.length >= config.batching.maxItems ||
					characters >= config.batching.maxInputCharacters ||
					this.options.countInputTokens(allInputs) >=
						config.batching.maxInputTokens ||
					urgent)
			if (!ready) return { status: 'idle', nextDueAt: work.available_at }
			const revision = currentRevision
			const memory = store.understanding.get(
				this.options.policy.narrativeMemoryId,
			)
			const memorySnapshot = {
				text: typeof memory?.data === 'string' ? memory.data : '',
				revision: revision.memory_revision,
			}
			const selected: TextInput[] = []
			let selectedCharacters = 0
			for (const entry of allInputs) {
				if (selected.length >= config.batching.maxItems) break
				if (
					selectedCharacters + entry.text.length >
					config.batching.maxInputCharacters
				)
					break
				const next = [...selected, entry]
				if (
					this.options.countInputTokens(next) > config.batching.maxInputTokens
				)
					break
				const fit = this.options.fitsRequest({
					configuration: config,
					memory: memorySnapshot,
					inputs: next,
				})
				if (fit.status !== 'fits') {
					if (selected.length === 0) {
						store.state.add({
							id: capacityId,
							value: {
								kind: this.options.policy.stateKind,
								record: 'capacity',
								workId: work.id,
								memoryRevision: revision.memory_revision,
								configurationRevision: revision.config_revision,
								reason: fit.reason,
								createdAt: now,
							},
							updated_at: now,
						})
						return { status: 'memory-capacity', reason: fit.reason }
					}
					break
				}
				selected.push(entry)
				selectedCharacters += entry.text.length
			}
			if (selected.length === 0) {
				const reason = 'no complete input fits the configured request budget'
				store.state.add({
					id: capacityId,
					value: {
						kind: this.options.policy.stateKind,
						record: 'capacity',
						workId: work.id,
						memoryRevision: revision.memory_revision,
						configurationRevision: revision.config_revision,
						reason,
						createdAt: now,
					},
					updated_at: now,
				})
				return { status: 'memory-capacity', reason }
			}
			if (
				!work.bindings ||
				!isDeepStrictEqual(work.bindings, revision.active_bindings)
			)
				return { status: 'idle' }
			const run: RunState = {
				kind: this.options.policy.stateKind,
				record: 'run',
				status: 'running',
				runId,
				pendingWorkId: work.id,
				attemptId: work.attempt_id,
				inputIds: selected.map((entry) => entry.deliveryId),
				bindings: work.bindings,
				memoryRevision: revision.memory_revision,
				configurationRevision: revision.config_revision,
				learnedStateRevision: revision.learned_state_revision,
				createdAt: now,
			}
			store.state.add({ id: runId, value: run, updated_at: now })
			return {
				status: 'started',
				snapshot: {
					runId,
					pins: {
						execution: {
							memory: revision.memory_revision,
							configuration: revision.config_revision,
							registry: work.bindings.registry_lineage,
						},
						neuron: {
							id: work.bindings.neuron.id,
							incarnation: work.bindings.neuron.incarnation,
							ownershipRevision: work.bindings.neuron.ownership_revision,
						},
						procedure: work.bindings.procedure,
						profile: work.bindings.profile,
						model: work.bindings.model,
						learnedStateRevision: revision.learned_state_revision,
					},
					configuration: head.profile.configuration,
					memory: memorySnapshot,
					inputs: selected,
				},
			}
		})
	}

	async recoverRun(): Promise<
		Omit<TextProcedureStateSnapshot<TConfiguration>, 'signal'> | undefined
	> {
		return this.options.store.runAtomic((store) => {
			const run = store.state
				.list()
				.map((record) =>
					stateValue<TConfiguration>(record, this.options.policy),
				)
				.find(
					(value): value is RunState =>
						value?.record === 'run' && value.status === 'running',
				)
			if (!run) return undefined
			return this.snapshotForRun(store, run)
		})
	}

	async persistCandidate(
		runId: string,
		decision: TextProcedureDecision,
	): Promise<string> {
		const now = this.options.clock.now()
		const candidateId = this.options.ids.next('candidate')
		await this.options.store.runAtomic((store) => {
			const run = stateValue<TConfiguration>(
				store.state.get(runId),
				this.options.policy,
			)
			if (!run || run.record !== 'run' || run.status !== 'running')
				throw new Error('run is not active')
			store.state.add({
				id: candidateId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'candidate',
					candidateId,
					runId,
					decision,
					createdAt: now,
				},
				updated_at: now,
			})
			store.state.update(runId, {
				value: { ...run, status: 'candidate' },
				updated_at: now,
			})
		})
		return candidateId
	}

	async recoverCandidate(): Promise<
		| { runId: string; candidateId: string; decision: TextProcedureDecision }
		| undefined
	> {
		return this.options.store.runAtomic((store) => {
			const candidate = store.state
				.list()
				.map((record) =>
					stateValue<TConfiguration>(record, this.options.policy),
				)
				.find((value): value is CandidateState => value?.record === 'candidate')
			return candidate
				? {
						runId: candidate.runId,
						candidateId: candidate.candidateId,
						decision: candidate.decision,
					}
				: undefined
		})
	}

	async commitCandidate(candidateId: string): Promise<LearningCommitResult> {
		const prepared = await this.options.store.runAtomic((store) => {
			const candidate = stateValue<TConfiguration>(
				store.state.get(candidateId),
				this.options.policy,
			)
			if (!candidate || candidate.record !== 'candidate')
				throw new Error('candidate is missing')
			const run = stateValue<TConfiguration>(
				store.state.get(candidate.runId),
				this.options.policy,
			)
			if (!run || run.record !== 'run' || run.status !== 'candidate')
				throw new Error('candidate run is missing')
			const work = store.pendingWork.get(run.pendingWorkId)
			if (!work) throw new Error('candidate work is missing')
			return { candidate, run, work }
		})
		const now = this.options.clock.now()
		const decision = prepared.candidate.decision
		if (decision.status === 'defer' || decision.status === 'failure')
			throw new Error('nonterminal candidate cannot be committed')
		const isChange = decision.status === 'change' || decision.status === 'clear'
		const narrative = decision.status === 'change' ? decision.narrative : ''
		const nextMemoryRevision = prepared.run.memoryRevision + (isChange ? 1 : 0)
		const historyId = this.options.ids.next('history')
		const changeId = isChange ? this.options.ids.next('change') : undefined
		const remainingIds = prepared.work.input_ids.filter(
			(id) => !prepared.run.inputIds.includes(id),
		)
		const remainingWork =
			remainingIds.length > 0
				? {
						id: this.options.ids.next('work'),
						attempt_id: this.options.ids.next('attempt'),
						input_ids: remainingIds,
						bindings: prepared.run.bindings,
						status: 'pending' as const,
						retry_count: prepared.work.retry_count,
						available_at: prepared.work.available_at,
						created_at: prepared.work.created_at,
						updated_at: now,
					}
				: undefined
		const profile = await this.activeProfile()
		const input: LearningCommitInput = {
			logical_attempt_id: prepared.run.attemptId,
			pending_work_id: prepared.run.pendingWorkId,
			expected_memory_revision: prepared.run.memoryRevision,
			expected_config_revision: prepared.run.configurationRevision,
			expected_learned_state_revision: prepared.run.learnedStateRevision,
			bindings: prepared.run.bindings,
			input_ids: prepared.run.inputIds,
			...(remainingWork ? { remaining_work: remainingWork } : {}),
			outcome: isChange ? 'change' : 'no-change',
			...(isChange
				? {
						patch: {
							type: 'replace' as const,
							records: [
								{
									id: this.options.policy.narrativeMemoryId,
									data: narrative,
									metadata_confidence: null,
									metadata_confidence_provenance: 'unknown' as const,
									metadata_created_at: now,
									metadata_updated_at: now,
								},
							],
						},
					}
				: {}),
			history: {
				id: historyId,
				attempt_id: prepared.run.attemptId,
				outcome: isChange ? 'change' : 'no-change',
				previous_memory_revision: prepared.run.memoryRevision,
				memory_revision: nextMemoryRevision,
				config_revision: prepared.run.configurationRevision,
				input_ids: prepared.run.inputIds,
				change_ids: changeId ? [changeId] : [],
				...('explanation' in decision && decision.explanation
					? { explanation: decision.explanation }
					: {}),
				created_at: now,
				bindings: prepared.run.bindings,
			},
			changes: changeId
				? [
						{
							id: changeId,
							attempt_id: prepared.run.attemptId,
							memory_revision: nextMemoryRevision,
							kind:
								decision.status === 'clear'
									? 'narrative-clear'
									: 'narrative-revision',
							affected_memory_ids: [this.options.policy.narrativeMemoryId],
							...('explanation' in decision && decision.explanation
								? { summary: decision.explanation }
								: {}),
							created_at: now,
						},
					]
				: [],
			outbox: [],
			committed_at: now,
			transient_state_ids: [prepared.run.runId, prepared.candidate.candidateId],
			retention: {
				max_history_entries: profile.configuration.history.maxEntries,
				max_history_characters: profile.configuration.history.maxCharacters,
				processed_expires_at: addMilliseconds(
					now,
					profile.configuration.idempotence.processedIdHorizonMs,
				),
				max_processed_ids: profile.configuration.idempotence.maxProcessedIds,
			},
		}
		return this.options.store.learning.commit(input)
	}

	async defer(
		runId: string,
		candidateId: string | undefined,
		reason: string,
		terminalOverride = false,
	): Promise<{ retryAt?: string; terminal: boolean }> {
		const now = this.options.clock.now()
		return this.options.store.runAtomic((store) => {
			const run = stateValue<TConfiguration>(
				store.state.get(runId),
				this.options.policy,
			)
			if (!run || run.record !== 'run') throw new Error('run is missing')
			const work = store.pendingWork.get(run.pendingWorkId)
			if (!work) throw new Error('run work is missing')
			const head = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			if (!head || head.record !== 'head')
				throw new Error('text learning profile is missing')
			const retries = head.profile.configuration.retries
			const age = Date.parse(now) - Date.parse(work.created_at)
			const nextCount = work.retry_count + 1
			const terminal =
				terminalOverride ||
				nextCount >= retries.maxLogicalAttempts ||
				age >= retries.terminalAfterMs
			store.state.delete(runId)
			if (candidateId && store.state.get(candidateId))
				store.state.delete(candidateId)
			if (terminal) {
				this.disposeFailedWork(
					store,
					work,
					reason,
					now,
					head.profile.configuration.idempotence.processedIdHorizonMs,
					head.profile.configuration.idempotence.maxProcessedIds,
				)
				return { terminal: true }
			}
			const exponent = Math.max(0, nextCount - 1)
			const delay = Math.min(
				retries.maxDelayMs,
				retries.initialDelayMs * 2 ** exponent,
			)
			const retryAt = addMilliseconds(now, delay)
			store.pendingWork.update(work.id, {
				retry_count: nextCount,
				available_at: retryAt,
				last_error: reason,
				updated_at: now,
			})
			return { retryAt, terminal: false }
		})
	}

	async supersede(runId: string, reason: string): Promise<string> {
		const now = this.options.clock.now()
		const replacementWorkId = this.options.ids.next('work')
		const replacementAttemptId = this.options.ids.next('attempt')
		const supersedeId = this.options.ids.next('supersede')
		return this.options.store.runAtomic((store) => {
			const run = stateValue<TConfiguration>(
				store.state.get(runId),
				this.options.policy,
			)
			if (!run || run.record !== 'run') throw new Error('run is missing')
			const work = store.pendingWork.get(run.pendingWorkId)
			if (!work) throw new Error('run work is missing')
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			if (!revision.active_bindings)
				throw new Error('active bindings are missing')
			const replacement: PendingWorkRecord = {
				...work,
				id: replacementWorkId,
				attempt_id: replacementAttemptId,
				bindings: revision.active_bindings,
				updated_at: now,
			}
			store.pendingWork.add(replacement)
			for (const id of work.input_ids)
				store.pendingInputs.update(id, {
					pending_work_id: replacementWorkId,
					attempt_id: replacementAttemptId,
				})
			store.pendingWork.delete(work.id)
			store.state.delete(runId)
			for (const record of store.state.list()) {
				const value = stateValue<TConfiguration>(record, this.options.policy)
				if (value?.record === 'candidate' && value.runId === runId)
					store.state.delete(record.id)
			}
			store.state.add({
				id: supersedeId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'supersede',
					oldAttemptId: run.attemptId,
					replacementAttemptId,
					reason,
					createdAt: now,
				},
				updated_at: now,
			})
			return replacementAttemptId
		})
	}

	async activate(
		profile: TextProfileSnapshot<TConfiguration>,
		selectedFrom: TextSelectionStatePin,
	): Promise<TextActivationResult> {
		this.validateProfile(profile)
		const now = this.options.clock.now()
		const profileStateId = this.options.ids.next('profile')
		const activationId = this.options.ids.next('activation')
		return this.options.store.runAtomic((store) => {
			const activeRun = store.state
				.list()
				.some(
					(record) =>
						stateValue<TConfiguration>(record, this.options.policy)?.record ===
						'run',
				)
			if (activeRun) return { status: 'busy' }
			const head = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			if (!head || head.record !== 'head') return { status: 'conflict' }
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			if (
				!revision.active_bindings ||
				!isDeepStrictEqual(
					selectionPin(
						revision.active_bindings,
						revision.learned_state_revision,
					),
					selectedFrom,
				)
			)
				return { status: 'stale-selection' }
			const pending = store.pendingWork
				.list()
				.filter((work) => work.status === 'pending')
			let supersededAttempts = 0
			for (const work of pending) {
				if (isDeepStrictEqual(work.bindings, profile.bindings)) continue
				const replacementWorkId = this.options.ids.next('work')
				const replacementAttemptId = this.options.ids.next('attempt')
				const supersedeId = this.options.ids.next('supersede')
				store.pendingWork.add({
					...work,
					id: replacementWorkId,
					attempt_id: replacementAttemptId,
					bindings: profile.bindings,
					updated_at: now,
				})
				for (const id of work.input_ids)
					store.pendingInputs.update(id, {
						pending_work_id: replacementWorkId,
						attempt_id: replacementAttemptId,
					})
				store.pendingWork.delete(work.id)
				store.state.add({
					id: supersedeId,
					value: {
						kind: this.options.policy.stateKind,
						record: 'supersede',
						oldAttemptId: work.attempt_id,
						replacementAttemptId,
						reason: 'profile-activation',
						createdAt: now,
					},
					updated_at: now,
				})
				supersededAttempts += 1
			}
			store.state.add({
				id: profileStateId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'profile',
					profile,
				},
				updated_at: now,
			})
			store.state.update(this.options.policy.headStateId, {
				value: {
					kind: this.options.policy.stateKind,
					record: 'head',
					profileStateId,
					profile,
				},
				updated_at: now,
			})
			store.state.add({
				id: activationId,
				value: {
					kind: this.options.policy.stateKind,
					record: 'activation',
					previousProfile: head.profile.ref,
					profile: profile.ref,
					createdAt: now,
				},
				updated_at: now,
			})
			store.learningRevisions.update('current', {
				config_revision: revision.config_revision + 1,
				active_bindings: profile.bindings,
				updated_at: now,
			})
			this.pruneMechanics(store)
			return { status: 'activated', profile: profile.ref, supersededAttempts }
		})
	}

	async selectionState(): Promise<TextSelectionStatePin> {
		return this.options.store.runAtomic((store) => {
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			if (!revision.active_bindings)
				throw new Error('active bindings are missing')
			return selectionPin(
				revision.active_bindings,
				revision.learned_state_revision,
			)
		})
	}

	async snapshot(): Promise<TextCoordinatorSnapshot> {
		return this.options.store.runAtomic((store) => {
			const head = stateValue<TConfiguration>(
				store.state.get(this.options.policy.headStateId),
				this.options.policy,
			)
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			const processed = store.processedInputs
				.list()
				.sort((left, right) =>
					left.processed_at.localeCompare(right.processed_at),
				)
			const states = store.state
				.list()
				.map((record) =>
					stateValue<TConfiguration>(record, this.options.policy),
				)
			const horizonMs =
				head?.record === 'head'
					? head.profile.configuration.idempotence.processedIdHorizonMs
					: 0
			const maxIds =
				head?.record === 'head'
					? head.profile.configuration.idempotence.maxProcessedIds
					: 0
			return {
				...(head?.record === 'head' ? { activeProfile: head.profile.ref } : {}),
				memoryRevision: revision.memory_revision,
				learnedStateRevision: revision.learned_state_revision,
				pendingDeliveryIds: store.pendingInputs
					.list()
					.map((record) => record.id)
					.sort((left, right) => left.localeCompare(right)),
				runningRunIds: states.flatMap((value) =>
					value?.record === 'run' ? [value.runId] : [],
				),
				candidateIds: states.flatMap((value) =>
					value?.record === 'candidate' ? [value.candidateId] : [],
				),
				processedCoverage: {
					retainedIds: processed.length,
					...(processed[0]
						? { oldestProcessedAt: processed[0].processed_at }
						: {}),
					horizonMs,
					maxIds,
				},
			}
		})
	}

	async earliestDueAt(): Promise<string | undefined> {
		return this.options.store.runAtomic((store) => {
			const revision = revisionOrInitial(store.learningRevisions.get('current'))
			const blocked = new Set(
				store.state.list().flatMap((record) => {
					const value = stateValue<TConfiguration>(record, this.options.policy)
					return value?.record === 'capacity' &&
						value.memoryRevision === revision.memory_revision &&
						value.configurationRevision === revision.config_revision
						? [value.workId]
						: []
				}),
			)
			return store.pendingWork
				.list()
				.filter((work) => work.status === 'pending' && !blocked.has(work.id))
				.sort((left, right) =>
					left.available_at.localeCompare(right.available_at),
				)[0]?.available_at
		})
	}

	private validateProfile(profile: TextProfileSnapshot<TConfiguration>): void {
		if (
			!profile.ref.id ||
			!profile.ref.version ||
			!validTimestamp(profile.createdAt)
		)
			throw new Error('profile ref and timestamp are required')
		requireNonnegative(profile.revision, 'profile revision')
		if (
			!isDeepStrictEqual(profile.ref, profile.bindings.profile) ||
			profile.revision !== profile.bindings.profile_revision
		)
			throw new Error('profile snapshot and bindings disagree')
		const config = profile.configuration
		requirePositive(config.batching.maxItems, 'batching.maxItems')
		requirePositive(
			config.batching.maxInputCharacters,
			'batching.maxInputCharacters',
		)
		requirePositive(config.batching.maxInputTokens, 'batching.maxInputTokens')
		requireNonnegative(config.batching.maxDelayMs, 'batching.maxDelayMs')
		requirePositive(config.input.maxItemCharacters, 'input.maxItemCharacters')
		requirePositive(config.memory.maxCharacters, 'memory.maxCharacters')
		requireNonnegative(
			config.retries.maxLogicalAttempts,
			'retries.maxLogicalAttempts',
		)
		requireNonnegative(config.retries.initialDelayMs, 'retries.initialDelayMs')
		requireNonnegative(config.retries.maxDelayMs, 'retries.maxDelayMs')
		requireNonnegative(
			config.retries.terminalAfterMs,
			'retries.terminalAfterMs',
		)
		requirePositive(config.history.maxEntries, 'history.maxEntries')
		requirePositive(config.history.maxCharacters, 'history.maxCharacters')
		requireNonnegative(
			config.idempotence.processedIdHorizonMs,
			'idempotence.processedIdHorizonMs',
		)
		requirePositive(
			config.idempotence.maxProcessedIds,
			'idempotence.maxProcessedIds',
		)
	}

	private snapshotForRun(
		store: Parameters<Parameters<NeuronStore['runAtomic']>[0]>[0],
		run: RunState,
	): Omit<TextProcedureStateSnapshot<TConfiguration>, 'signal'> {
		const head = stateValue<TConfiguration>(
			store.state.get(this.options.policy.headStateId),
			this.options.policy,
		)
		if (!head || head.record !== 'head')
			throw new Error('text learning profile is missing')
		const work = store.pendingWork.get(run.pendingWorkId)
		if (!work?.inputs) throw new Error('run source is missing')
		const selected = new Set(run.inputIds)
		const inputs = work.inputs
			.filter((entry) => selected.has(entry.id))
			.map(
				(entry): TextInput => ({
					deliveryId: entry.id,
					text: entry.text,
					observedAt: entry.observed_at ?? work.created_at,
					...(entry.event_id ? { eventId: entry.event_id } : {}),
					...(entry.urgency ? { urgency: entry.urgency } : {}),
				}),
			)
		const memory = store.understanding.get(
			this.options.policy.narrativeMemoryId,
		)
		return {
			runId: run.runId,
			pins: {
				execution: {
					memory: run.memoryRevision,
					configuration: run.configurationRevision,
					registry: run.bindings.registry_lineage,
				},
				neuron: {
					id: run.bindings.neuron.id,
					incarnation: run.bindings.neuron.incarnation,
					ownershipRevision: run.bindings.neuron.ownership_revision,
				},
				procedure: run.bindings.procedure,
				profile: run.bindings.profile,
				model: run.bindings.model,
				learnedStateRevision: run.learnedStateRevision,
			},
			configuration: head.profile.configuration,
			memory: {
				text: typeof memory?.data === 'string' ? memory.data : '',
				revision: run.memoryRevision,
			},
			inputs,
		}
	}

	private disposeFailedWork(
		store: Parameters<Parameters<NeuronStore['runAtomic']>[0]>[0],
		work: PendingWorkRecord,
		code: string,
		now: string,
		horizonMs: number,
		maxProcessedIds: number,
	): void {
		for (const id of work.input_ids) {
			const pending = store.pendingInputs.get(id)
			if (pending) store.pendingInputs.delete(id)
			store.processedInputs.add({
				id,
				attempt_id: work.attempt_id,
				outcome: 'terminal-failure',
				memory_revision: revisionOrInitial(
					store.learningRevisions.get('current'),
				).memory_revision,
				processed_at: now,
				identity_digest: pending?.identity_digest,
				expires_at: addMilliseconds(now, horizonMs),
			})
		}
		store.pendingWork.delete(work.id)
		const failureId = this.options.ids.next('supersede')
		store.state.add({
			id: failureId,
			value: {
				kind: this.options.policy.stateKind,
				record: 'terminal-failure',
				attemptId: work.attempt_id,
				inputIds: work.input_ids,
				code,
				createdAt: now,
			},
			updated_at: now,
		})
		const revision = revisionOrInitial(store.learningRevisions.get('current'))
		store.learningRevisions.update('current', {
			learned_state_revision: revision.learned_state_revision + 1,
			updated_at: now,
		})
		const processed = store.processedInputs
			.list()
			.sort(
				(left, right) =>
					right.processed_at.localeCompare(left.processed_at) ||
					right.id.localeCompare(left.id),
			)
		for (const [index, record] of processed.entries())
			if (index >= maxProcessedIds) store.processedInputs.delete(record.id)
	}

	private pruneMechanics(
		store: Parameters<Parameters<NeuronStore['runAtomic']>[0]>[0],
	): void {
		const records = store.state
			.list()
			.filter((record) => {
				const value = stateValue<TConfiguration>(record, this.options.policy)
				return (
					value?.record === 'profile' ||
					value?.record === 'activation' ||
					value?.record === 'supersede' ||
					value?.record === 'terminal-failure'
				)
			})
			.sort(
				(left, right) =>
					right.updated_at.localeCompare(left.updated_at) ||
					right.id.localeCompare(left.id),
			)
		const head = stateValue<TConfiguration>(
			store.state.get(this.options.policy.headStateId),
			this.options.policy,
		)
		for (const record of records.slice(
			this.options.policy.maxRetainedProfiles,
		)) {
			if (head?.record === 'head' && record.id === head.profileStateId) continue
			store.state.delete(record.id)
		}
	}
}
