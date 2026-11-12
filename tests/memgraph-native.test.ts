import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { commitGraphRecipeResult } from '../src/neurons/graph'
import type {
	GraphEdge,
	GraphLensSchema,
	GraphPatch,
} from '../src/neurons/graph'
import {
	createMemgraphGraphStore,
	type MemgraphGraphStore,
	type MemgraphGraphStoreOptions,
} from '../src/stores/memgraph'
import type {
	LearningHistoryRecord,
	MemoryChangeRecord,
	PendingWorkRecord,
} from '../src/stores/types'

const uri = process.env.ADAPT_MEMGRAPH_URI
const nativeDescribe = uri === undefined ? describe.skip : describe
const stores: MemgraphGraphStore[] = []

function options(
	onCommitStage?: MemgraphGraphStoreOptions['onCommitStage'],
): MemgraphGraphStoreOptions {
	if (uri === undefined) throw new Error('ADAPT_MEMGRAPH_URI is required')
	return {
		connection: {
			uri,
			connectionTimeoutMs: 2_000,
			maxConnectionPoolSize: 2,
			transactionTimeoutMs: 5_000,
		},
		policy: {
			maxRecordsPerCommit: 32,
			maxSerializedCharsPerCommit: 20_000,
			maxContextEntities: 16,
			maxContextEdges: 16,
			maxContextChars: 20_000,
			maxTraversalDepth: 4,
			maxTraversalEntities: 16,
			maxTraversalEdges: 16,
			maxInspectionRecordsPerNamespace: 32,
			maxInspectionChars: 30_000,
		},
		...(onCommitStage === undefined ? {} : { onCommitStage }),
	}
}

function store(onCommitStage?: MemgraphGraphStoreOptions['onCommitStage']): MemgraphGraphStore {
	const value = createMemgraphGraphStore(options(onCommitStage))
	stores.push(value)
	return value
}

function trackedStore(storeOptions: MemgraphGraphStoreOptions): MemgraphGraphStore {
	const value = createMemgraphGraphStore(storeOptions)
	stores.push(value)
	return value
}

function schema(lensId: string): GraphLensSchema {
	return {
		lensId,
		entityTypes: ['project', 'team'],
		relations: [{
			id: 'depends_on',
			description: 'A project currently depends on a team.',
			extractionInstructions: 'Extract explicit current project dependencies.',
			sourceEntityTypes: ['project'],
			targetEntityTypes: ['team'],
			directed: true,
			allowSelf: false,
		}],
		identity: { exactNormalizedLabel: 'decision', allowModelDeclaredNew: true },
	}
}

function pending(
	id: string,
	attemptId: string,
	inputs: PendingWorkRecord['inputs'],
	timestamp: string,
): PendingWorkRecord {
	return {
		id,
		attempt_id: attemptId,
		input_ids: inputs?.map(({ id: inputId }) => inputId) ?? [],
		inputs,
		status: 'pending',
		retry_count: 0,
		available_at: timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
}

function history(
	id: string,
	attemptId: string,
	inputIds: string[],
	previousRevision: number,
	changeIds: string[],
	timestamp: string,
): LearningHistoryRecord {
	return {
		id,
		attempt_id: attemptId,
		outcome: 'change',
		previous_memory_revision: previousRevision,
		memory_revision: previousRevision + 1,
		config_revision: 0,
		input_ids: inputIds,
		change_ids: changeIds,
		created_at: timestamp,
	}
}

function memoryChange(
	id: string,
	attemptId: string,
	memoryRevision: number,
	affectedMemoryIds: string[],
	timestamp: string,
): MemoryChangeRecord {
	return {
		id,
		attempt_id: attemptId,
		memory_revision: memoryRevision,
		kind: 'graph-update',
		affected_memory_ids: affectedMemoryIds,
		created_at: timestamp,
	}
}

const timestamp = '2026-09-30T20:00:00.000Z'

async function initialize(value: MemgraphGraphStore, lensId: string): Promise<GraphLensSchema> {
	await value.initialize()
	const graphSchema = schema(lensId)
	await expect(value.initializeLens({ lensId, schema: graphSchema, initializedAt: timestamp }))
		.resolves.toMatchObject({ status: 'initialized' })
	return graphSchema
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map((value) => value.close()))
})

nativeDescribe('Memgraph graph learning store', () => {
	it('disposes settled text, transfers only residual text, and keeps learned corrections queryable', async () => {
		const value = store()
		const lensId = `native-${randomUUID()}`
		const graphSchema = await initialize(value, lensId)
		const attemptOne = 'attempt-1'
		const workOne = pending('work-1', attemptOne, [
			{ id: 'input-1', text: 'Project Atlas depends on Team Y.' },
			{ id: 'input-2', text: 'Correction: Atlas depends on Team Z, not Team Y.' },
		], timestamp)
		await expect(value.enqueue({ lensId, work: workOne })).resolves.toMatchObject({ status: 'queued' })

		const atlas = { id: 'project-atlas', type: 'project', label: 'Atlas', aliases: [] }
		const teamY = { id: 'team-y', type: 'team', label: 'Team Y', aliases: [] }
		const edgeY: GraphEdge = {
			id: 'atlas-team-y', relation: 'depends_on',
			sourceEntityId: atlas.id, targetEntityId: teamY.id,
		}
		const firstPatch: GraphPatch = {
			expectedRevision: 0,
			entityUpserts: [atlas, teamY],
			edgeChanges: [{ kind: 'add', edge: edgeY }],
			pending: [],
			pendingInputIds: ['input-2'],
		}
		const firstChange = memoryChange('change-1', attemptOne, 1, [atlas.id, teamY.id, edgeY.id], timestamp)
		const firstInput = {
			lensId,
			schema: graphSchema,
			logicalAttemptId: attemptOne,
			pendingWorkId: workOne.id,
			expectedMemoryRevision: 0,
			expectedConfigRevision: 0,
			result: {
				outcome: 'change' as const,
				patch: firstPatch,
				expectedMemoryRevision: 0,
				expectedConfigurationRevision: 0,
				consumedInputIds: ['input-1'],
				pendingInputIds: ['input-2'],
			},
			remainingWork: {
				id: 'work-2', attempt_id: 'attempt-2', input_ids: ['input-2'],
				status: 'pending' as const, retry_count: 0,
				available_at: timestamp, created_at: timestamp, updated_at: timestamp,
			},
			history: history('history-1', attemptOne, ['input-1'], 0, [firstChange.id], timestamp),
			changes: [firstChange],
			outbox: [],
			committedAt: timestamp,
		}
		await expect(commitGraphRecipeResult(value, firstInput)).resolves.toMatchObject({
			status: 'committed', memory_revision: 1, remaining_work_id: 'work-2',
		})
		await expect(commitGraphRecipeResult(value, firstInput)).resolves.toMatchObject({
			status: 'committed', deduplicated: true,
		})

		const residual = await value.getPendingWork(lensId, 'work-2')
		expect(residual?.inputs).toEqual([{ id: 'input-2', text: 'Correction: Atlas depends on Team Z, not Team Y.' }])
		expect(JSON.stringify(residual)).not.toContain('Project Atlas depends on Team Y.')
		const initialTraversal = await value.traverse({
			lensId, startEntityIds: [atlas.id], relationIds: ['depends_on'],
			direction: 'outgoing', policy: { maxDepth: 2, maxEntities: 8, maxEdges: 8 },
			maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(initialTraversal.edges).toEqual([edgeY])
		expect(JSON.stringify(initialTraversal)).not.toContain('Project Atlas depends on Team Y.')

		const context = await value.getLearningContext({
			lensId, expectedMemoryRevision: 1, expectedConfigRevision: 0,
			mentions: [{ id: 'mention-atlas', label: 'Atlas', entityType: 'project' }],
			inputIds: ['input-1', 'input-2'], maxEntities: 8, maxEdges: 8,
			maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(context.identityMatches).toEqual([{
			mentionId: 'mention-atlas', candidateEntityIds: [atlas.id], complete: true,
		}])
		expect(context.processedInputIds).toEqual(['input-1'])
		expect(context.edges).toEqual([edgeY])

		const teamZ = { id: 'team-z', type: 'team', label: 'Team Z', aliases: [] }
		const edgeZ: GraphEdge = {
			id: 'atlas-team-z', relation: 'depends_on',
			sourceEntityId: atlas.id, targetEntityId: teamZ.id,
		}
		const secondPatch: GraphPatch = {
			expectedRevision: 1,
			entityUpserts: [teamZ],
			edgeChanges: [
				{
					kind: 'remove', edgeId: edgeY.id, previous: edgeY,
					history: {
						changeId: 'edge-history-1', kind: 'replaced', previous: edgeY,
						replacementEdgeId: edgeZ.id, changedAt: timestamp,
					},
				},
				{ kind: 'add', edge: edgeZ },
			],
			pending: [], pendingInputIds: [],
		}
		const secondChange = memoryChange('change-2', 'attempt-2', 2, [edgeY.id, teamZ.id, edgeZ.id], timestamp)
		await expect(commitGraphRecipeResult(value, {
			lensId, schema: graphSchema, logicalAttemptId: 'attempt-2', pendingWorkId: 'work-2',
			expectedMemoryRevision: 1, expectedConfigRevision: 0,
			result: {
				outcome: 'change', patch: secondPatch,
				expectedMemoryRevision: 1, expectedConfigurationRevision: 0,
				consumedInputIds: ['input-2'], pendingInputIds: [],
			},
			history: history('history-2', 'attempt-2', ['input-2'], 1, [secondChange.id], timestamp),
			changes: [secondChange], outbox: [], committedAt: timestamp,
		})).resolves.toMatchObject({ status: 'committed', memory_revision: 2 })

		const finalInspection = await value.inspect(lensId, {
			maxRecordsPerNamespace: 32, maxSerializedChars: 30_000,
		})
		expect(finalInspection.pendingWork).toEqual([])
		expect(finalInspection.edgeHistory).toEqual([secondPatch.edgeChanges[0].history])
		expect(finalInspection.edges).toEqual([edgeZ])
		expect(JSON.stringify(finalInspection)).not.toContain('Correction: Atlas depends on Team Z')
		const finalTraversal = await value.traverse({
			lensId, startEntityIds: [atlas.id], relationIds: ['depends_on'],
			direction: 'outgoing', policy: { maxDepth: 2, maxEntities: 8, maxEdges: 8 },
			maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(finalTraversal.edges).toEqual([edgeZ])
		expect(finalTraversal.entities.map(({ id }) => id).sort()).toEqual([atlas.id, teamZ.id].sort())
		const finalContext = await value.getLearningContext({
			lensId, expectedMemoryRevision: 2, expectedConfigRevision: 0,
			mentions: [{ id: 'mention-team-z', label: 'Team Z', entityType: 'team' }],
			inputIds: ['input-1', 'input-2'], maxEntities: 8, maxEdges: 8,
			maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(finalContext.identityMatches).toEqual([{
			mentionId: 'mention-team-z', candidateEntityIds: [teamY.id, teamZ.id], complete: true,
		}])

		const reorderedSchema: GraphLensSchema = {
			relations: graphSchema.relations,
			identity: graphSchema.identity,
			entityTypes: graphSchema.entityTypes,
			lensId,
		}
		await expect(value.initializeLens({ lensId, schema: reorderedSchema, initializedAt: timestamp }))
			.resolves.toMatchObject({ status: 'existing' })
		await expect(value.initializeLens({
			lensId,
			schema: { ...graphSchema, entityTypes: ['project', 'team', 'service'] },
			initializedAt: timestamp,
		})).resolves.toEqual({ status: 'conflict', reason: 'schema' })

		const configuredSchema = structuredClone(graphSchema)
		const configuredRelation = configuredSchema.relations[0] as { description: string }
		configuredRelation.description = 'An updated description of the same learned relation.'
		const configure = value.configureLens({
			lensId, expectedConfigRevision: 0, nextConfigRevision: 1,
			schema: configuredSchema, updatedAt: timestamp,
		})
		configuredRelation.description = 'caller mutation after configure started'
		await expect(configure).resolves.toEqual({ status: 'updated', config_revision: 1 })
		await expect(value.initializeLens({
			lensId,
			schema: {
				...graphSchema,
				relations: [{
					...graphSchema.relations[0],
					description: 'An updated description of the same learned relation.',
				}],
			},
			initializedAt: timestamp,
		})).resolves.toMatchObject({ status: 'existing' })
		await expect(value.configureLens({
			lensId, expectedConfigRevision: 1, nextConfigRevision: 2,
			schema: {
				...graphSchema,
				relations: [{ ...graphSchema.relations[0], directed: false }],
			},
			updatedAt: timestamp,
		})).resolves.toMatchObject({ status: 'failure' })
		await expect(value.getRevisions(lensId)).resolves.toMatchObject({ config_revision: 1 })
	}, 15_000)

	it('snapshots mutable writes and traverses undirected and bounded learned edges honestly', async () => {
		const value = store()
		const lensId = `bounds-${randomUUID()}`
		const graphSchema: GraphLensSchema = {
			lensId,
			entityTypes: ['node'],
			relations: [
				{
					id: 'related', description: 'Two nodes are related.',
					extractionInstructions: 'Extract explicit symmetric relations.',
					sourceEntityTypes: ['node'], targetEntityTypes: ['node'],
					directed: false, allowSelf: false,
				},
				{
					id: 'flows', description: 'A directed node flow.',
					extractionInstructions: 'Extract explicit directed flows.',
					sourceEntityTypes: ['node'], targetEntityTypes: ['node'],
					directed: true, allowSelf: false,
				},
			],
			identity: { exactNormalizedLabel: 'same', allowModelDeclaredNew: true },
		}
		await value.initialize()
		await value.initializeLens({ lensId, schema: graphSchema, initializedAt: timestamp })
		const work = pending('bounds-work', 'bounds-attempt', [
			{ id: 'bounds-input', text: 'A is related to B; A flows to B and C; C flows to E.' },
		], timestamp)
		const originalText = work.inputs?.[0]?.text
		const enqueue = value.enqueue({ lensId, work })
		if (work.inputs) work.inputs[0].text = 'caller mutation after enqueue started'
		await expect(enqueue).resolves.toMatchObject({ status: 'queued' })
		await expect(value.getPendingWork(lensId, work.id)).resolves.toMatchObject({
			inputs: [{ id: 'bounds-input', text: originalText }],
		})

		const nodes = ['a', 'b', 'c', 'e'].map((id) => ({ id, type: 'node', label: id.toUpperCase(), aliases: [] }))
		const related: GraphEdge = { id: 'related-a-b', relation: 'related', sourceEntityId: 'a', targetEntityId: 'b' }
		const flows: GraphEdge[] = [
			{ id: 'flow-1-a-b', relation: 'flows', sourceEntityId: 'a', targetEntityId: 'b' },
			{ id: 'flow-2-a-c', relation: 'flows', sourceEntityId: 'a', targetEntityId: 'c' },
			{ id: 'flow-3-c-e', relation: 'flows', sourceEntityId: 'c', targetEntityId: 'e' },
		]
		const patch: GraphPatch = {
			expectedRevision: 0, entityUpserts: nodes,
			edgeChanges: [related, ...flows].map((edge) => ({ kind: 'add' as const, edge })),
			pending: [], pendingInputIds: [],
		}
		const change = memoryChange('bounds-change', work.attempt_id, 1, [...nodes.map(({ id }) => id), related.id, ...flows.map(({ id }) => id)], timestamp)
		const commitInput = {
			lensId, schema: graphSchema, logicalAttemptId: work.attempt_id,
			pendingWorkId: work.id, expectedMemoryRevision: 0, expectedConfigRevision: 0,
			result: {
				outcome: 'change' as const, patch,
				expectedMemoryRevision: 0, expectedConfigurationRevision: 0,
				consumedInputIds: ['bounds-input'], pendingInputIds: [],
			},
			history: history('bounds-history', work.attempt_id, ['bounds-input'], 0, [change.id], timestamp),
			changes: [change], outbox: [], committedAt: timestamp,
		}
		const commit = commitGraphRecipeResult(value, commitInput)
		;(nodes[0] as { label: string }).label = 'caller mutation after commit started'
		await expect(commit).resolves.toMatchObject({ status: 'committed' })
		const inspection = await value.inspect(lensId, { maxRecordsPerNamespace: 32, maxSerializedChars: 30_000 })
		expect(inspection.entities.find(({ id }) => id === 'a')?.label).toBe('A')
		expect(JSON.stringify(inspection)).not.toContain(originalText)

		const undirected = await value.traverse({
			lensId, startEntityIds: ['a'], relationIds: ['related'], direction: 'both',
			policy: { maxDepth: 1, maxEntities: 8, maxEdges: 8 }, maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(undirected.edges).toEqual([related])
		expect(undirected.truncated).toBe(false)
		expect(undirected.unknownContext).not.toContain('depth_limit')

		const bounded = await value.traverse({
			lensId, startEntityIds: ['a'], relationIds: ['flows'], direction: 'outgoing',
			policy: { maxDepth: 3, maxEntities: 2, maxEdges: 8 }, maxSerializedChars: 10_000,
		}, { signal: new AbortController().signal })
		expect(bounded.unknownContext).toContain('entity_limit')
		expect(bounded.edges.map(({ id }) => id)).toEqual(['flow-1-a-b'])
		expect(bounded.edges.some(({ id }) => id === 'flow-3-c-e')).toBe(false)
	})

	it('allows metadata-only schema updates and rejects a self-loop incompatibility', async () => {
		const baseOptions = options()
		const value = trackedStore({
			...baseOptions,
			policy: { ...baseOptions.policy, maxInspectionRecordsPerNamespace: 1 },
		})
		const lensId = `schema-${randomUUID()}`
		const graphSchema: GraphLensSchema = {
			lensId,
			entityTypes: ['node'],
			relations: [{
				id: 'references', description: 'A node can reference itself.',
				extractionInstructions: 'Extract explicit references.',
				sourceEntityTypes: ['node'], targetEntityTypes: ['node'],
				directed: true, allowSelf: true,
			}],
			identity: { exactNormalizedLabel: 'same', allowModelDeclaredNew: true },
		}
		await value.initialize()
		await value.initializeLens({ lensId, schema: graphSchema, initializedAt: timestamp })
		const work = pending('schema-work', 'schema-attempt', [
			{ id: 'schema-input', text: 'Node A references itself and Node B exists.' },
		], timestamp)
		await value.enqueue({ lensId, work })
		const entities = [
			{ id: 'node-a', type: 'node', label: 'A', aliases: [] },
			{ id: 'node-b', type: 'node', label: 'B', aliases: [] },
		]
		const selfEdge: GraphEdge = {
			id: 'self-edge', relation: 'references',
			sourceEntityId: 'node-a', targetEntityId: 'node-a',
		}
		const patch: GraphPatch = {
			expectedRevision: 0, entityUpserts: entities,
			edgeChanges: [{ kind: 'add', edge: selfEdge }], pending: [], pendingInputIds: [],
		}
		const change = memoryChange('schema-change', work.attempt_id, 1, ['node-a', 'node-b', selfEdge.id], timestamp)
		await commitGraphRecipeResult(value, {
			lensId, schema: graphSchema, logicalAttemptId: work.attempt_id,
			pendingWorkId: work.id, expectedMemoryRevision: 0, expectedConfigRevision: 0,
			result: {
				outcome: 'change', patch, expectedMemoryRevision: 0,
				expectedConfigurationRevision: 0, consumedInputIds: ['schema-input'], pendingInputIds: [],
			},
			history: history('schema-history', work.attempt_id, ['schema-input'], 0, [change.id], timestamp),
			changes: [change], outbox: [], committedAt: timestamp,
		})

		const metadataOnly: GraphLensSchema = {
			...graphSchema,
			relations: [{
				...graphSchema.relations[0],
				description: 'Updated relation documentation.',
				extractionInstructions: 'Updated extraction guidance.',
			}],
		}
		await expect(value.configureLens({
			lensId, expectedConfigRevision: 0, nextConfigRevision: 1,
			schema: metadataOnly, updatedAt: timestamp,
		})).resolves.toEqual({ status: 'updated', config_revision: 1 })
		await expect(value.configureLens({
			lensId, expectedConfigRevision: 1, nextConfigRevision: 2,
			schema: {
				...metadataOnly,
				relations: [{ ...metadataOnly.relations[0], allowSelf: false }],
			},
			updatedAt: timestamp,
		})).resolves.toMatchObject({ status: 'failure' })
		await expect(value.getRevisions(lensId)).resolves.toMatchObject({ config_revision: 1 })
	})

	it('rolls back graph writes and preserves pending text when a commit stage fails', async () => {
		const lensId = `rollback-${randomUUID()}`
		const injected = new Error('injected commit failure')
		const failing = store((stage) => {
			if (stage === 'after-graph') throw injected
		})
		const graphSchema = await initialize(failing, lensId)
		const work = pending('rollback-work', 'rollback-attempt', [
			{ id: 'rollback-input', text: 'Project Delta depends on Team Q.' },
		], timestamp)
		await failing.enqueue({ lensId, work })
		const delta = { id: 'project-delta', type: 'project', label: 'Delta', aliases: [] }
		const teamQ = { id: 'team-q', type: 'team', label: 'Team Q', aliases: [] }
		const edge: GraphEdge = {
			id: 'delta-team-q', relation: 'depends_on',
			sourceEntityId: delta.id, targetEntityId: teamQ.id,
		}
		const patch: GraphPatch = {
			expectedRevision: 0, entityUpserts: [delta, teamQ],
			edgeChanges: [{ kind: 'add', edge }], pending: [], pendingInputIds: [],
		}
		const change = memoryChange('rollback-change', work.attempt_id, 1, [delta.id, teamQ.id, edge.id], timestamp)
		const commit = {
			lensId, schema: graphSchema, logicalAttemptId: work.attempt_id,
			pendingWorkId: work.id, expectedMemoryRevision: 0, expectedConfigRevision: 0,
			result: {
				outcome: 'change' as const, patch,
				expectedMemoryRevision: 0, expectedConfigurationRevision: 0,
				consumedInputIds: ['rollback-input'], pendingInputIds: [],
			},
			history: history('rollback-history', work.attempt_id, ['rollback-input'], 0, [change.id], timestamp),
			changes: [change], outbox: [], committedAt: timestamp,
		}
		await expect(commitGraphRecipeResult(failing, commit)).resolves.toEqual({
			status: 'failure', error: injected.message,
		})
		await expect(failing.getRevisions(lensId)).resolves.toMatchObject({ memory_revision: 0 })
		await expect(failing.getPendingWork(lensId, work.id)).resolves.toMatchObject({ inputs: work.inputs })
		await expect(failing.inspect(lensId, {
			maxRecordsPerNamespace: 32, maxSerializedChars: 30_000,
		})).resolves.toMatchObject({ entities: [], edges: [], history: [], changes: [] })
		await failing.close()

		const retry = store()
		await retry.initialize()
		await expect(commitGraphRecipeResult(retry, commit)).resolves.toMatchObject({
			status: 'committed', memory_revision: 1,
		})
		await expect(retry.getPendingWork(lensId, work.id)).resolves.toBeUndefined()
	})
})
