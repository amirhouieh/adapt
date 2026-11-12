import { createHash } from 'node:crypto'
import type {
	AtomicNeuronStore,
	ClaimOutboxInput,
	EnqueueLearningWorkInput,
	EnqueueLearningWorkResult,
	LearningCommitInput,
	LearningCommitResult,
	LearningCommitStore,
	LearningRevisionRecord,
	LearningStoreOptions,
	OutboxRecord,
	PendingWorkContinuation,
	PendingWorkRecord,
	SettleOutboxInput,
	UpdateLearningConfigRevisionInput,
	UpdateLearningConfigRevisionResult,
} from '../types'

type RunAtomic = <T>(operation: (store: AtomicNeuronStore) => T) => Promise<T>
const revisionId = 'current' as const

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length
}
function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}
function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}
function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value)
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}
function requireLimit(value: number): void {
	if (!validLimit(value)) throw new Error('limit must be a finite nonnegative safe integer')
}
function requireTimestamp(value: string, name: string): void {
	if (!validTimestamp(value)) throw new Error(`${name} must be a normalized UTC ISO timestamp`)
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false
	const rightIds = new Set(right)
	return left.every((id) => rightIds.has(id))
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object') {
		const result = Object.create(null) as Record<string, unknown>
		for (const key of Object.keys(value).sort()) {
			const item = (value as Record<string, unknown>)[key]
			if (item !== undefined) result[key] = canonical(item)
		}
		return result
	}
	return value
}
function commitIntentDigest(input: LearningCommitInput): string {
	return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

function validatePendingWork(work: PendingWorkRecord | PendingWorkContinuation): string | undefined {
	if (!work.id || !work.attempt_id || work.input_ids.length === 0) return 'Work id, attempt id, and input ids are required'
	if (!unique(work.input_ids)) return 'Pending input ids must be unique'
	if ('inputs' in work && work.inputs !== undefined) {
		if (!unique(work.inputs.map(({ id }) => id))) return 'Pending work text ids must be unique'
		if (work.inputs.some(({ id, text }) => !work.input_ids.includes(id) || typeof text !== 'string')) return 'Pending work text must belong to pending input ids'
	}
	if (
		work.status !== 'pending' || !validRevision(work.retry_count) ||
		!validTimestamp(work.available_at) || !validTimestamp(work.created_at) ||
		!validTimestamp(work.updated_at)
	) return 'Pending work has invalid status, retry count, or timestamp'
	return undefined
}

function currentRevisions(store: AtomicNeuronStore): LearningRevisionRecord {
	const current = store.learningRevisions.get(revisionId)
	return current
		? { ...current, learned_state_revision: current.learned_state_revision ?? current.memory_revision }
		: { id: revisionId, memory_revision: 0, config_revision: 0, learned_state_revision: 0 }
}

function samePortable(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function queuedInput(entry: NonNullable<PendingWorkRecord['inputs']>[number]): NonNullable<PendingWorkRecord['inputs']>[number] {
	return {
		id: entry.id,
		text: entry.text,
		...(entry.event_id === undefined ? {} : { event_id: entry.event_id }),
		...(entry.observed_at === undefined ? {} : { observed_at: entry.observed_at }),
		...(entry.urgency === undefined ? {} : { urgency: entry.urgency }),
		...(entry.identity_digest === undefined ? {} : { identity_digest: entry.identity_digest }),
	}
}

function validateCommit(input: LearningCommitInput): string | undefined {
	if (!input.logical_attempt_id) return 'logical_attempt_id is required'
	if (!input.pending_work_id) return 'pending_work_id is required'
	if (input.input_ids.length === 0) return 'input_ids must not be empty'
	if (!unique(input.input_ids)) return 'input_ids must be unique'
	if (input.remaining_work) {
		if ('inputs' in input.remaining_work || 'payload' in input.remaining_work) return 'remaining_work cannot supply source content'
		const error = validatePendingWork(input.remaining_work)
		if (error) return error
		if (input.remaining_work.id === input.pending_work_id || input.remaining_work.attempt_id === input.logical_attempt_id) return 'Remaining work requires new work and attempt IDs'
	}
	if (!validRevision(input.expected_memory_revision)) return 'expected_memory_revision must be a finite nonnegative safe integer'
	if (!validRevision(input.expected_config_revision)) return 'expected_config_revision must be a finite nonnegative safe integer'
	if (input.expected_learned_state_revision !== undefined && !validRevision(input.expected_learned_state_revision)) return 'expected_learned_state_revision must be a finite nonnegative safe integer'
	if (!validTimestamp(input.committed_at)) return 'committed_at must be a normalized UTC ISO timestamp'
	if (input.retention) {
		if (!validLimit(input.retention.max_history_entries) || input.retention.max_history_entries === 0) return 'max_history_entries must be positive'
		if (!validLimit(input.retention.max_history_characters) || input.retention.max_history_characters === 0) return 'max_history_characters must be positive'
		if (!validLimit(input.retention.max_processed_ids) || input.retention.max_processed_ids === 0) return 'max_processed_ids must be positive'
		if (!validTimestamp(input.retention.processed_expires_at)) return 'processed_expires_at must be a normalized UTC ISO timestamp'
	}
	const observationAdds = input.observations?.add ?? []
	const settledObservationIds = input.observations?.mark_processed_ids ?? []
	const evolutionRecords = input.evolution_records ?? []
	const changesLearnedState = Boolean(
		input.patch || observationAdds.length > 0 || settledObservationIds.length > 0 || evolutionRecords.length > 0,
	)
	if (input.outcome === 'change' && !changesLearnedState) return 'A change outcome requires a learned-state change'
	if (input.outcome === 'no-change' && changesLearnedState) return 'A no-change outcome cannot include a learned-state change'
	if (!unique(observationAdds.map(({ id }) => id))) return 'Added observation IDs must be unique'
	if (!unique(settledObservationIds)) return 'Settled observation IDs must be unique'
	if (observationAdds.some(({ id }) => settledObservationIds.includes(id))) return 'Added and settled observation IDs must be distinct'
	if (observationAdds.some(({ id }) => input.input_ids.includes(id))) return 'Added observation IDs must be distinct from consumed source IDs'
	if (settledObservationIds.some((id) => !input.input_ids.includes(id))) return 'Settled observations must belong to the consumed synthesis inputs'
	for (const record of observationAdds) {
		if (
			record.metadata_status !== 'pending' || !Number.isFinite(record.metadata_importance) ||
			!Number.isSafeInteger(record.metadata_tokens) || record.metadata_tokens < 0 ||
			!validTimestamp(record.metadata_created_at)
		) return `Observation ${record.id} must be pending with valid metadata`
	}
	if (!unique(evolutionRecords.map(({ id }) => id))) return 'Evolution record IDs must be unique'
	for (const record of evolutionRecords) {
		if (!validTimestamp(record.created_at)) return `Evolution record ${record.id} has an invalid timestamp`
	}
	const suppliedIds = [
		input.history.id,
		...input.changes.map(({ id }) => id),
		...input.outbox.map(({ id }) => id),
		...observationAdds.map(({ id }) => id),
		...evolutionRecords.map(({ id }) => id),
	]
	if (!unique(suppliedIds)) return 'Commit record IDs must be unique'
	if (input.patch?.type === 'operations' && !unique([...input.patch.upsert.map(({ id }) => id), ...input.patch.delete_ids])) return 'Memory patch IDs must be unique'
	if (input.patch?.type === 'replace' && !unique(input.patch.records.map(({ id }) => id))) return 'Replacement memory IDs must be unique'
	for (const record of input.patch?.type === 'replace' ? input.patch.records : (input.patch?.upsert ?? [])) {
		if (!validTimestamp(record.metadata_created_at) || !validTimestamp(record.metadata_updated_at)) return `Understanding ${record.id} has an invalid timestamp`
		if (record.metadata_confidence !== null && (!Number.isFinite(record.metadata_confidence) || record.metadata_confidence < 0 || record.metadata_confidence > 1)) return `Understanding ${record.id} has invalid confidence`
	}
	if (!validTimestamp(input.history.created_at)) return `Learning history ${input.history.id} has an invalid timestamp`
	if (!unique(input.history.change_ids)) return `Learning history ${input.history.id} has duplicate references`
	for (const record of input.changes) {
		if (!unique(record.affected_memory_ids)) return `Memory change ${record.id} has duplicate memory references`
		if (!validTimestamp(record.created_at)) return `Memory change ${record.id} has an invalid timestamp`
	}
	for (const record of input.outbox) {
		if (
			record.status !== 'pending' || record.attempts !== 0 ||
			record.lease_owner !== undefined || record.lease_token !== undefined ||
			record.lease_expires_at !== undefined || !unique(record.change_ids)
		) return `New outbox record ${record.id} must be pending and unattempted`
		if (![record.available_at, record.created_at, record.updated_at].every(validTimestamp)) return `Outbox record ${record.id} has an invalid timestamp`
	}
	return undefined
}

function applyPatch(store: AtomicNeuronStore, input: LearningCommitInput): void {
	const patch = input.patch
	if (!patch) return
	if (patch.type === 'replace') {
		store.understanding.clear()
		for (const record of patch.records) store.understanding.add(record)
		return
	}
	for (const id of patch.delete_ids) if (store.understanding.get(id)) store.understanding.delete(id)
	for (const record of patch.upsert) {
		if (store.understanding.get(record.id)) {
			const { id: _id, ...changes } = record
			store.understanding.update(record.id, changes)
		} else store.understanding.add(record)
	}
}

function validateLearnedRecords(store: AtomicNeuronStore, input: LearningCommitInput): string | undefined {
	for (const record of input.observations?.add ?? []) {
		if (store.observations.get(record.id)) return `Observation ${record.id} already exists`
	}
	for (const id of input.observations?.mark_processed_ids ?? []) {
		const record = store.observations.get(id)
		if (!record || record.metadata_status !== 'pending') return `Observation ${id} is not pending`
	}
	for (const record of input.evolution_records ?? []) {
		if (store.evolution.get(record.id)) return `Evolution record ${record.id} already exists`
	}
	return undefined
}

function applyLearnedRecords(store: AtomicNeuronStore, input: LearningCommitInput): void {
	for (const record of input.observations?.add ?? []) store.observations.add(record)
	for (const id of input.observations?.mark_processed_ids ?? []) {
		store.observations.update(id, { metadata_status: 'processed' })
	}
	for (const record of input.evolution_records ?? []) store.evolution.add(record)
}

function validateReferences(store: AtomicNeuronStore, input: LearningCommitInput): string | undefined {
	const changes = new Set(input.changes.map(({ id }) => id))
	for (const id of input.history.change_ids) if (!changes.has(id) && !store.memoryChanges.get(id)) return `Unknown memory change reference: ${id}`
	for (const record of input.outbox) {
		for (const id of record.change_ids) if (!changes.has(id) && !store.memoryChanges.get(id)) return `Unknown memory change reference: ${id}`
	}
	return undefined
}

function validateCommitRecords(input: LearningCommitInput, previousRevision: number, nextRevision: number): string | undefined {
	const history = input.history
	if (
		history.attempt_id !== input.logical_attempt_id || history.outcome !== input.outcome ||
		history.previous_memory_revision !== previousRevision || history.memory_revision !== nextRevision ||
		history.config_revision !== input.expected_config_revision || !sameIds(history.input_ids, input.input_ids) ||
		!sameIds(history.change_ids, input.changes.map(({ id }) => id))
	) return 'Learning history does not match the commit'
	for (const record of input.changes) {
		if (record.attempt_id !== input.logical_attempt_id || record.memory_revision !== nextRevision) return `Memory change ${record.id} does not match the commit`
	}
	return undefined
}

function continuationRecord(continuation: PendingWorkContinuation, source: PendingWorkRecord): PendingWorkRecord {
	const allowed = new Set(continuation.input_ids)
	const inputs = source.inputs
		?.filter(({ id }) => allowed.has(id))
		.map(queuedInput)
	return {
		id: continuation.id,
		attempt_id: continuation.attempt_id,
		input_ids: [...continuation.input_ids],
		...(inputs && inputs.length > 0 ? { inputs } : {}),
		...(source.bindings ? { bindings: structuredClone(source.bindings) } : {}),
		status: continuation.status,
		retry_count: continuation.retry_count,
		available_at: continuation.available_at,
		...(continuation.last_error === undefined ? {} : { last_error: continuation.last_error }),
		created_at: continuation.created_at,
		updated_at: continuation.updated_at,
	}
}

function queuedWorkRecord(work: PendingWorkRecord): PendingWorkRecord {
	return {
		id: work.id,
		attempt_id: work.attempt_id,
		input_ids: [...work.input_ids],
		...(work.inputs && work.inputs.length > 0
			? { inputs: work.inputs.map(queuedInput) }
			: {}),
		...(work.bindings ? { bindings: structuredClone(work.bindings) } : {}),
		status: work.status,
		retry_count: work.retry_count,
		available_at: work.available_at,
		...(work.last_error === undefined ? {} : { last_error: work.last_error }),
		created_at: work.created_at,
		updated_at: work.updated_at,
	}
}

export function createLearningCommitStore(runAtomic: RunAtomic, options: LearningStoreOptions = {}): LearningCommitStore {
	return {
		async enqueue(input: EnqueueLearningWorkInput): Promise<EnqueueLearningWorkResult> {
			const work = queuedWorkRecord(structuredClone(input.work))
			const workError = validatePendingWork(work)
			if (workError) return { status: 'failure', error: workError }
			try {
				return await runAtomic((store) => {
					const completed = store.learningAttempts.get(work.attempt_id)
					if (completed) return sameIds(completed.input_ids, work.input_ids) ? { status: 'deduplicated', attempt_id: completed.id } : { status: 'conflict', reason: 'attempt-id-reused' }
					const existing = store.pendingWork.get(work.id)
					if (existing) return existing.attempt_id === work.attempt_id && JSON.stringify(canonical(existing)) === JSON.stringify(canonical(work)) ? { status: 'deduplicated', pending_work_id: existing.id } : { status: 'conflict', reason: 'attempt-id-reused' }
					const byAttempt = store.pendingWork.list({ attempt_id: work.attempt_id }).at(0)
					if (byAttempt) return JSON.stringify(canonical(byAttempt)) === JSON.stringify(canonical(work)) ? { status: 'deduplicated', pending_work_id: byAttempt.id } : { status: 'conflict', reason: 'attempt-id-reused' }
					const processed = work.input_ids.map((id) => store.processedInputs.get(id)).filter((record) => record !== undefined)
					if (processed.length === work.input_ids.length) {
						const conflict = work.inputs?.some((entry) => {
							const record = store.processedInputs.get(entry.id)
							return entry.identity_digest !== undefined && record?.identity_digest !== undefined && entry.identity_digest !== record.identity_digest
						})
						return conflict ? { status: 'conflict', reason: 'delivery-id-reused' } : { status: 'deduplicated', attempt_id: processed[0]?.attempt_id }
					}
					if (processed.length > 0) return { status: 'conflict', reason: 'partial-input-overlap' }
					const pending = work.input_ids.map((id) => store.pendingInputs.get(id)).filter((record) => record !== undefined)
					if (pending.length > 0) {
						const conflict = work.inputs?.some((entry) => {
							const record = store.pendingInputs.get(entry.id)
							return entry.identity_digest !== undefined && record?.identity_digest !== undefined && entry.identity_digest !== record.identity_digest
						})
						if (conflict) return { status: 'conflict', reason: 'delivery-id-reused' }
						const owners = new Set(pending.map(({ pending_work_id }) => pending_work_id))
						if (pending.length === work.input_ids.length && owners.size === 1) return { status: 'deduplicated', pending_work_id: pending[0]?.pending_work_id }
						return { status: 'conflict', reason: 'partial-input-overlap' }
					}
					store.pendingWork.add(queuedWorkRecord(work))
					for (const id of work.input_ids) store.pendingInputs.add({ id, pending_work_id: work.id, attempt_id: work.attempt_id, created_at: work.created_at, identity_digest: work.inputs?.find((entry) => entry.id === id)?.identity_digest })
					return { status: 'queued', pending_work_id: work.id }
				})
			} catch (error) {
				return { status: 'failure', error: errorMessage(error) }
			}
		},

		async commit(input: LearningCommitInput): Promise<LearningCommitResult> {
			input = structuredClone(input)
			const validationError = validateCommit(input)
			if (validationError) return { status: 'failure', error: validationError }
			const digest = commitIntentDigest(input)
			try {
				return await runAtomic((store) => {
					const revision = currentRevisions(store)
					const learnedStateRevision = revision.learned_state_revision ?? revision.memory_revision
					const existing = store.learningAttempts.get(input.logical_attempt_id)
					if (existing) {
						if (!sameIds(existing.input_ids, input.input_ids) || existing.intent_digest !== digest) return { status: 'conflict', reason: 'input-overlap', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
						return { status: existing.status, memory_revision: existing.memory_revision, config_revision: existing.config_revision, learned_state_revision: learnedStateRevision, deduplicated: true, remaining_work_id: existing.remaining_work_id }
					}
					if (revision.memory_revision !== input.expected_memory_revision) return { status: 'conflict', reason: 'memory-revision', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					if (revision.config_revision !== input.expected_config_revision) return { status: 'conflict', reason: 'config-revision', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					if (input.expected_learned_state_revision !== undefined && learnedStateRevision !== input.expected_learned_state_revision) return { status: 'conflict', reason: 'learned-state-revision', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					if (input.bindings && !samePortable(revision.active_bindings, input.bindings)) return { status: 'conflict', reason: 'profile', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					const work = store.pendingWork.get(input.pending_work_id)
					if (!work || work.status !== 'pending' || work.attempt_id !== input.logical_attempt_id || !input.input_ids.every((id) => work.input_ids.includes(id))) return { status: 'conflict', reason: 'pending-work', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					if (input.bindings && !samePortable(work.bindings, input.bindings)) return { status: 'conflict', reason: 'profile', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					const ownsPending = work.input_ids.every((id) => {
						const pending = store.pendingInputs.get(id)
						return pending?.pending_work_id === work.id && pending.attempt_id === work.attempt_id
					})
					if (!ownsPending) return { status: 'conflict', reason: 'pending-work', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					const consumed = new Set(input.input_ids)
					const remainingIds = work.input_ids.filter((id) => !consumed.has(id))
					if (remainingIds.length === 0 && input.remaining_work) throw new Error('remaining_work supplied when all pending inputs are consumed')
					if (remainingIds.length > 0) {
						const remaining = input.remaining_work
						if (!remaining || !sameIds(remaining.input_ids, remainingIds)) throw new Error('remaining_work must contain exactly the unconsumed input ids')
						if (store.pendingWork.get(remaining.id) || store.learningAttempts.get(remaining.attempt_id) || store.pendingWork.list({ attempt_id: remaining.attempt_id }).length > 0) throw new Error('remaining_work id or attempt id already exists')
					}
					if (input.input_ids.some((id) => store.processedInputs.get(id))) return { status: 'conflict', reason: 'input-overlap', memory_revision: revision.memory_revision, config_revision: revision.config_revision, learned_state_revision: learnedStateRevision }
					const nextRevision = input.outcome === 'change' ? revision.memory_revision === Number.MAX_SAFE_INTEGER ? undefined : revision.memory_revision + 1 : revision.memory_revision
					if (nextRevision === undefined) throw new Error('memory_revision cannot advance beyond MAX_SAFE_INTEGER')
					const recordError = validateCommitRecords(input, revision.memory_revision, nextRevision)
					if (recordError) throw new Error(recordError)
					const referenceError = validateReferences(store, input)
					if (referenceError) throw new Error(referenceError)
					const learnedRecordError = validateLearnedRecords(store, input)
					if (learnedRecordError) throw new Error(learnedRecordError)
					applyPatch(store, input)
					applyLearnedRecords(store, input)
					options.onCommitStage?.('after-memory')
					store.learningHistory.add(input.history)
					for (const record of input.changes) store.memoryChanges.add(record)
					for (const record of input.outbox) if (!store.outbox.list({ deduplication_key: record.deduplication_key }).at(0)) store.outbox.add(record)
					options.onCommitStage?.('after-history')
					for (const id of input.input_ids) {
						const pending = store.pendingInputs.get(id)
						store.pendingInputs.delete(id)
						store.processedInputs.add({ id, attempt_id: input.logical_attempt_id, outcome: input.outcome, memory_revision: nextRevision, processed_at: input.committed_at, identity_digest: pending?.identity_digest, expires_at: input.retention?.processed_expires_at })
					}
					store.pendingWork.delete(input.pending_work_id)
					if (input.remaining_work) {
						const remaining = continuationRecord(input.remaining_work, work)
						store.pendingWork.add(remaining)
						for (const id of remaining.input_ids) {
							const pending = store.pendingInputs.get(id)
							if (!pending) throw new Error(`pending input ${id} disappeared during transfer`)
							store.pendingInputs.update(id, { pending_work_id: remaining.id, attempt_id: remaining.attempt_id })
						}
					}
					store.learningAttempts.add({ id: input.logical_attempt_id, pending_work_id: input.pending_work_id, input_ids: input.input_ids, status: input.outcome === 'change' ? 'committed' : 'no-change', memory_revision: nextRevision, config_revision: revision.config_revision, history_id: input.history.id, remaining_work_id: input.remaining_work?.id, intent_digest: digest, created_at: input.committed_at, bindings: input.bindings })
					if (input.retention) {
						const history = store.learningHistory.list().sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
						let retainedCharacters = 0
						const removedChangeIds = new Set<string>()
						for (const [index, record] of history.entries()) {
							retainedCharacters += JSON.stringify(record).length
							if (index >= input.retention.max_history_entries || retainedCharacters > input.retention.max_history_characters) {
								store.learningHistory.delete(record.id)
								for (const id of record.change_ids) removedChangeIds.add(id)
							}
						}
						const retainedChangeIds = new Set(store.learningHistory.list().flatMap((record) => record.change_ids))
						for (const id of removedChangeIds) if (!retainedChangeIds.has(id) && store.memoryChanges.get(id)) store.memoryChanges.delete(id)
						const processed = store.processedInputs.list().sort((left, right) => right.processed_at.localeCompare(left.processed_at) || right.id.localeCompare(left.id))
						for (const [index, record] of processed.entries()) {
							if (index >= input.retention.max_processed_ids || (record.expires_at !== undefined && record.expires_at <= input.committed_at)) store.processedInputs.delete(record.id)
						}
					}
					if (learnedStateRevision === Number.MAX_SAFE_INTEGER) throw new Error('learned_state_revision cannot advance beyond MAX_SAFE_INTEGER')
					const nextLearnedStateRevision = learnedStateRevision + 1
					for (const id of input.transient_state_ids ?? []) if (store.state.get(id)) store.state.delete(id)
					const next: LearningRevisionRecord = { id: revisionId, memory_revision: nextRevision, config_revision: revision.config_revision, learned_state_revision: nextLearnedStateRevision, active_bindings: revision.active_bindings, updated_at: input.committed_at }
					if (store.learningRevisions.get(revisionId)) {
						const { id: _id, ...changes } = next
						store.learningRevisions.update(revisionId, changes)
					} else store.learningRevisions.add(next)
					options.onCommitStage?.('before-complete')
					return { status: input.outcome === 'change' ? 'committed' : 'no-change', memory_revision: nextRevision, config_revision: revision.config_revision, learned_state_revision: nextLearnedStateRevision, deduplicated: false, remaining_work_id: input.remaining_work?.id }
				})
			} catch (error) {
				return { status: 'failure', error: errorMessage(error) }
			}
		},

		async getRevisions(): Promise<LearningRevisionRecord> {
			return runAtomic((store) => currentRevisions(store))
		},
		async updateConfigRevision(input: UpdateLearningConfigRevisionInput): Promise<UpdateLearningConfigRevisionResult> {
			if (!validRevision(input.expected_config_revision) || !validRevision(input.next_config_revision) || input.next_config_revision <= input.expected_config_revision) return { status: 'failure', error: 'next_config_revision must increase' }
			if (!validTimestamp(input.updated_at)) return { status: 'failure', error: 'updated_at must be a normalized UTC ISO timestamp' }
			try {
				return await runAtomic((store) => {
					const current = currentRevisions(store)
					if (current.config_revision !== input.expected_config_revision) return { status: 'conflict', config_revision: current.config_revision }
					const next = { memory_revision: current.memory_revision, config_revision: input.next_config_revision, updated_at: input.updated_at }
					if (store.learningRevisions.get(revisionId)) store.learningRevisions.update(revisionId, next)
					else store.learningRevisions.add({ id: revisionId, ...next })
					return { status: 'updated', config_revision: input.next_config_revision }
				})
			} catch (error) {
				return { status: 'failure', error: errorMessage(error) }
			}
		},
		async claimOutbox(input: ClaimOutboxInput): Promise<OutboxRecord[]> {
			requireLimit(input.limit)
			requireTimestamp(input.now, 'now')
			requireTimestamp(input.lease_expires_at, 'lease_expires_at')
			if (!input.consumer_id || !input.lease_token) throw new Error('consumer_id and lease_token are required')
			if (input.lease_expires_at <= input.now) throw new Error('lease_expires_at must be after now')
			return runAtomic((store) => store.outbox.list().filter((record) =>
				(record.status === 'pending' && record.available_at <= input.now) ||
				(record.status === 'delivering' && typeof record.lease_expires_at === 'string' && record.lease_expires_at <= input.now),
			).slice(0, input.limit).map((record) => {
				const next: OutboxRecord = { ...record, status: 'delivering', attempts: record.attempts + 1, lease_owner: input.consumer_id, lease_token: input.lease_token, lease_expires_at: input.lease_expires_at, updated_at: input.now }
				const { id: _id, ...changes } = next
				store.outbox.update(record.id, changes)
				return next
			}))
		},
		async settleOutbox(input: SettleOutboxInput): Promise<OutboxRecord | undefined> {
			requireTimestamp(input.settled_at, 'settled_at')
			if (input.retry_at) requireTimestamp(input.retry_at, 'retry_at')
			return runAtomic((store) => {
				const record = store.outbox.get(input.id)
				if (!record || record.status !== 'delivering' || record.lease_owner !== input.consumer_id || record.lease_token !== input.lease_token) return undefined
				if (input.outcome === 'retry' && !input.retry_at) return undefined
				const next: OutboxRecord = { ...record, status: input.outcome === 'delivered' ? 'delivered' : 'pending', available_at: input.retry_at ?? record.available_at, lease_owner: undefined, lease_token: undefined, lease_expires_at: undefined, last_error: input.error, updated_at: input.settled_at }
				const { id: _id, ...changes } = next
				store.outbox.update(record.id, changes)
				return next
			})
		},
	}
}
