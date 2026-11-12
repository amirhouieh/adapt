import { createHash } from 'node:crypto'
import neo4j, {
	type Driver,
	type QueryResult,
	type Transaction,
} from 'neo4j-driver'
import type {
	GraphEdge,
	GraphEntity,
	GraphLensSchema,
} from '../../neurons/graph'
import type {
	LearningAttemptRecord,
	LearningRevisionRecord,
	OutboxRecord,
	PendingInputRecord,
	PendingWorkRecord,
} from '../types'
import type {
	ConfigureGraphLensInput,
	GraphCommitInput,
	GraphLearningContext,
	GraphLearningContextRequest,
	GraphStoreInspection,
	InitializeGraphLensInput,
	InitializeGraphLensResult,
	MemgraphGraphStore,
	MemgraphGraphStoreOptions,
	StoredGraphTraversalRequest,
	StoredGraphTraversalResult,
} from './contracts'
import {
	changeFromProperties,
	edgeFromProperties,
	edgeHistoryFromProperties,
	entityFromProperties,
	graphKey,
	historyFromProperties,
	nodeProperties,
	outboxFromProperties,
	parse,
	pendingWorkFromProperties,
	processedFromProperties,
	requirePositive,
	requireSafeNonnegative,
	requireTimestamp,
	requireUnique,
	sameIds,
	schemaFromProperties,
	stringify,
} from './internal'
import {
	validateCommitInput,
	validateLensSchema,
	validateOptions,
	validatePendingWork,
} from './validation'

const SCHEMA_STATEMENTS = [
	'CREATE CONSTRAINT ON (node:AdaptGraphState) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptGraphEntity) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptGraphMention) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptGraphEdge) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptLearningHistory) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptMemoryChange) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptPendingWork) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptPendingInput) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptProcessedInput) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptOutbox) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptLearningAttempt) ASSERT node.key IS UNIQUE',
	'CREATE CONSTRAINT ON (node:AdaptGraphEdgeHistory) ASSERT node.key IS UNIQUE',
	'CREATE INDEX ON :AdaptGraphState(key)',
	'CREATE INDEX ON :AdaptGraphState(lens_id)',
	'CREATE INDEX ON :AdaptGraphEntity(key)',
	'CREATE INDEX ON :AdaptGraphEntity(lens_id)',
	'CREATE INDEX ON :AdaptGraphEntity(label)',
	'CREATE INDEX ON :AdaptGraphEntity(entity_type)',
	'CREATE INDEX ON :AdaptGraphMention(key)',
	'CREATE INDEX ON :AdaptGraphMention(lookup_key)',
	'CREATE INDEX ON :AdaptGraphEdge(key)',
	'CREATE INDEX ON :AdaptGraphEdge(lens_id)',
	'CREATE INDEX ON :AdaptPendingWork(key)',
	'CREATE INDEX ON :AdaptPendingWork(lens_id)',
	'CREATE INDEX ON :AdaptPendingInput(key)',
	'CREATE INDEX ON :AdaptProcessedInput(key)',
	'CREATE INDEX ON :AdaptOutbox(key)',
	'CREATE INDEX ON :AdaptOutbox(lens_id)',
	'CREATE INDEX ON :AdaptOutbox(status)',
	'CREATE INDEX ON :AdaptLearningAttempt(key)',
] as const

interface StateValue {
	memoryRevision: number
	configRevision: number
	schema: GraphLensSchema
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson)
	if (value === null || typeof value !== 'object') return value
	const source = value as Record<string, unknown>
	const target = Object.create(null) as Record<string, unknown>
	for (const key of Object.keys(source).sort())
		target[key] = canonicalJson(source[key])
	return target
}

function sameSchema(left: GraphLensSchema, right: GraphLensSchema): boolean {
	return stringify(canonicalJson(left)) === stringify(canonicalJson(right))
}

function graphStructure(schema: GraphLensSchema): unknown {
	return {
		entityTypes: [...schema.entityTypes].sort(),
		relations: schema.relations
			.map((relation) => ({
				id: relation.id,
				sourceEntityTypes: [...relation.sourceEntityTypes].sort(),
				targetEntityTypes: [...relation.targetEntityTypes].sort(),
				directed: relation.directed,
				allowSelf: relation.allowSelf,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
	}
}

function commitIntentDigest(input: GraphCommitInput): string {
	return createHash('sha256')
		.update(stringify(canonicalJson(input)))
		.digest('hex')
}

function normalizeGraphLabel(value: string): string {
	return value.normalize('NFKC').toLocaleLowerCase('en-US').trim()
}

function isAlreadyExists(error: unknown): boolean {
	const message = errorMessage(error).toLocaleLowerCase()
	return message.includes('already exists') || message.includes('equivalent')
}

function recordOrUndefined(
	result: QueryResult,
): Record<string, unknown> | undefined {
	const first = result.records.at(0)
	return first ? nodeProperties(first) : undefined
}

function revisions(
	state: StateValue,
	updatedAt?: string,
): LearningRevisionRecord {
	return {
		id: 'current',
		memory_revision: state.memoryRevision,
		config_revision: state.configRevision,
		updated_at: updatedAt,
	}
}

function workProperties(lensId: string, work: PendingWorkRecord) {
	const inputs = work.inputs?.map(({ id, text }) => ({ id, text }))
	return {
		key: graphKey(lensId, work.id),
		lens_id: lensId,
		id: work.id,
		attempt_id: work.attempt_id,
		input_ids_json: stringify(work.input_ids),
		inputs_json: inputs === undefined ? null : stringify(inputs),
		status: work.status,
		retry_count: work.retry_count,
		available_at: work.available_at,
		last_error: work.last_error ?? null,
		created_at: work.created_at,
		updated_at: work.updated_at,
	}
}

function outboxProperties(lensId: string, record: OutboxRecord) {
	return {
		key: graphKey(lensId, record.id),
		lens_id: lensId,
		id: record.id,
		kind: record.kind,
		deduplication_key: record.deduplication_key,
		change_ids_json: stringify(record.change_ids),
		status: record.status,
		attempts: record.attempts,
		available_at: record.available_at,
		lease_owner: record.lease_owner ?? null,
		lease_token: record.lease_token ?? null,
		lease_expires_at: record.lease_expires_at ?? null,
		last_error: record.last_error ?? null,
		created_at: record.created_at,
		updated_at: record.updated_at,
	}
}

async function stateIn(
	tx: Transaction,
	lensId: string,
): Promise<StateValue | undefined> {
	const result = await tx.run(
		'MATCH (node:AdaptGraphState {key: $key}) RETURN node',
		{ key: graphKey(lensId, 'current') },
	)
	const properties = recordOrUndefined(result)
	if (!properties) return undefined
	if (
		typeof properties.memory_revision !== 'number' ||
		typeof properties.config_revision !== 'number'
	)
		throw new Error('stored graph revisions are invalid')
	return {
		memoryRevision: properties.memory_revision,
		configRevision: properties.config_revision,
		schema: schemaFromProperties(properties),
	}
}

async function withTransaction<T>(
	driver: Driver,
	database: string | undefined,
	timeout: number,
	mode: 'READ' | 'WRITE',
	operation: (transaction: Transaction) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const session = driver.session({
		database,
		defaultAccessMode:
			mode === 'WRITE' ? neo4j.session.WRITE : neo4j.session.READ,
	})
	let transaction: Transaction | undefined
	let primaryError: unknown
	let abortRollback: Promise<void> | undefined
	let rejectAbort: ((reason?: unknown) => void) | undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const abort = () => {
		abortRollback = (async () => {
			try {
				await transaction?.rollback()
			} catch {
				/* cancellation stays primary */
			}
		})()
		rejectAbort?.(signal?.reason ?? new Error('operation aborted'))
	}
	try {
		if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
		transaction = await session.beginTransaction({ timeout })
		signal?.addEventListener('abort', abort, { once: true })
		const result = await (signal
			? Promise.race([operation(transaction), aborted])
			: operation(transaction))
		if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
		await transaction.commit()
		return result
	} catch (error) {
		primaryError = error
		if (transaction) {
			try {
				await (abortRollback ?? transaction.rollback())
			} catch {
				/* preserve the operation error */
			}
		}
		throw error
	} finally {
		signal?.removeEventListener('abort', abort)
		try {
			await session.close()
		} catch (error) {
			// biome-ignore lint/correctness/noUnsafeFinally: a close error must surface when the operation itself succeeded
			if (primaryError === undefined) throw error
		}
	}
}

async function createPending(
	tx: Transaction,
	lensId: string,
	work: PendingWorkRecord,
): Promise<void> {
	await tx.run('CREATE (node:AdaptPendingWork $properties)', {
		properties: workProperties(lensId, work),
	})
	for (const inputId of work.input_ids) {
		const record: PendingInputRecord = {
			id: inputId,
			pending_work_id: work.id,
			attempt_id: work.attempt_id,
			created_at: work.created_at,
		}
		await tx.run('CREATE (node:AdaptPendingInput $properties)', {
			properties: {
				key: graphKey(lensId, inputId),
				lens_id: lensId,
				id: inputId,
				pending_work_id: work.id,
				attempt_id: work.attempt_id,
				created_at: work.created_at,
				record_json: stringify(record),
			},
		})
	}
}

async function validatePatchInTransaction(
	tx: Transaction,
	input: GraphCommitInput,
): Promise<void> {
	const patch = input.patch
	if (!patch) return
	const entityTypes = new Map<string, string>()
	for (const entity of patch.entityUpserts)
		entityTypes.set(entity.id, entity.type)
	const entityIds = new Set([
		...patch.entityUpserts.map(({ id }) => id),
		...patch.edgeChanges.flatMap((change) =>
			change.kind === 'add'
				? [change.edge.sourceEntityId, change.edge.targetEntityId]
				: [change.previous.sourceEntityId, change.previous.targetEntityId],
		),
	])
	if (entityIds.size > 0) {
		const result = await tx.run(
			'MATCH (node:AdaptGraphEntity) WHERE node.key IN $keys RETURN node',
			{ keys: [...entityIds].map((id) => graphKey(input.lensId, id)) },
		)
		for (const record of result.records) {
			const properties = nodeProperties(record)
			if (
				typeof properties.id === 'string' &&
				typeof properties.entity_type === 'string'
			) {
				const supplied = entityTypes.get(properties.id)
				if (supplied && supplied !== properties.entity_type) {
					throw new Error(`entity ${properties.id} cannot change type`)
				}
				entityTypes.set(properties.id, properties.entity_type)
			}
		}
	}
	const relationById = new Map(
		input.schema.relations.map((value) => [value.id, value]),
	)
	for (const change of patch.edgeChanges) {
		const edge = change.kind === 'add' ? change.edge : change.previous
		if (change.kind === 'remove') {
			if (
				change.edgeId !== change.previous.id ||
				stringify(change.history.previous) !== stringify(change.previous)
			) {
				throw new Error(
					`edge removal ${change.edgeId} has inconsistent history`,
				)
			}
		}
		const sourceType = entityTypes.get(edge.sourceEntityId)
		const targetType = entityTypes.get(edge.targetEntityId)
		if (!sourceType || !targetType)
			throw new Error(`edge ${edge.id} has a missing endpoint`)
		const relation = relationById.get(edge.relation)
		if (!relation)
			throw new Error(`edge ${edge.id} uses an undeclared relation`)
		if (
			!relation.sourceEntityTypes.includes(sourceType) ||
			!relation.targetEntityTypes.includes(targetType)
		) {
			throw new Error(`edge ${edge.id} has incompatible endpoint types`)
		}
		if (!relation.allowSelf && edge.sourceEntityId === edge.targetEntityId) {
			throw new Error(`edge ${edge.id} cannot relate an entity to itself`)
		}
		const existing = await tx.run(
			'MATCH (node:AdaptGraphEdge {key: $key}) RETURN node',
			{ key: graphKey(input.lensId, edge.id) },
		)
		const properties = recordOrUndefined(existing)
		if (change.kind === 'add' && properties)
			throw new Error(`edge ${edge.id} already exists`)
		if (change.kind === 'remove') {
			if (!properties || properties.active !== true)
				throw new Error(`edge ${edge.id} is not active`)
			const stored = edgeFromProperties(properties)
			if (stringify(stored) !== stringify(change.previous)) {
				throw new Error(`edge removal ${edge.id} does not match current edge`)
			}
		}
	}
}

async function writeGraphPatch(
	tx: Transaction,
	input: GraphCommitInput,
): Promise<void> {
	const patch = input.patch
	if (!patch) return
	for (const entity of patch.entityUpserts) {
		await tx.run(
			'MATCH (mention:AdaptGraphMention {lens_id: $lens_id, entity_id: $entity_id}) DETACH DELETE mention',
			{ lens_id: input.lensId, entity_id: entity.id },
		)
		await tx.run(
			'MERGE (node:AdaptGraphEntity {key: $key}) SET node.lens_id = $lens_id, node.id = $id, node.entity_type = $entity_type, node.label = $label, node.aliases_json = $aliases_json',
			{
				key: graphKey(input.lensId, entity.id),
				lens_id: input.lensId,
				id: entity.id,
				entity_type: entity.type,
				label: entity.label,
				aliases_json: stringify(entity.aliases),
			},
		)
		for (const value of new Set(
			[entity.label, ...entity.aliases].map(normalizeGraphLabel),
		)) {
			await tx.run(
				'MATCH (entity:AdaptGraphEntity {key: $entity_key}) CREATE (mention:AdaptGraphMention $properties)-[:NAMES]->(entity)',
				{
					entity_key: graphKey(input.lensId, entity.id),
					properties: {
						key: graphKey(
							input.lensId,
							stringify([entity.type, value, entity.id]),
						),
						lookup_key: stringify([input.lensId, entity.type, value]),
						lens_id: input.lensId,
						entity_id: entity.id,
						entity_type: entity.type,
						normalized_label: value,
					},
				},
			)
		}
	}
	for (const change of patch.edgeChanges) {
		if (change.kind === 'remove') {
			await tx.run(
				'MATCH (edge:AdaptGraphEdge {key: $key}) OPTIONAL MATCH ()-[relation:ADAPT_RELATION {key: $key}]->() SET edge.active = false, edge.removed_at = $removed_at DELETE relation',
				{
					key: graphKey(input.lensId, change.edgeId),
					removed_at: change.history.changedAt,
				},
			)
			await tx.run('CREATE (node:AdaptGraphEdgeHistory $properties)', {
				properties: {
					key: graphKey(input.lensId, change.history.changeId),
					lens_id: input.lensId,
					id: change.history.changeId,
					edge_id: change.edgeId,
					record_json: stringify(change.history),
				},
			})
			continue
		}
		const edge = change.edge
		const relationDefinition = input.schema.relations.find(
			({ id }) => id === edge.relation,
		)
		await tx.run(
			'MATCH (source:AdaptGraphEntity {key: $source_key}), (target:AdaptGraphEntity {key: $target_key}) CREATE (edge:AdaptGraphEdge $edge_properties) CREATE (source)-[:ADAPT_RELATION {key: $key, lens_id: $lens_id, id: $id, relation: $relation, directed: $directed, edge_key: $key}]->(target)',
			{
				source_key: graphKey(input.lensId, edge.sourceEntityId),
				target_key: graphKey(input.lensId, edge.targetEntityId),
				key: graphKey(input.lensId, edge.id),
				lens_id: input.lensId,
				id: edge.id,
				relation: edge.relation,
				directed: relationDefinition?.directed !== false,
				edge_properties: {
					key: graphKey(input.lensId, edge.id),
					lens_id: input.lensId,
					id: edge.id,
					relation: edge.relation,
					source_entity_id: edge.sourceEntityId,
					target_entity_id: edge.targetEntityId,
					active: true,
				},
			},
		)
	}
}

export function createMemgraphGraphStore(
	options: MemgraphGraphStoreOptions,
): MemgraphGraphStore {
	validateOptions(options.connection, options.policy)
	const { connection, policy } = options
	const driverConfig = {
		connectionTimeout: connection.connectionTimeoutMs,
		maxConnectionPoolSize: connection.maxConnectionPoolSize,
		disableLosslessIntegers: true,
	}
	const driver =
		connection.username === undefined
			? neo4j.driver(connection.uri, undefined, driverConfig)
			: neo4j.driver(
					connection.uri,
					neo4j.auth.basic(connection.username, connection.password ?? ''),
					driverConfig,
				)
	let closed = false
	const read = <T>(
		operation: (tx: Transaction) => Promise<T>,
		signal?: AbortSignal,
	) => {
		if (closed) throw new Error('Memgraph graph store is closed')
		return withTransaction(
			driver,
			connection.database,
			connection.transactionTimeoutMs,
			'READ',
			operation,
			signal,
		)
	}
	const write = <T>(operation: (tx: Transaction) => Promise<T>) => {
		if (closed) throw new Error('Memgraph graph store is closed')
		return withTransaction(
			driver,
			connection.database,
			connection.transactionTimeoutMs,
			'WRITE',
			operation,
		)
	}

	return {
		async initialize(): Promise<void> {
			if (closed) throw new Error('Memgraph graph store is closed')
			await driver.verifyConnectivity()
			for (const statement of SCHEMA_STATEMENTS) {
				const session = driver.session({ database: connection.database })
				try {
					await session.run(statement)
				} catch (error) {
					if (!isAlreadyExists(error)) throw error
				} finally {
					await session.close()
				}
			}
		},

		async initializeLens(
			input: InitializeGraphLensInput,
		): Promise<InitializeGraphLensResult> {
			input = structuredClone(input)
			validateLensSchema(input.schema, input.lensId)
			requireTimestamp(input.initializedAt, 'initializedAt')
			return write(async (tx) => {
				const current = await stateIn(tx, input.lensId)
				if (current) {
					return sameSchema(current.schema, input.schema)
						? { status: 'existing', revisions: revisions(current) }
						: { status: 'conflict', reason: 'schema' }
				}
				await tx.run('CREATE (node:AdaptGraphState $properties)', {
					properties: {
						key: graphKey(input.lensId, 'current'),
						lens_id: input.lensId,
						id: 'current',
						memory_revision: 0,
						config_revision: 0,
						schema_json: stringify(input.schema),
						updated_at: input.initializedAt,
					},
				})
				return {
					status: 'initialized',
					revisions: revisions(
						{ memoryRevision: 0, configRevision: 0, schema: input.schema },
						input.initializedAt,
					),
				}
			})
		},

		async configureLens(input: ConfigureGraphLensInput) {
			try {
				input = structuredClone(input)
				validateLensSchema(input.schema, input.lensId)
				requireSafeNonnegative(
					input.expectedConfigRevision,
					'expectedConfigRevision',
				)
				requireSafeNonnegative(input.nextConfigRevision, 'nextConfigRevision')
				if (input.nextConfigRevision <= input.expectedConfigRevision)
					throw new Error('nextConfigRevision must increase')
				requireTimestamp(input.updatedAt, 'updatedAt')
				return await write(async (tx) => {
					const current = await stateIn(tx, input.lensId)
					if (!current) throw new Error(`unknown graph lens ${input.lensId}`)
					if (current.configRevision !== input.expectedConfigRevision) {
						return {
							status: 'conflict' as const,
							config_revision: current.configRevision,
						}
					}
					const structureChanged =
						stringify(graphStructure(current.schema)) !==
						stringify(graphStructure(input.schema))
					const compatibilityLimit = policy.maxInspectionRecordsPerNamespace
					const entityTypes = !structureChanged
						? undefined
						: await tx.run(
								'MATCH (node:AdaptGraphEntity {lens_id: $lens_id}) RETURN DISTINCT node.entity_type AS entity_type LIMIT $limit',
								{
									lens_id: input.lensId,
									limit: neo4j.int(compatibilityLimit + 1),
								},
							)
					if (entityTypes && entityTypes.records.length > compatibilityLimit) {
						throw new Error(
							'graph schema compatibility check exceeded its entity limit',
						)
					}
					for (const record of entityTypes?.records ?? []) {
						const entityType = record.get('entity_type') as unknown
						if (
							typeof entityType !== 'string' ||
							!input.schema.entityTypes.includes(entityType)
						) {
							throw new Error(
								'graph schema is incompatible with a stored entity type',
							)
						}
					}
					const storedEdges = !structureChanged
						? undefined
						: await tx.run(
								'MATCH (source:AdaptGraphEntity)-[relation:ADAPT_RELATION]->(target:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, lens_id: $lens_id, active: true}) RETURN edge.relation AS relation, source.id AS source_id, target.id AS target_id, source.entity_type AS source_type, target.entity_type AS target_type, relation.directed AS directed LIMIT $limit',
								{
									lens_id: input.lensId,
									limit: neo4j.int(compatibilityLimit + 1),
								},
							)
					if (storedEdges && storedEdges.records.length > compatibilityLimit) {
						throw new Error(
							'graph schema compatibility check exceeded its edge limit',
						)
					}
					for (const record of storedEdges?.records ?? []) {
						const relationId = record.get('relation') as unknown
						const sourceId = record.get('source_id') as unknown
						const targetId = record.get('target_id') as unknown
						const sourceType = record.get('source_type') as unknown
						const targetType = record.get('target_type') as unknown
						const directed = record.get('directed') as unknown
						const definition =
							typeof relationId === 'string'
								? input.schema.relations.find(({ id }) => id === relationId)
								: undefined
						if (
							definition === undefined ||
							typeof sourceType !== 'string' ||
							typeof targetType !== 'string' ||
							!definition.sourceEntityTypes.includes(sourceType) ||
							!definition.targetEntityTypes.includes(targetType) ||
							(typeof directed === 'boolean' &&
								definition.directed !== directed) ||
							(sourceId === targetId && !definition.allowSelf)
						)
							throw new Error('graph schema is incompatible with a stored edge')
					}
					const result = await tx.run(
						'MATCH (node:AdaptGraphState {key: $key}) WHERE node.config_revision = $expected SET node.config_revision = $next, node.schema_json = $schema_json, node.updated_at = $updated_at RETURN node',
						{
							key: graphKey(input.lensId, 'current'),
							expected: input.expectedConfigRevision,
							next: input.nextConfigRevision,
							schema_json: stringify(input.schema),
							updated_at: input.updatedAt,
						},
					)
					if (result.records.length === 0) {
						const latest = await stateIn(tx, input.lensId)
						return {
							status: 'conflict' as const,
							config_revision: latest?.configRevision ?? current.configRevision,
						}
					}
					return {
						status: 'updated' as const,
						config_revision: input.nextConfigRevision,
					}
				})
			} catch (error) {
				return { status: 'failure' as const, error: errorMessage(error) }
			}
		},

		async getRevisions(lensId: string): Promise<LearningRevisionRecord> {
			return read(async (tx) => {
				const value = await stateIn(tx, lensId)
				if (!value) throw new Error(`unknown graph lens ${lensId}`)
				return revisions(value)
			})
		},

		async enqueue(input) {
			try {
				input = structuredClone(input)
				if (!input.lensId) throw new Error('lensId is required')
				validatePendingWork(input.work)
				if (stringify(input.work).length > policy.maxSerializedCharsPerCommit) {
					throw new Error('pending work serialized character limit exceeded')
				}
				return await write(async (tx) => {
					if (!(await stateIn(tx, input.lensId)))
						throw new Error(`unknown graph lens ${input.lensId}`)
					const attemptResult = await tx.run(
						'MATCH (node:AdaptLearningAttempt {key: $key}) RETURN node',
						{ key: graphKey(input.lensId, input.work.attempt_id) },
					)
					const attemptProperties = recordOrUndefined(attemptResult)
					if (attemptProperties) {
						const attempt = parse<LearningAttemptRecord>(
							attemptProperties.record_json,
						)
						return sameIds(attempt.input_ids, input.work.input_ids)
							? { status: 'deduplicated' as const, attempt_id: attempt.id }
							: {
									status: 'conflict' as const,
									reason: 'attempt-id-reused' as const,
								}
					}
					const existingResult = await tx.run(
						'MATCH (node:AdaptPendingWork) WHERE node.key = $key OR (node.lens_id = $lens_id AND node.attempt_id = $attempt_id) RETURN node',
						{
							key: graphKey(input.lensId, input.work.id),
							lens_id: input.lensId,
							attempt_id: input.work.attempt_id,
						},
					)
					const existingProperties = recordOrUndefined(existingResult)
					if (existingProperties) {
						const existing = pendingWorkFromProperties(existingProperties)
						return existing.attempt_id === input.work.attempt_id &&
							sameIds(existing.input_ids, input.work.input_ids)
							? {
									status: 'deduplicated' as const,
									pending_work_id: existing.id,
								}
							: {
									status: 'conflict' as const,
									reason: 'attempt-id-reused' as const,
								}
					}
					const ownershipKeys = input.work.input_ids.map((id) =>
						graphKey(input.lensId, id),
					)
					const processedOwnership = await tx.run(
						'MATCH (node:AdaptProcessedInput) WHERE node.key IN $keys RETURN node',
						{ keys: ownershipKeys },
					)
					if (
						processedOwnership.records.length === input.work.input_ids.length
					) {
						return { status: 'deduplicated' as const }
					}
					const pendingOwnership = await tx.run(
						'MATCH (node:AdaptPendingInput) WHERE node.key IN $keys RETURN node',
						{ keys: ownershipKeys },
					)
					if (pendingOwnership.records.length === input.work.input_ids.length) {
						const workIds = new Set(
							pendingOwnership.records.map(
								(record) => nodeProperties(record).pending_work_id,
							),
						)
						if (workIds.size === 1) {
							return {
								status: 'deduplicated' as const,
								pending_work_id: [...workIds][0] as string,
							}
						}
					}
					if (
						processedOwnership.records.length > 0 ||
						pendingOwnership.records.length > 0
					) {
						return {
							status: 'conflict' as const,
							reason: 'partial-input-overlap' as const,
						}
					}
					await createPending(tx, input.lensId, input.work)
					return { status: 'queued' as const, pending_work_id: input.work.id }
				})
			} catch (error) {
				return { status: 'failure' as const, error: errorMessage(error) }
			}
		},

		async getPendingWork(lensId, pendingWorkId) {
			return read(async (tx) => {
				const result = await tx.run(
					'MATCH (node:AdaptPendingWork {key: $key}) RETURN node',
					{
						key: graphKey(lensId, pendingWorkId),
					},
				)
				const properties = recordOrUndefined(result)
				return properties ? pendingWorkFromProperties(properties) : undefined
			})
		},

		async commit(input: GraphCommitInput) {
			try {
				input = structuredClone(input)
				validateCommitInput(input, policy)
				return await write(async (tx) => {
					const intentDigest = commitIntentDigest(input)
					const current = await stateIn(tx, input.lensId)
					if (!current) throw new Error(`unknown graph lens ${input.lensId}`)
					const attemptResult = await tx.run(
						'MATCH (node:AdaptLearningAttempt {key: $key}) RETURN node',
						{ key: graphKey(input.lensId, input.logicalAttemptId) },
					)
					const attemptProperties = recordOrUndefined(attemptResult)
					if (attemptProperties) {
						const attempt = parse<LearningAttemptRecord>(
							attemptProperties.record_json,
						)
						if (
							!sameIds(attempt.input_ids, input.inputIds) ||
							attempt.intent_digest !== intentDigest
						) {
							return {
								status: 'conflict' as const,
								reason: 'input-overlap' as const,
								memory_revision: current.memoryRevision,
								config_revision: current.configRevision,
							}
						}
						return {
							status: attempt.status,
							memory_revision: attempt.memory_revision,
							config_revision: attempt.config_revision,
							deduplicated: true,
							remaining_work_id: attempt.remaining_work_id,
						}
					}
					if (current.memoryRevision !== input.expectedMemoryRevision) {
						return {
							status: 'conflict' as const,
							reason: 'memory-revision' as const,
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
						}
					}
					if (
						current.configRevision !== input.expectedConfigRevision ||
						!sameSchema(current.schema, input.schema)
					) {
						return {
							status: 'conflict' as const,
							reason: 'config-revision' as const,
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
						}
					}
					const workResult = await tx.run(
						'MATCH (node:AdaptPendingWork {key: $key}) RETURN node',
						{
							key: graphKey(input.lensId, input.pendingWorkId),
						},
					)
					const workPropertiesValue = recordOrUndefined(workResult)
					const work = workPropertiesValue
						? pendingWorkFromProperties(workPropertiesValue)
						: undefined
					if (
						!work ||
						work.status !== 'pending' ||
						work.attempt_id !== input.logicalAttemptId ||
						!input.inputIds.every((id) => work.input_ids.includes(id))
					) {
						return {
							status: 'conflict' as const,
							reason: 'pending-work' as const,
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
						}
					}
					const ownershipResult = await tx.run(
						'MATCH (node:AdaptPendingInput) WHERE node.key IN $keys RETURN node',
						{ keys: work.input_ids.map((id) => graphKey(input.lensId, id)) },
					)
					const ownershipMatches =
						ownershipResult.records.length === work.input_ids.length &&
						ownershipResult.records.every((record) => {
							const value = nodeProperties(record)
							return (
								value.pending_work_id === work.id &&
								value.attempt_id === work.attempt_id
							)
						})
					if (!ownershipMatches) {
						return {
							status: 'conflict' as const,
							reason: 'pending-work' as const,
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
						}
					}
					const consumed = new Set(input.inputIds)
					const remainder = work.input_ids.filter((id) => !consumed.has(id))
					if (remainder.length === 0 && input.remainingWork)
						throw new Error(
							'remaining work supplied when all inputs are consumed',
						)
					if (
						remainder.length > 0 &&
						(!input.remainingWork ||
							!sameIds(remainder, input.remainingWork.input_ids))
					) {
						throw new Error(
							'remaining work must contain exactly unconsumed input ids',
						)
					}
					const remainingWork =
						input.remainingWork === undefined
							? undefined
							: {
									...input.remainingWork,
									...(work.inputs === undefined
										? {}
										: {
												inputs: work.inputs.filter(({ id }) =>
													remainder.includes(id),
												),
											}),
								}
					if (remainingWork) {
						validatePendingWork(remainingWork)
						if (
							stringify(remainingWork).length >
							policy.maxSerializedCharsPerCommit
						) {
							throw new Error(
								'remaining work serialized character limit exceeded',
							)
						}
					}
					if (input.remainingWork) {
						const collision = await tx.run(
							'MATCH (node) WHERE (node:AdaptPendingWork AND (node.key = $work_key OR (node.lens_id = $lens_id AND node.attempt_id = $attempt_id))) OR (node:AdaptLearningAttempt AND node.key = $attempt_key) RETURN node LIMIT 1',
							{
								work_key: graphKey(input.lensId, input.remainingWork.id),
								lens_id: input.lensId,
								attempt_id: input.remainingWork.attempt_id,
								attempt_key: graphKey(
									input.lensId,
									input.remainingWork.attempt_id,
								),
							},
						)
						if (collision.records.length > 0)
							throw new Error('remaining work id or attempt id already exists')
					}
					const processed = await tx.run(
						'MATCH (node:AdaptProcessedInput) WHERE node.key IN $keys RETURN count(node) AS count',
						{ keys: input.inputIds.map((id) => graphKey(input.lensId, id)) },
					)
					if (processed.records[0]?.get('count') !== 0) {
						return {
							status: 'conflict' as const,
							reason: 'input-overlap' as const,
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
						}
					}
					const suppliedChangeIds = new Set(input.changes.map(({ id }) => id))
					const referencedChangeIds = [
						...new Set(input.outbox.flatMap(({ change_ids }) => change_ids)),
					]
					const existingChanges =
						referencedChangeIds.length === 0
							? new Set<string>()
							: new Set(
									(
										await tx.run(
											'MATCH (node:AdaptMemoryChange) WHERE node.key IN $keys RETURN node.id AS id',
											{
												keys: referencedChangeIds.map((id) =>
													graphKey(input.lensId, id),
												),
											},
										)
									).records.map((record) => record.get('id') as string),
								)
					for (const id of referencedChangeIds) {
						if (!suppliedChangeIds.has(id) && !existingChanges.has(id)) {
							throw new Error(`unknown memory change ${id}`)
						}
					}
					await validatePatchInTransaction(tx, input)
					const nextMemoryRevision =
						input.outcome === 'change'
							? current.memoryRevision + 1
							: current.memoryRevision
					const lock = await tx.run(
						'MATCH (node:AdaptGraphState {key: $key}) WHERE node.memory_revision = $memory_revision AND node.config_revision = $config_revision SET node.memory_revision = $next_memory_revision, node.updated_at = $updated_at RETURN node',
						{
							key: graphKey(input.lensId, 'current'),
							memory_revision: current.memoryRevision,
							config_revision: current.configRevision,
							next_memory_revision: nextMemoryRevision,
							updated_at: input.committedAt,
						},
					)
					if (lock.records.length === 0) {
						const latest = await stateIn(tx, input.lensId)
						return {
							status: 'conflict' as const,
							reason: 'memory-revision' as const,
							memory_revision: latest?.memoryRevision ?? current.memoryRevision,
							config_revision: latest?.configRevision ?? current.configRevision,
						}
					}
					await writeGraphPatch(tx, input)
					await options.onCommitStage?.('after-graph')
					await tx.run('CREATE (node:AdaptLearningHistory $properties)', {
						properties: {
							key: graphKey(input.lensId, input.history.id),
							lens_id: input.lensId,
							id: input.history.id,
							record_json: stringify(input.history),
						},
					})
					for (const record of input.changes)
						await tx.run('CREATE (node:AdaptMemoryChange $properties)', {
							properties: {
								key: graphKey(input.lensId, record.id),
								lens_id: input.lensId,
								id: record.id,
								record_json: stringify(record),
							},
						})
					for (const record of input.outbox) {
						const duplicate = await tx.run(
							'MATCH (node:AdaptOutbox {lens_id: $lens_id, deduplication_key: $deduplication_key}) RETURN node LIMIT 1',
							{
								lens_id: input.lensId,
								deduplication_key: record.deduplication_key,
							},
						)
						if (duplicate.records.length === 0)
							await tx.run('CREATE (node:AdaptOutbox $properties)', {
								properties: outboxProperties(input.lensId, record),
							})
					}
					await options.onCommitStage?.('after-records')
					await tx.run(
						'MATCH (node:AdaptPendingInput) WHERE node.key IN $keys DELETE node',
						{ keys: work.input_ids.map((id) => graphKey(input.lensId, id)) },
					)
					for (const id of input.inputIds) {
						const record = {
							id,
							attempt_id: input.logicalAttemptId,
							outcome: input.outcome,
							memory_revision: nextMemoryRevision,
							processed_at: input.committedAt,
						}
						await tx.run('CREATE (node:AdaptProcessedInput $properties)', {
							properties: {
								key: graphKey(input.lensId, id),
								lens_id: input.lensId,
								id,
								record_json: stringify(record),
							},
						})
					}
					await tx.run(
						'MATCH (node:AdaptPendingWork {key: $key}) DELETE node',
						{ key: graphKey(input.lensId, work.id) },
					)
					if (remainingWork)
						await createPending(tx, input.lensId, remainingWork)
					const attempt: LearningAttemptRecord = {
						id: input.logicalAttemptId,
						pending_work_id: input.pendingWorkId,
						input_ids: [...input.inputIds],
						status: input.outcome === 'change' ? 'committed' : 'no-change',
						memory_revision: nextMemoryRevision,
						config_revision: current.configRevision,
						history_id: input.history.id,
						remaining_work_id: input.remainingWork?.id,
						intent_digest: intentDigest,
						created_at: input.committedAt,
					}
					await tx.run('CREATE (node:AdaptLearningAttempt $properties)', {
						properties: {
							key: graphKey(input.lensId, attempt.id),
							lens_id: input.lensId,
							id: attempt.id,
							record_json: stringify(attempt),
						},
					})
					return {
						status:
							input.outcome === 'change'
								? ('committed' as const)
								: ('no-change' as const),
						memory_revision: nextMemoryRevision,
						config_revision: current.configRevision,
						deduplicated: false,
						remaining_work_id: input.remainingWork?.id,
					}
				})
			} catch (error) {
				return { status: 'failure' as const, error: errorMessage(error) }
			}
		},

		async getLearningContext(
			input: GraphLearningContextRequest,
			readOptions,
		): Promise<GraphLearningContext> {
			return getLearningContext(read, input, policy, readOptions.signal)
		},

		async traverse(
			input: StoredGraphTraversalRequest,
			readOptions,
		): Promise<StoredGraphTraversalResult> {
			return traverseStoredGraph(read, input, policy, readOptions.signal)
		},

		async claimOutbox(input) {
			requireSafeNonnegative(input.limit, 'limit')
			requireTimestamp(input.now, 'now')
			requireTimestamp(input.lease_expires_at, 'lease_expires_at')
			if (
				!input.consumer_id ||
				!input.lease_token ||
				input.lease_expires_at <= input.now
			)
				throw new Error(
					'valid consumer, lease token, and future lease expiry are required',
				)
			return write(async (tx) => {
				const result = await tx.run(
					'MATCH (node:AdaptOutbox {lens_id: $lens_id}) WHERE node.available_at <= $now AND (node.status = $pending OR (node.status = $delivering AND node.lease_expires_at <= $now)) RETURN node ORDER BY node.available_at, node.id LIMIT $limit',
					{
						lens_id: input.lensId,
						now: input.now,
						pending: 'pending',
						delivering: 'delivering',
						limit: neo4j.int(input.limit),
					},
				)
				const records = result.records.map((record) =>
					outboxFromProperties(nodeProperties(record)),
				)
				for (const record of records)
					await tx.run(
						'MATCH (node:AdaptOutbox {key: $key}) SET node.status = $status, node.attempts = node.attempts + 1, node.lease_owner = $owner, node.lease_token = $token, node.lease_expires_at = $expires, node.updated_at = $updated_at RETURN node',
						{
							key: graphKey(input.lensId, record.id),
							status: 'delivering',
							owner: input.consumer_id,
							token: input.lease_token,
							expires: input.lease_expires_at,
							updated_at: input.now,
						},
					)
				return records.map((record) => ({
					...record,
					status: 'delivering' as const,
					attempts: record.attempts + 1,
					lease_owner: input.consumer_id,
					lease_token: input.lease_token,
					lease_expires_at: input.lease_expires_at,
					updated_at: input.now,
				}))
			})
		},

		async settleOutbox(input) {
			requireTimestamp(input.settled_at, 'settled_at')
			if (input.outcome === 'retry') {
				if (!input.retry_at) throw new Error('retry_at is required for retry')
				requireTimestamp(input.retry_at, 'retry_at')
			}
			return write(async (tx) => {
				const found = await tx.run(
					'MATCH (node:AdaptOutbox {key: $key}) RETURN node',
					{ key: graphKey(input.lensId, input.id) },
				)
				const properties = recordOrUndefined(found)
				if (!properties) return undefined
				const current = outboxFromProperties(properties)
				if (
					current.status !== 'delivering' ||
					current.lease_owner !== input.consumer_id ||
					current.lease_token !== input.lease_token
				)
					return undefined
				const next: OutboxRecord =
					input.outcome === 'delivered'
						? {
								...current,
								status: 'delivered',
								lease_owner: undefined,
								lease_token: undefined,
								lease_expires_at: undefined,
								last_error: undefined,
								updated_at: input.settled_at,
							}
						: {
								...current,
								status: 'pending',
								available_at: input.retry_at as string,
								lease_owner: undefined,
								lease_token: undefined,
								lease_expires_at: undefined,
								last_error: input.error,
								updated_at: input.settled_at,
							}
				await tx.run(
					'MATCH (node:AdaptOutbox {key: $key}) SET node.status = $status, node.available_at = $available_at, node.lease_owner = null, node.lease_token = null, node.lease_expires_at = null, node.last_error = $last_error, node.updated_at = $updated_at',
					{
						key: graphKey(input.lensId, input.id),
						status: next.status,
						available_at: next.available_at,
						last_error: next.last_error ?? null,
						updated_at: next.updated_at,
					},
				)
				return next
			})
		},

		async inspect(lensId, limits): Promise<GraphStoreInspection> {
			requirePositive(limits.maxRecordsPerNamespace, 'maxRecordsPerNamespace')
			requirePositive(limits.maxSerializedChars, 'maxSerializedChars')
			if (
				limits.maxRecordsPerNamespace >
					policy.maxInspectionRecordsPerNamespace ||
				limits.maxSerializedChars > policy.maxInspectionChars
			)
				throw new Error('inspection limit exceeds store policy')
			return inspectStore(read, lensId, limits)
		},

		async close(): Promise<void> {
			if (closed) return
			closed = true
			await driver.close()
		},
	}
}

type ReadTransaction = <T>(
	operation: (tx: Transaction) => Promise<T>,
	signal?: AbortSignal,
) => Promise<T>

async function getLearningContext(
	read: ReadTransaction,
	input: GraphLearningContextRequest,
	policy: MemgraphGraphStoreOptions['policy'],
	signal: AbortSignal,
): Promise<GraphLearningContext> {
	input = structuredClone(input)
	requireSafeNonnegative(input.expectedMemoryRevision, 'expectedMemoryRevision')
	requireSafeNonnegative(input.expectedConfigRevision, 'expectedConfigRevision')
	requireUnique(
		input.mentions.map(({ id }) => id),
		'mention ids',
	)
	requireUnique(input.inputIds, 'input ids')
	requirePositive(input.maxEntities, 'maxEntities')
	requirePositive(input.maxEdges, 'maxEdges')
	requirePositive(input.maxSerializedChars, 'maxSerializedChars')
	if (
		input.maxEntities > policy.maxContextEntities ||
		input.maxEdges > policy.maxContextEdges ||
		input.maxSerializedChars > policy.maxContextChars
	)
		throw new Error('learning context limit exceeds store policy')
	return read(async (tx) => {
		const state = await stateIn(tx, input.lensId)
		if (!state) throw new Error(`unknown graph lens ${input.lensId}`)
		if (
			state.memoryRevision !== input.expectedMemoryRevision ||
			state.configRevision !== input.expectedConfigRevision
		)
			throw new Error('graph learning context revision conflict')

		const entities = new Map<string, GraphEntity>()
		const candidatesByType = new Map<
			string,
			{ ids: string[]; complete: boolean }
		>()
		let entityLimitReached = false
		for (const entityType of new Set(
			input.mentions.map(({ entityType }) => entityType),
		)) {
			const remaining = input.maxEntities - entities.size
			if (remaining <= 0) {
				candidatesByType.set(entityType, { ids: [], complete: false })
				entityLimitReached = true
				continue
			}
			const found = await tx.run(
				'MATCH (node:AdaptGraphEntity {lens_id: $lens_id, entity_type: $entity_type}) RETURN node ORDER BY node.id LIMIT $limit',
				{
					lens_id: input.lensId,
					entity_type: entityType,
					limit: neo4j.int(remaining + 1),
				},
			)
			const complete = found.records.length <= remaining
			if (!complete) entityLimitReached = true
			const ids: string[] = []
			for (const record of found.records.slice(0, remaining)) {
				const entity = entityFromProperties(nodeProperties(record))
				entities.set(entity.id, entity)
				ids.push(entity.id)
			}
			candidatesByType.set(entityType, { ids, complete })
		}
		const matches = input.mentions.map((mention) => {
			const candidates = candidatesByType.get(mention.entityType)
			return {
				mentionId: mention.id,
				candidateEntityIds: candidates?.ids ?? [],
				complete: candidates?.complete ?? false,
			}
		})

		const candidateEntityIds = [...entities.keys()]
		const edgeResult =
			candidateEntityIds.length === 0
				? undefined
				: await tx.run(
						'UNWIND $seed_keys AS seed_key MATCH (seed:AdaptGraphEntity {key: seed_key})-[relation:ADAPT_RELATION]-(neighbor:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, active: true}) RETURN DISTINCT edge ORDER BY edge.id LIMIT $limit',
						{
							seed_keys: candidateEntityIds.map((id) =>
								graphKey(input.lensId, id),
							),
							limit: neo4j.int(input.maxEdges + 1),
						},
					)
		const edgeLimitReached = (edgeResult?.records.length ?? 0) > input.maxEdges
		const edges: GraphEdge[] = []
		for (const record of edgeResult?.records.slice(0, input.maxEdges) ?? []) {
			const properties = nodeProperties(record, 'edge')
			const edge = edgeFromProperties(properties)
			let complete = true
			for (const endpointId of [edge.sourceEntityId, edge.targetEntityId]) {
				if (entities.has(endpointId)) continue
				if (entities.size >= input.maxEntities) {
					entityLimitReached = true
					complete = false
					continue
				}
				const endpointResult = await tx.run(
					'MATCH (node:AdaptGraphEntity {key: $key}) RETURN node',
					{ key: graphKey(input.lensId, endpointId) },
				)
				const endpointProperties = recordOrUndefined(endpointResult)
				if (!endpointProperties) {
					complete = false
					continue
				}
				entities.set(endpointId, entityFromProperties(endpointProperties))
			}
			if (complete) edges.push(edge)
		}
		const processedResult =
			input.inputIds.length === 0
				? undefined
				: await tx.run(
						'MATCH (node:AdaptProcessedInput) WHERE node.key IN $keys RETURN node.id AS id ORDER BY node.id',
						{ keys: input.inputIds.map((id) => graphKey(input.lensId, id)) },
					)
		const unknown = new Set<GraphLearningContext['unknownContext'][number]>()
		if (entityLimitReached) unknown.add('entity_limit')
		if (edgeLimitReached) unknown.add('edge_limit')
		let result: GraphLearningContext = {
			lensId: input.lensId,
			memoryRevision: state.memoryRevision,
			configRevision: state.configRevision,
			entities: [...entities.values()],
			edges,
			processedInputIds:
				processedResult?.records.map((record) => record.get('id') as string) ??
				[],
			identityMatches: matches,
			truncated: unknown.size > 0,
			unknownContext: [...unknown],
		}
		if (stringify(result).length > input.maxSerializedChars) {
			unknown.add('serialized_char_limit')
			result = {
				...result,
				entities: [],
				edges: [],
				processedInputIds: [],
				identityMatches: matches.map((match) => ({
					...match,
					candidateEntityIds: [],
					complete: false,
				})),
				truncated: true,
				unknownContext: [...unknown],
			}
		}
		return result
	}, signal)
}

async function traverseStoredGraph(
	read: ReadTransaction,
	input: StoredGraphTraversalRequest,
	policy: MemgraphGraphStoreOptions['policy'],
	signal: AbortSignal,
): Promise<StoredGraphTraversalResult> {
	input = structuredClone(input)
	requirePositive(input.policy.maxDepth, 'maxDepth')
	requirePositive(input.policy.maxEntities, 'maxEntities')
	requirePositive(input.policy.maxEdges, 'maxEdges')
	requirePositive(input.maxSerializedChars, 'maxSerializedChars')
	if (
		input.policy.maxDepth > policy.maxTraversalDepth ||
		input.policy.maxEntities > policy.maxTraversalEntities ||
		input.policy.maxEdges > policy.maxTraversalEdges
	)
		throw new Error('traversal limit exceeds store policy')
	requireUnique(input.startEntityIds, 'start entity ids')
	return read(async (tx) => {
		const startState = await stateIn(tx, input.lensId)
		if (!startState) throw new Error(`unknown graph lens ${input.lensId}`)
		for (const relationId of input.relationIds) {
			if (!startState.schema.relations.some(({ id }) => id === relationId)) {
				throw new Error(`unknown graph relation ${relationId}`)
			}
		}
		const entities = new Map<string, GraphEntity>()
		const edges = new Map<string, GraphEdge>()
		const visited = new Set<string>()
		let frontier = [...input.startEntityIds]
		const unknown = new Set<
			StoredGraphTraversalResult['unknownContext'][number]
		>()

		const adjacentRecords = async (
			frontierIds: readonly string[],
			limit: number,
		) => {
			if (frontierIds.length === 0) return []
			const parameters = {
				frontier_keys: frontierIds.map((id) => graphKey(input.lensId, id)),
				relation_ids: [...input.relationIds],
				selected_keys: [...edges.keys()].map((id) =>
					graphKey(input.lensId, id),
				),
				limit: neo4j.int(limit),
			}
			const directedQuery =
				input.direction === 'outgoing'
					? 'UNWIND $frontier_keys AS seed_key MATCH (seed:AdaptGraphEntity {key: seed_key})-[relation:ADAPT_RELATION]->(neighbor:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, active: true}) WHERE relation.directed = true AND NOT edge.key IN $selected_keys AND (size($relation_ids) = 0 OR edge.relation IN $relation_ids) RETURN DISTINCT edge ORDER BY edge.id LIMIT $limit'
					: input.direction === 'incoming'
						? 'UNWIND $frontier_keys AS seed_key MATCH (seed:AdaptGraphEntity {key: seed_key})<-[relation:ADAPT_RELATION]-(neighbor:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, active: true}) WHERE relation.directed = true AND NOT edge.key IN $selected_keys AND (size($relation_ids) = 0 OR edge.relation IN $relation_ids) RETURN DISTINCT edge ORDER BY edge.id LIMIT $limit'
						: 'UNWIND $frontier_keys AS seed_key MATCH (seed:AdaptGraphEntity {key: seed_key})-[relation:ADAPT_RELATION]-(neighbor:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, active: true}) WHERE relation.directed = true AND NOT edge.key IN $selected_keys AND (size($relation_ids) = 0 OR edge.relation IN $relation_ids) RETURN DISTINCT edge ORDER BY edge.id LIMIT $limit'
			const directedResult = await tx.run(directedQuery, parameters)
			const undirectedResult = await tx.run(
				'UNWIND $frontier_keys AS seed_key MATCH (seed:AdaptGraphEntity {key: seed_key})-[relation:ADAPT_RELATION]-(neighbor:AdaptGraphEntity) MATCH (edge:AdaptGraphEdge {key: relation.edge_key, active: true}) WHERE relation.directed = false AND NOT edge.key IN $selected_keys AND (size($relation_ids) = 0 OR edge.relation IN $relation_ids) RETURN DISTINCT edge ORDER BY edge.id LIMIT $limit',
				parameters,
			)
			const candidates = new Map<
				string,
				(typeof directedResult.records)[number]
			>()
			for (const record of [
				...directedResult.records,
				...undirectedResult.records,
			]) {
				const properties = nodeProperties(record, 'edge')
				if (typeof properties.id === 'string')
					candidates.set(properties.id, record)
			}
			return [...candidates.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, record]) => record)
		}

		for (let depth = 0; frontier.length > 0; depth += 1) {
			const entityResult = await tx.run(
				'MATCH (node:AdaptGraphEntity) WHERE node.key IN $keys RETURN node ORDER BY node.id',
				{ keys: frontier.map((id) => graphKey(input.lensId, id)) },
			)
			if (depth === 0 && entityResult.records.length !== frontier.length) {
				throw new Error('unknown graph start entity')
			}
			const expandableFrontier: string[] = []
			for (const record of entityResult.records) {
				const entity = entityFromProperties(nodeProperties(record))
				if (visited.has(entity.id)) continue
				if (entities.size >= input.policy.maxEntities) {
					unknown.add('entity_limit')
					continue
				}
				entities.set(entity.id, entity)
				visited.add(entity.id)
				expandableFrontier.push(entity.id)
			}
			if (expandableFrontier.length === 0) break
			if (depth >= input.policy.maxDepth) {
				if ((await adjacentRecords(expandableFrontier, 1)).length > 0)
					unknown.add('depth_limit')
				break
			}
			const remainingEdges = input.policy.maxEdges - edges.size
			const relationRecords = await adjacentRecords(
				expandableFrontier,
				Math.max(remainingEdges, 0) + 1,
			)
			if (relationRecords.length > remainingEdges) unknown.add('edge_limit')
			const next: string[] = []
			for (const record of relationRecords.slice(
				0,
				Math.max(remainingEdges, 0),
			)) {
				const edge = edgeFromProperties(nodeProperties(record, 'edge'))
				const relationDefinition = startState.schema.relations.find(
					({ id }) => id === edge.relation,
				)
				const directed = relationDefinition?.directed !== false
				const touchesOutgoing =
					expandableFrontier.includes(edge.sourceEntityId) &&
					(input.direction !== 'incoming' || !directed)
				const touchesIncoming =
					expandableFrontier.includes(edge.targetEntityId) &&
					(input.direction !== 'outgoing' || !directed)
				if (!touchesOutgoing && !touchesIncoming) continue
				edges.set(edge.id, edge)
				if (touchesOutgoing && !visited.has(edge.targetEntityId))
					next.push(edge.targetEntityId)
				if (touchesIncoming && !visited.has(edge.sourceEntityId))
					next.push(edge.sourceEntityId)
			}
			frontier = [...new Set(next)]
		}
		const completeEdges = [...edges.values()].filter(
			({ sourceEntityId, targetEntityId }) =>
				entities.has(sourceEntityId) && entities.has(targetEntityId),
		)
		if (completeEdges.length !== edges.size) unknown.add('entity_limit')
		const endState = await stateIn(tx, input.lensId)
		if (
			!endState ||
			endState.memoryRevision !== startState.memoryRevision ||
			endState.configRevision !== startState.configRevision
		)
			unknown.add('revision_changed')
		let result: StoredGraphTraversalResult = {
			lensId: input.lensId,
			memoryRevision: startState.memoryRevision,
			configRevision: startState.configRevision,
			entities: [...entities.values()],
			edges: completeEdges,
			truncated: unknown.size > 0,
			unknownContext: [...unknown],
		}
		if (stringify(result).length > input.maxSerializedChars) {
			unknown.add('serialized_char_limit')
			result = {
				...result,
				entities: [],
				edges: [],
				truncated: true,
				unknownContext: [...unknown],
			}
		}
		return result
	}, signal)
}

async function inspectStore(
	read: ReadTransaction,
	lensId: string,
	limits: { maxRecordsPerNamespace: number; maxSerializedChars: number },
): Promise<GraphStoreInspection> {
	return read(async (tx) => {
		const state = await stateIn(tx, lensId)
		if (!state) throw new Error(`unknown graph lens ${lensId}`)
		const queryLimit = limits.maxRecordsPerNamespace + 1
		const entityResult = await tx.run(
			'MATCH (node:AdaptGraphEntity {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const entities = entityResult.records
			.slice(0, limits.maxRecordsPerNamespace)
			.map((record) => entityFromProperties(nodeProperties(record)))
		const edgeResult = await tx.run(
			'MATCH (node:AdaptGraphEdge {lens_id: $lens_id, active: true}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const edges = edgeResult.records
			.slice(0, limits.maxRecordsPerNamespace)
			.map((record) => edgeFromProperties(nodeProperties(record)))
		const historyResult = await tx.run(
			'MATCH (node:AdaptLearningHistory {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const changeResult = await tx.run(
			'MATCH (node:AdaptMemoryChange {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const pendingResult = await tx.run(
			'MATCH (node:AdaptPendingWork {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const processedResult = await tx.run(
			'MATCH (node:AdaptProcessedInput {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const outboxResult = await tx.run(
			'MATCH (node:AdaptOutbox {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const edgeHistoryResult = await tx.run(
			'MATCH (node:AdaptGraphEdgeHistory {lens_id: $lens_id}) RETURN node ORDER BY node.id LIMIT $limit',
			{ lens_id: lensId, limit: neo4j.int(queryLimit) },
		)
		const truncated = [
			entityResult,
			edgeResult,
			historyResult,
			changeResult,
			pendingResult,
			processedResult,
			outboxResult,
			edgeHistoryResult,
		].some((value) => value.records.length > limits.maxRecordsPerNamespace)
		const result: GraphStoreInspection = {
			revisions: revisions(state),
			entities,
			edges,
			edgeHistory: edgeHistoryResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => edgeHistoryFromProperties(nodeProperties(record))),
			history: historyResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => historyFromProperties(nodeProperties(record))),
			changes: changeResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => changeFromProperties(nodeProperties(record))),
			pendingWork: pendingResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => pendingWorkFromProperties(nodeProperties(record))),
			processedInputs: processedResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => processedFromProperties(nodeProperties(record))),
			outbox: outboxResult.records
				.slice(0, limits.maxRecordsPerNamespace)
				.map((record) => outboxFromProperties(nodeProperties(record))),
			truncated,
		}
		if (stringify(result).length <= limits.maxSerializedChars) return result
		return {
			revisions: result.revisions,
			entities: [],
			edges: [],
			edgeHistory: [],
			history: [],
			changes: [],
			pendingWork: [],
			processedInputs: [],
			outbox: [],
			truncated: true,
		}
	})
}
