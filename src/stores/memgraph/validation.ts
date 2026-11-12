import {
	graphEdgeSchema,
	graphEntitySchema,
	graphLensSchemaSchema,
	type GraphLensSchema,
} from '../../neurons/graph'
import type { PendingWorkContinuation, PendingWorkRecord } from '../types'
import type {
	GraphCommitInput,
	MemgraphConnectionConfig,
	MemgraphStorePolicy,
} from './contracts'
import {
	requirePositive,
	requireSafeNonnegative,
	requireTimestamp,
	requireUnique,
	sameIds,
	stringify,
} from './internal'

export function validateOptions(
	connection: MemgraphConnectionConfig,
	policy: MemgraphStorePolicy,
): void {
	if (!connection.uri) throw new Error('Memgraph uri is required')
	requirePositive(connection.connectionTimeoutMs, 'connectionTimeoutMs')
	requirePositive(connection.maxConnectionPoolSize, 'maxConnectionPoolSize')
	requirePositive(connection.transactionTimeoutMs, 'transactionTimeoutMs')
	for (const [name, value] of Object.entries(policy)) requirePositive(value, name)
}

export function validateLensSchema(value: GraphLensSchema, lensId: string): void {
	const schema = graphLensSchemaSchema.parse(value)
	if (schema.lensId !== lensId) throw new Error('graph schema belongs to a different lens')
	requireUnique(schema.entityTypes, 'graph entity types')
	requireUnique(schema.relations.map(({ id }) => id), 'graph relation ids')
	const entityTypes = new Set(schema.entityTypes)
	for (const relation of schema.relations) {
		requireUnique(relation.sourceEntityTypes, `graph relation ${relation.id} source entity types`)
		requireUnique(relation.targetEntityTypes, `graph relation ${relation.id} target entity types`)
		for (const type of [...relation.sourceEntityTypes, ...relation.targetEntityTypes]) {
			if (!entityTypes.has(type)) {
				throw new Error(`graph relation ${relation.id} uses undeclared entity type ${type}`)
			}
		}
	}
}

export function validatePendingWork(
	work: PendingWorkRecord | PendingWorkContinuation,
): void {
	if (!work.id || !work.attempt_id || work.input_ids.length === 0) {
		throw new Error('Work id, attempt id, and input ids are required')
	}
	requireUnique(work.input_ids, 'pending input ids')
	if ('inputs' in work && work.inputs !== undefined) {
		requireUnique(work.inputs.map(({ id }) => id), 'pending work text ids')
		for (const entry of work.inputs) {
			if (!entry.id || !work.input_ids.includes(entry.id) || typeof entry.text !== 'string') {
				throw new Error('pending work text must belong to pending input ids')
			}
		}
	}
	if (work.status !== 'pending') throw new Error('new pending work must be pending')
	requireSafeNonnegative(work.retry_count, 'pending work retry count')
	requireTimestamp(work.available_at, 'pending work available_at')
	requireTimestamp(work.created_at, 'pending work created_at')
	requireTimestamp(work.updated_at, 'pending work updated_at')
}
export function validateCommitInput(
	input: GraphCommitInput,
	policy: MemgraphStorePolicy,
): void {
	if (!input.lensId || !input.logicalAttemptId || !input.pendingWorkId) {
		throw new Error('lens, logical attempt, and pending work ids are required')
	}
	validateLensSchema(input.schema, input.lensId)
	requireSafeNonnegative(input.expectedMemoryRevision, 'expectedMemoryRevision')
	requireSafeNonnegative(input.expectedConfigRevision, 'expectedConfigRevision')
	requireTimestamp(input.committedAt, 'committedAt')
	if (input.inputIds.length === 0) throw new Error('inputIds must not be empty')
	requireUnique(input.inputIds, 'inputIds')
	if (input.outcome === 'change' && !input.patch) throw new Error('change requires a graph patch')
	if (input.outcome === 'no-change' && input.patch) throw new Error('no-change cannot include a graph patch')
	if (input.patch && input.patch.expectedRevision !== input.expectedMemoryRevision) {
		throw new Error('graph patch revision does not match commit revision')
	}
	if (input.remainingWork) {
		if ('inputs' in input.remainingWork || 'payload' in input.remainingWork) {
			throw new Error('remaining work cannot supply source content')
		}
		validatePendingWork(input.remainingWork)
		if (
			input.remainingWork.id === input.pendingWorkId ||
			input.remainingWork.attempt_id === input.logicalAttemptId
		) {
			throw new Error('remaining work requires new work and attempt ids')
		}
	}
	const totalRecords =
		(input.patch?.entityUpserts.length ?? 0) +
		(input.patch?.edgeChanges.length ?? 0) +
		input.changes.length + input.outbox.length + 1
	if (totalRecords > policy.maxRecordsPerCommit) throw new Error('commit record limit exceeded')
	if (stringify(input).length > policy.maxSerializedCharsPerCommit) {
		throw new Error('commit serialized character limit exceeded')
	}
	const suppliedIds = [
		input.history.id,
		...input.changes.map(({ id }) => id),
		...input.outbox.map(({ id }) => id),
	]
	requireUnique(suppliedIds, 'commit record ids')
	requireTimestamp(input.history.created_at, `history ${input.history.id} created_at`)
	requireUnique(input.history.input_ids, `history ${input.history.id} input ids`)
	requireUnique(input.history.change_ids, `history ${input.history.id} change ids`)
	for (const record of input.changes) {
		requireUnique(record.affected_memory_ids, `change ${record.id} memory ids`)
		requireTimestamp(record.created_at, `change ${record.id} created_at`)
	}
	for (const record of input.outbox) {
		if (
			record.status !== 'pending' || record.attempts !== 0 ||
			record.lease_owner !== undefined || record.lease_token !== undefined ||
			record.lease_expires_at !== undefined
		) throw new Error(`new outbox ${record.id} must be pending and unattempted`)
		requireUnique(record.change_ids, `outbox ${record.id} change ids`)
		requireTimestamp(record.available_at, `outbox ${record.id} available_at`)
		requireTimestamp(record.created_at, `outbox ${record.id} created_at`)
		requireTimestamp(record.updated_at, `outbox ${record.id} updated_at`)
	}
	requireUnique(input.patch?.entityUpserts.map(({ id }) => id) ?? [], 'graph patch entity ids')
	requireUnique(
		input.patch?.edgeChanges.map((change) =>
			change.kind === 'add' ? change.edge.id : change.edgeId,
		) ?? [],
		'graph patch edge ids',
	)
	for (const entity of input.patch?.entityUpserts ?? []) {
		graphEntitySchema.parse(entity)
		requireUnique(entity.aliases, `graph entity ${entity.id} aliases`)
	}
	for (const change of input.patch?.edgeChanges ?? []) {
		if (change.kind === 'add') graphEdgeSchema.parse(change.edge)
		else {
			graphEdgeSchema.parse(change.previous)
			requireTimestamp(change.history.changedAt, `edge history ${change.history.changeId} changedAt`)
		}
	}
	const nextRevision = input.outcome === 'change'
		? input.expectedMemoryRevision + 1
		: input.expectedMemoryRevision
	if (!Number.isSafeInteger(nextRevision)) throw new Error('memory revision cannot advance safely')
	if (
		input.history.attempt_id !== input.logicalAttemptId ||
		input.history.outcome !== input.outcome ||
		input.history.previous_memory_revision !== input.expectedMemoryRevision ||
		input.history.memory_revision !== nextRevision ||
		input.history.config_revision !== input.expectedConfigRevision ||
		!sameIds(input.history.input_ids, input.inputIds) ||
		!sameIds(input.history.change_ids, input.changes.map(({ id }) => id))
	) throw new Error('learning history does not match graph commit')
	for (const change of input.changes) {
		if (change.attempt_id !== input.logicalAttemptId || change.memory_revision !== nextRevision) {
			throw new Error(`memory change ${change.id} does not match graph commit`)
		}
	}
}
