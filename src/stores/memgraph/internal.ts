import type { Record as Neo4jRecord } from 'neo4j-driver'
import type { GraphEdge, GraphEdgeHistory, GraphEntity, GraphLensSchema } from '../../neurons/graph'
import type {
	LearningHistoryRecord,
	MemoryChangeRecord,
	OutboxRecord,
	PendingWorkRecord,
	ProcessedInputRecord,
} from '../types'

export function graphKey(lensId: string, id: string): string {
	return JSON.stringify([lensId, id])
}

export function stringify(value: unknown): string {
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new Error('value is not JSON serializable')
	return encoded
}

export function parse<T>(value: unknown): T {
	if (typeof value !== 'string') throw new Error('stored JSON value is invalid')
	return JSON.parse(value) as T
}

export function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value)
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

export function requireTimestamp(value: string, name: string): void {
	if (!validTimestamp(value)) throw new Error(`${name} must be a normalized UTC ISO timestamp`)
}

export function requireSafeNonnegative(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a finite nonnegative safe integer`)
}

export function requirePositive(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

export function requireUnique(values: readonly string[], name: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`)
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false
	const values = new Set(right)
	return left.every((value) => values.has(value))
}

export function nodeProperties(record: Neo4jRecord, key = 'node'): Record<string, unknown> {
	const value = record.get(key) as { properties?: Record<string, unknown> }
	if (!value?.properties) throw new Error('Memgraph returned an invalid node')
	return value.properties
}

function stringProperty(value: unknown, name: string): string {
	if (typeof value !== 'string') throw new Error(`stored ${name} is invalid`)
	return value
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function numberProperty(value: unknown, name: string): number {
	if (typeof value !== 'number') throw new Error(`stored ${name} is invalid`)
	return value
}

export function pendingWorkFromProperties(properties: Record<string, unknown>): PendingWorkRecord {
	return {
		id: stringProperty(properties.id, 'pending work id'),
		attempt_id: stringProperty(properties.attempt_id, 'pending work attempt id'),
		input_ids: parse(properties.input_ids_json),
		inputs: properties.inputs_json === undefined || properties.inputs_json === null
			? undefined
			: parse(properties.inputs_json),
		status: stringProperty(properties.status, 'pending work status') as PendingWorkRecord['status'],
		retry_count: numberProperty(properties.retry_count, 'pending work retry count'),
		available_at: stringProperty(properties.available_at, 'pending work available time'),
		last_error: optionalString(properties.last_error),
		created_at: stringProperty(properties.created_at, 'pending work created time'),
		updated_at: stringProperty(properties.updated_at, 'pending work updated time'),
	}
}

export function outboxFromProperties(properties: Record<string, unknown>): OutboxRecord {
	return {
		id: stringProperty(properties.id, 'outbox id'),
		kind: stringProperty(properties.kind, 'outbox kind'),
		deduplication_key: stringProperty(properties.deduplication_key, 'outbox deduplication key'),
		change_ids: parse(properties.change_ids_json),
		status: stringProperty(properties.status, 'outbox status') as OutboxRecord['status'],
		attempts: numberProperty(properties.attempts, 'outbox attempts'),
		available_at: stringProperty(properties.available_at, 'outbox available time'),
		lease_owner: optionalString(properties.lease_owner),
		lease_token: optionalString(properties.lease_token),
		lease_expires_at: optionalString(properties.lease_expires_at),
		last_error: optionalString(properties.last_error),
		created_at: stringProperty(properties.created_at, 'outbox created time'),
		updated_at: stringProperty(properties.updated_at, 'outbox updated time'),
	}
}

export function entityFromProperties(properties: Record<string, unknown>): GraphEntity {
	return {
		id: stringProperty(properties.id, 'entity id'),
		type: stringProperty(properties.entity_type, 'entity type'),
		label: stringProperty(properties.label, 'entity label'),
		aliases: parse(properties.aliases_json),
	}
}

export function edgeFromProperties(properties: Record<string, unknown>): GraphEdge {
	return {
		id: stringProperty(properties.id, 'edge id'),
		relation: stringProperty(properties.relation, 'edge relation'),
		sourceEntityId: stringProperty(properties.source_entity_id, 'edge source'),
		targetEntityId: stringProperty(properties.target_entity_id, 'edge target'),
	}
}

export function historyFromProperties(properties: Record<string, unknown>): LearningHistoryRecord {
	return parse(properties.record_json)
}
export function changeFromProperties(properties: Record<string, unknown>): MemoryChangeRecord {
	return parse(properties.record_json)
}
export function processedFromProperties(properties: Record<string, unknown>): ProcessedInputRecord {
	return parse(properties.record_json)
}
export function edgeHistoryFromProperties(properties: Record<string, unknown>): GraphEdgeHistory {
	return parse(properties.record_json)
}
export function schemaFromProperties(properties: Record<string, unknown>): GraphLensSchema {
	return parse(properties.schema_json)
}
