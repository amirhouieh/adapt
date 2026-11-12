import { describe, expect, it } from 'vitest'
import {
	LEARNING_ID_CAPABILITY,
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	planRecipe,
	runRecipe,
	type BudgetClaim,
	type LearningModelCapability,
	type LearningObservation,
} from '../src/learning'
import {
	GRAPH_RELATIONSHIP_RECIPE,
	GRAPH_LEARNING_CONTEXT_CAPABILITY,
	answerGraphRelationship,
	applyGraphPatch,
	commitGraphRecipeResult,
	graphRoot,
	registerGraphLearning,
	traverseGraph,
	validateGraphSnapshot,
	type GraphLearningInput,
	type GraphLearningContextCapability,
	type GraphPatch,
	type GraphSnapshot,
} from '../src/neurons/graph'

const schema = {
	lensId: 'test-lens',
	entityTypes: ['project', 'team'],
	relations: [{
		id: 'depends_on', description: 'A project relies on a team.',
		extractionInstructions: 'The project is source and team is target. Retractions remove; assertions add.',
		sourceEntityTypes: ['project'], targetEntityTypes: ['team'], directed: true, allowSelf: false,
	}],
	identity: { exactNormalizedLabel: 'same' as const, allowModelDeclaredNew: true },
}
const policy = {
	maxObservations: 4, maxObservationChars: 1000, maxExtractedRelations: 8,
	maxIdentityCandidates: 4,
	maxContextEntities: 12, maxContextEdges: 12,
	maxContextCharacters: 12000,
}
const emptySnapshot = (): GraphSnapshot => ({
	lensId: schema.lensId, revision: 0, entities: [], edges: [], edgeHistory: [], processedInputIds: [],
})
const observation = (id: string, text: string): LearningObservation => ({
	id, text, observedAt: '2026-09-30T10:00:00.000Z',
})

function input(snapshot: GraphSnapshot, observations: LearningObservation[], identity = schema.identity): GraphLearningInput {
	return {
		lens: { memoryType: 'graph', schema, purpose: 'test dependencies', developerConstraints: 'use supplied evidence', identityRules: 'exact only when configured' },
		schema: { ...schema, identity }, snapshot, observations, configurationRevision: 3, policy,
		contextMode: 'complete_snapshot',
	}
}

async function execute(
	graphInput: GraphLearningInput,
	model: LearningModelCapability,
	revision = graphInput.snapshot.revision,
	learningContext?: GraphLearningContextCapability,
) {
	const registry = new LearningRegistry()
	registerGraphLearning(registry)
	let sequence = 0
	const values = new Map<string, unknown>([
		[LEARNING_MODEL_CAPABILITY, model],
		[LEARNING_ID_CAPABILITY, { next: (kind: string) => `${kind}-${++sequence}` }],
	])
	if (learningContext !== undefined) {
		values.set(GRAPH_LEARNING_CONTEXT_CAPABILITY, learningContext)
	}
	const claims: BudgetClaim[] = []
	const plan = planRecipe(registry, {
		recipe: GRAPH_RELATIONSHIP_RECIPE, roots: { input: graphRoot(graphInput) }, memoryType: 'graph',
		availableCapabilities: new Set(values.keys()),
		revisions: { memory: revision, configuration: 3, registry: 'tests' },
		limits: { maxNodes: 8, maxCollectionItems: 8, maxOperations: 8 },
	})
	return runRecipe(plan, {
		capabilities: { has: (id) => values.has(id), get: <T>(id: string) => values.get(id) as T | undefined },
		budget: { claim: (claim) => { claims.push(claim); return true }, snapshot: () => ({ claims }) },
		signal: new AbortController().signal,
	})
}

function modelFor(
	candidatesByText: Record<string, unknown[]>,
	decision: LearningModelCapability['decide'] = async () => ({ status: 'abstained', raw: { answer: null } }),
): LearningModelCapability {
	return {
		async generate(request) {
			const prompt = JSON.parse(request.prompt) as { observation: { text: string } }
			const raw = { candidates: candidatesByText[prompt.observation.text] ?? [], overflow: false }
			return { value: request.schema.parse(raw), raw }
		},
		decide: decision,
	}
}

describe('registered Graph relationship learning', () => {
	it('learns distinct projects with one shared target through planRecipe/runRecipe', async () => {
		const a = observation('a', 'ProjectA depends on TeamX.')
		const b = observation('b', 'ProjectB depends on TeamX.')
		const result = await execute(input(emptySnapshot(), [a, b]), modelFor({
			[a.text]: [{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
			[b.text]: [{ action: 'add', source: { label: 'ProjectB', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}))
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		const next = applyGraphPatch(emptySnapshot(), result.result.patch as GraphPatch, schema)
		expect(next.entities.map(({ label }) => label).sort()).toEqual(['ProjectA', 'ProjectB', 'TeamX'])
		expect(next.edges).toHaveLength(2)
		expect(new Set(next.edges.map(({ targetEntityId }) => targetEntityId)).size).toBe(1)
	})

	it('keeps model-declared similar identities distinct and defers an ambiguous identity', async () => {
		const snapshot: GraphSnapshot = {
			...emptySnapshot(), entities: [
				{ id: 'project-a', type: 'project', label: 'ProjectA', aliases: [] },
				{ id: 'team-x', type: 'team', label: 'TeamX', aliases: [] },
			],
		}
		const item = observation('similar', 'Project A is explicitly a separate project from ProjectA. Project A depends on TeamX.')
		const candidates = { [item.text]: [{ action: 'add', source: { label: 'Project A', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }] }
		const distinct = await execute(input(snapshot, [item], { exactNormalizedLabel: 'decision', allowModelDeclaredNew: true }), modelFor(candidates, async (request) => ({
			status: 'answered', answer: request.state && typeof request.state === 'object' && 'mention' in request.state && (request.state.mention as { label: string }).label === 'TeamX' ? 'candidate_1' : 'new_identity_explicitly_established', raw: {},
		})))
		expect(distinct.result.outcome).toBe('change')
		if (distinct.result.outcome === 'change') {
			expect((distinct.result.patch as GraphPatch).entityUpserts.map(({ label }) => label)).toContain('Project A')
		}
		const ambiguous = observation('ambiguous', 'Project A depends on TeamX.')
		const deferred = await execute(input(snapshot, [ambiguous], { exactNormalizedLabel: 'decision', allowModelDeclaredNew: true }), modelFor({
			[ambiguous.text]: [{ action: 'add', source: { label: 'Project A', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}))
		expect(deferred.result).toMatchObject({ outcome: 'defer', pendingInputIds: ['ambiguous'] })
	})

	it('defers every candidate from an input when any endpoint is ambiguous', async () => {
		const snapshot: GraphSnapshot = {
			...emptySnapshot(), entities: [
				{ id: 'project-a', type: 'project', label: 'ProjectA', aliases: [] },
				{ id: 'team-x', type: 'team', label: 'TeamX', aliases: [] },
			],
		}
		const item = observation('partial', 'ProjectA depends on TeamX and Team New.')
		const independent = observation('independent', 'ProjectZ is explicitly distinct and depends on TeamX.')
		const result = await execute(input(snapshot, [item, independent], { exactNormalizedLabel: 'decision', allowModelDeclaredNew: true }), modelFor({
			[item.text]: [
				{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } },
				{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'Team New', entityType: 'team' } },
			],
			[independent.text]: [{ action: 'add', source: { label: 'ProjectZ', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}, async (request) => {
			const label = request.state && typeof request.state === 'object' && 'mention' in request.state
				? (request.state.mention as { label: string }).label : ''
			if (label === 'Team New') return { status: 'abstained', raw: { answer: null } }
			if (label === 'ProjectZ') return { status: 'answered', answer: 'new_identity_explicitly_established', raw: {} }
			return { status: 'answered', answer: 'candidate_1', raw: {} }
		}))
		expect(result.result).toMatchObject({ outcome: 'change', pendingInputIds: ['partial'], consumedInputIds: ['independent'] })
		if (result.result.outcome === 'change') {
			const patch = result.result.patch as GraphPatch
			expect(patch.edgeChanges).toHaveLength(1)
			expect(patch.entityUpserts.map(({ label }) => label)).toContain('ProjectZ')
		}
	})

	it('rejects stale revision pins before any provider call', async () => {
		let calls = 0
		const item = observation('stale', 'ProjectA depends on TeamX.')
		const model = modelFor({})
		const wrapped: LearningModelCapability = { ...model, generate: async (request) => { calls += 1; return model.generate(request) } }
		const result = await execute(input(emptySnapshot(), [item]), wrapped, 1)
		expect(result.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
		expect(calls).toBe(0)
	})

	it('updates a local relation with a large unrelated graph present', async () => {
		const entities = Array.from({ length: 20 }, (_, index) => {
			const id = index < 10 ? `project-${index}` : `team-${index}`
			return { id, type: index < 10 ? 'project' : 'team', label: index === 0 ? 'FocusProject' : index === 10 ? 'FocusTeam' : `Unrelated${index}`, aliases: [] }
		})
		const snapshot: GraphSnapshot = { ...emptySnapshot(), entities }
		const item = observation('large', 'FocusProject depends on FocusTeam.')
		const result = await execute(input(snapshot, [item]), modelFor({
			[item.text]: [{ action: 'add', source: { label: 'FocusProject', entityType: 'project' }, relation: 'depends_on', target: { label: 'FocusTeam', entityType: 'team' } }],
		}))
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		const next = applyGraphPatch(snapshot, result.result.patch as GraphPatch, schema)
		expect(next.entities).toHaveLength(20)
		expect(next.edges).toHaveLength(1)
	})

	it('resolves against one bounded store context with pinned revisions', async () => {
		const seed: GraphSnapshot = { ...emptySnapshot(), revision: 4 }
		const item = observation('stored', 'ProjectA depends on TeamX.')
		const project = { id: 'project-a', type: 'project', label: 'ProjectA', aliases: [] }
		const team = { id: 'team-x', type: 'team', label: 'TeamX', aliases: [] }
		let requests = 0
		const storedContext: GraphLearningContextCapability = {
			async getLearningContext(request) {
				requests += 1
				expect(request).toMatchObject({
					lensId: schema.lensId,
					expectedMemoryRevision: 4,
					expectedConfigRevision: 3,
					maxEntities: policy.maxContextEntities,
				})
				return {
					lensId: schema.lensId, memoryRevision: 4, configRevision: 3,
					entities: [project, team], edges: [], processedInputIds: [],
					identityMatches: request.mentions.map((mention) => ({
						mentionId: mention.id,
						candidateEntityIds: [mention.entityType === 'project' ? project.id : team.id],
						complete: true,
					})),
					truncated: false, unknownContext: [],
				}
			},
		}
		const graphInput = { ...input(seed, [item]), contextMode: 'bounded_store' as const }
		const result = await execute(graphInput, modelFor({
			[item.text]: [{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}), 4, storedContext)
		expect(requests).toBe(1)
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		const patch = result.result.patch as GraphPatch
		expect(patch.expectedRevision).toBe(4)
		expect(patch.entityUpserts).toEqual([])
		expect(patch.edgeChanges).toMatchObject([{ kind: 'add', edge: { sourceEntityId: 'project-a', targetEntityId: 'team-x' } }])
		let committed: unknown
		const commitResult = await commitGraphRecipeResult(
			{
				async commit(value) {
					committed = value
					return { status: 'committed', memory_revision: 5, config_revision: 3, deduplicated: false }
				},
			},
			{
				lensId: schema.lensId,
				schema,
				logicalAttemptId: 'attempt-stored',
				pendingWorkId: 'work-stored',
				expectedMemoryRevision: 4,
				expectedConfigRevision: 3,
				result: result.result,
				history: {
					id: 'history-stored', attempt_id: 'attempt-stored', outcome: 'change',
					previous_memory_revision: 4, memory_revision: 5, config_revision: 3,
					input_ids: ['stored'], change_ids: ['change-stored'],
					created_at: '2026-09-30T12:00:00.000Z',
				},
				changes: [{
					id: 'change-stored', attempt_id: 'attempt-stored', memory_revision: 5,
					kind: 'graph-relation', affected_memory_ids: ['project-a', 'team-x'],
					created_at: '2026-09-30T12:00:00.000Z',
				}],
				outbox: [],
				committedAt: '2026-09-30T12:00:00.000Z',
			},
		)
		expect(commitResult.status).toBe('committed')
		expect(committed).toMatchObject({
			outcome: 'change', expectedMemoryRevision: 4, expectedConfigRevision: 3,
			inputIds: ['stored'],
			patch: { expectedRevision: 4 },
		})
	})

	it('defers bounded store learning when any endpoint context is incomplete', async () => {
		const seed: GraphSnapshot = { ...emptySnapshot(), revision: 4 }
		const item = observation('incomplete-store', 'ProjectA depends on TeamX.')
		const storedContext: GraphLearningContextCapability = {
			async getLearningContext(request) {
				return {
					lensId: schema.lensId, memoryRevision: 4, configRevision: 3,
					entities: [], edges: [], processedInputIds: [],
					identityMatches: request.mentions.map(({ id }) => ({ mentionId: id, candidateEntityIds: [], complete: false })),
					truncated: false, unknownContext: [],
				}
			},
		}
		const graphInput = { ...input(seed, [item]), contextMode: 'bounded_store' as const }
		const result = await execute(graphInput, modelFor({
			[item.text]: [{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}), 4, storedContext)
		expect(result.result).toMatchObject({ outcome: 'defer', pendingInputIds: ['incomplete-store'] })
	})

	it('defers corrections when bounded edge context is unknown', async () => {
		const seed: GraphSnapshot = { ...emptySnapshot(), revision: 4 }
		const item = observation('unknown-edge-store', 'ProjectA no longer depends on TeamX.')
		const project = { id: 'project-a', type: 'project', label: 'ProjectA', aliases: [] }
		const team = { id: 'team-x', type: 'team', label: 'TeamX', aliases: [] }
		const storedContext: GraphLearningContextCapability = {
			async getLearningContext(request) {
				return {
					lensId: schema.lensId, memoryRevision: 4, configRevision: 3,
					entities: [project, team], edges: [], processedInputIds: [],
					identityMatches: request.mentions.map((mention) => ({
						mentionId: mention.id,
						candidateEntityIds: [mention.entityType === 'project' ? project.id : team.id],
						complete: true,
					})),
					truncated: true, unknownContext: ['edge_limit'],
				}
			},
		}
		const graphInput = { ...input(seed, [item]), contextMode: 'bounded_store' as const }
		const result = await execute(graphInput, modelFor({
			[item.text]: [{ action: 'remove', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }],
		}), 4, storedContext)
		expect(result.result).toMatchObject({ outcome: 'defer', pendingInputIds: ['unknown-edge-store'] })
	})

	it('does not coalesce same-label new identities under decision policy', async () => {
		const snapshot: GraphSnapshot = { ...emptySnapshot(), entities: [
			{ id: 'team-x', type: 'team', label: 'TeamX', aliases: [] },
		] }
		const first = observation('shadow-1', 'The first Project Shadow is explicitly distinct and depends on TeamX.')
		const second = observation('shadow-2', 'A separate Project Shadow is explicitly distinct and depends on TeamX.')
		const candidate = (item: LearningObservation) => [{ action: 'add', source: { label: 'Project Shadow', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }]
		const result = await execute(input(snapshot, [first, second], { exactNormalizedLabel: 'decision', allowModelDeclaredNew: true }), modelFor({
			[first.text]: candidate(first), [second.text]: candidate(second),
		}, async (request) => {
			const label = request.state && typeof request.state === 'object' && 'mention' in request.state
				? (request.state.mention as { label: string }).label : ''
			return { status: 'answered', answer: label === 'TeamX' ? 'candidate_1' : 'new_identity_explicitly_established', raw: {} }
		}))
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		expect((result.result.patch as GraphPatch).entityUpserts.filter(({ label }) => label === 'Project Shadow')).toHaveLength(2)
	})

	it('deduplicates repeated edge clauses without copying supplied text into the patch', async () => {
		const item = observation('duplicate', 'ProjectA depends on TeamX. This is the complete supplied observation.')
		const candidate = { action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } }
		const result = await execute(input(emptySnapshot(), [item]), modelFor({ [item.text]: [candidate, candidate] }))
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		const patch = result.result.patch as GraphPatch
		expect(patch.edgeChanges).toHaveLength(1)
		expect(JSON.stringify(patch)).not.toContain(item.text)
	})

	it('records one-observation replacement as learned history without source text', async () => {
		const snapshot: GraphSnapshot = {
			...emptySnapshot(), entities: [
				{ id: 'project-a', type: 'project', label: 'ProjectA', aliases: [] },
				{ id: 'team-x', type: 'team', label: 'TeamX', aliases: [] },
				{ id: 'team-y', type: 'team', label: 'TeamY', aliases: [] },
			], edges: [{ id: 'old-edge', relation: 'depends_on', sourceEntityId: 'project-a', targetEntityId: 'team-x' }],
		}
		const item = observation('correction', 'ProjectA no longer depends on TeamX. ProjectA now depends on TeamY.')
		const result = await execute(input(snapshot, [item]), modelFor({ [item.text]: [
			{ action: 'remove', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamX', entityType: 'team' } },
			{ action: 'add', source: { label: 'ProjectA', entityType: 'project' }, relation: 'depends_on', target: { label: 'TeamY', entityType: 'team' } },
		] }))
		expect(result.result.outcome).toBe('change')
		if (result.result.outcome !== 'change') return
		const patch = result.result.patch as GraphPatch
		const removal = patch.edgeChanges.find(({ kind }) => kind === 'remove')
		expect(removal?.kind === 'remove' ? removal.history : undefined).toMatchObject({ kind: 'replaced' })
		expect(JSON.stringify(patch)).not.toContain(item.text)
	})
})

describe('Graph validation and bounded queries', () => {
	it('rejects missing endpoints, undeclared relations, and conflicting edge ids', () => {
		const invalid = { ...emptySnapshot(), edges: [{ id: 'bad', relation: 'unknown', sourceEntityId: 'missing', targetEntityId: 'also-missing' }] }
		expect(() => validateGraphSnapshot(invalid, schema)).toThrow('missing endpoint')
		const snapshot: GraphSnapshot = { ...emptySnapshot(), entities: [
			{ id: 'p', type: 'project', label: 'P', aliases: [] },
			{ id: 't', type: 'team', label: 'T', aliases: [] },
		], edges: [{ id: 'edge', relation: 'depends_on', sourceEntityId: 'p', targetEntityId: 't' }] }
		expect(() => applyGraphPatch(snapshot, { expectedRevision: 0, entityUpserts: [], edgeChanges: [{ kind: 'add', edge: snapshot.edges[0]! }], pending: [], pendingInputIds: [] }, schema)).toThrow('conflicts')
	})

	it('preserves unrelated edges and records replacement history', () => {
		const p = { id: 'p', type: 'project', label: 'P', aliases: [] }
		const q = { id: 'q', type: 'project', label: 'Q', aliases: [] }
		const x = { id: 'x', type: 'team', label: 'X', aliases: [] }
		const y = { id: 'y', type: 'team', label: 'Y', aliases: [] }
		const old = { id: 'old', relation: 'depends_on', sourceEntityId: 'p', targetEntityId: 'x' }
		const other = { id: 'other', relation: 'depends_on', sourceEntityId: 'q', targetEntityId: 'x' }
		const snapshot: GraphSnapshot = { ...emptySnapshot(), entities: [p, q, x, y], edges: [old, other] }
		const next = applyGraphPatch(snapshot, {
			expectedRevision: 0, entityUpserts: [], pending: [], pendingInputIds: [], edgeChanges: [
				{ kind: 'remove', edgeId: 'old', previous: old, history: { changeId: 'change', kind: 'replaced', previous: old, replacementEdgeId: 'new', changedAt: '2026-09-30T12:00:00.000Z' } },
				{ kind: 'add', edge: { id: 'new', relation: 'depends_on', sourceEntityId: 'p', targetEntityId: 'y' } },
			],
		}, schema)
		expect(next.edges.map(({ id }) => id).sort()).toEqual(['new', 'other'])
		expect(next.entities).toHaveLength(4)
		expect(next.edgeHistory).toHaveLength(1)
	})

	it('handles cycles, undirected traversal, and explicit bounds', () => {
		const undirectedSchema = { ...schema, relations: [{ ...schema.relations[0]!, id: 'connected', sourceEntityTypes: ['project'], targetEntityTypes: ['project'], directed: false }] }
		const entities = ['a', 'b', 'c'].map((id) => ({ id, type: 'project', label: id, aliases: [] }))
		const edges = [
			{ id: 'ab', relation: 'connected', sourceEntityId: 'a', targetEntityId: 'b' },
			{ id: 'bc', relation: 'connected', sourceEntityId: 'b', targetEntityId: 'c' },
			{ id: 'ca', relation: 'connected', sourceEntityId: 'c', targetEntityId: 'a' },
		]
		const snapshot: GraphSnapshot = { ...emptySnapshot(), entities, edges }
		const traversal = traverseGraph(snapshot, undirectedSchema, { startEntityIds: ['b'], relationIds: ['connected'], direction: 'incoming', policy: { maxDepth: 1, maxEntities: 2, maxEdges: 3 } })
		expect(traversal.entities).toHaveLength(2)
		expect(traversal.truncated).toBe(true)
		expect(traversal.unknownContext).toContain('entity_limit')
	})

	it('keeps learned relationships queryable after original input disposal', () => {
		const connectedSchema = { ...schema, relations: [{ ...schema.relations[0]!, id: 'connected', sourceEntityTypes: ['project'], targetEntityTypes: ['project'], directed: false }] }
		const entities = ['a', 'b', 'c'].map((id) => ({ id, type: 'project', label: id, aliases: [] }))
		const snapshot: GraphSnapshot = {
			...emptySnapshot(),
			entities,
			edges: [
				{ id: 'ab', relation: 'connected', sourceEntityId: 'a', targetEntityId: 'b' },
				{ id: 'bc', relation: 'connected', sourceEntityId: 'b', targetEntityId: 'c' },
			],
		}
		const request = {
			startEntityIds: ['a'], relationIds: ['connected'], direction: 'both' as const,
			policy: { maxDepth: 3, maxEntities: 4, maxEdges: 4 },
		}
		const traversal = traverseGraph(snapshot, connectedSchema, request)
		expect(traversal.entities.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
		expect(traversal.edges.map(({ id }) => id)).toEqual(['ab', 'bc'])
		expect(answerGraphRelationship(snapshot, connectedSchema, request).status).toBe('answered')
	})
})
