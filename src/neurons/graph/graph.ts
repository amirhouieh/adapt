import {
	type GraphEdge,
	type GraphEntity,
	type GraphLensSchema,
	type GraphPatch,
	type GraphRelationshipAnswer,
	type GraphSnapshot,
	type GraphTraversalRequest,
	type GraphTraversalResult,
	graphLensSchemaSchema,
	graphSnapshotSchema,
} from './contracts'

function unique(values: readonly string[], name: string): void {
	if (new Set(values).size !== values.length) {
		throw new Error(`${name} must be unique`)
	}
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`)
	}
}

export function validateGraphSnapshot(
	value: GraphSnapshot,
	schemaValue: GraphLensSchema,
): GraphSnapshot {
	const snapshot = graphSnapshotSchema.parse(value) as GraphSnapshot
	const schema = graphLensSchemaSchema.parse(schemaValue) as GraphLensSchema
	if (snapshot.lensId !== schema.lensId) {
		throw new Error('graph snapshot belongs to a different lens')
	}
	unique(schema.entityTypes, 'graph entity types')
	unique(
		schema.relations.map(({ id }) => id),
		'graph relation ids',
	)
	unique(
		snapshot.entities.map(({ id }) => id),
		'graph entity ids',
	)
	unique(
		snapshot.edges.map(({ id }) => id),
		'graph edge ids',
	)
	unique(
		snapshot.edgeHistory.map(({ changeId }) => changeId),
		'graph history change ids',
	)
	unique(snapshot.processedInputIds, 'processed input ids')

	const entities = new Map(
		snapshot.entities.map((entity) => [entity.id, entity]),
	)
	const relations = new Map(
		schema.relations.map((relation) => [relation.id, relation]),
	)
	for (const entity of snapshot.entities) {
		if (!schema.entityTypes.includes(entity.type)) {
			throw new Error(`entity ${entity.id} uses undeclared type ${entity.type}`)
		}
	}
	for (const edge of snapshot.edges) {
		const source = entities.get(edge.sourceEntityId)
		const target = entities.get(edge.targetEntityId)
		if (!source || !target)
			throw new Error(`edge ${edge.id} has a missing endpoint`)
		const relation = relations.get(edge.relation)
		if (!relation) throw new Error(`edge ${edge.id} uses undeclared relation`)
		if (!relation.sourceEntityTypes.includes(source.type)) {
			throw new Error(`edge ${edge.id} has an invalid source type`)
		}
		if (!relation.targetEntityTypes.includes(target.type)) {
			throw new Error(`edge ${edge.id} has an invalid target type`)
		}
		if (!relation.allowSelf && source.id === target.id) {
			throw new Error(`edge ${edge.id} cannot relate an entity to itself`)
		}
	}
	return snapshot
}

export function applyGraphPatch(
	snapshot: GraphSnapshot,
	patch: GraphPatch,
	schema: GraphLensSchema,
): GraphSnapshot {
	validateGraphSnapshot(snapshot, schema)
	if (patch.expectedRevision !== snapshot.revision) {
		throw new Error('graph patch expected a different memory revision')
	}
	const entities = new Map(
		snapshot.entities.map((entity) => [entity.id, entity]),
	)
	for (const entity of patch.entityUpserts) entities.set(entity.id, entity)
	const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]))
	const history = [...snapshot.edgeHistory]
	for (const change of patch.edgeChanges) {
		if (change.kind === 'add') {
			if (edges.has(change.edge.id)) {
				throw new Error(
					`graph add conflicts with existing edge ${change.edge.id}`,
				)
			}
			edges.set(change.edge.id, change.edge)
			continue
		}
		const current = edges.get(change.edgeId)
		if (
			!current ||
			JSON.stringify(current) !== JSON.stringify(change.previous)
		) {
			throw new Error(
				`graph removal ${change.edgeId} does not match current edge`,
			)
		}
		edges.delete(change.edgeId)
		history.push(change.history)
	}
	return validateGraphSnapshot(
		{
			...snapshot,
			revision: snapshot.revision + 1,
			entities: [...entities.values()],
			edges: [...edges.values()],
			edgeHistory: history,
			processedInputIds: snapshot.processedInputIds,
		},
		schema,
	)
}

function edgeTouches(
	edge: GraphEdge,
	entityId: string,
	direction: GraphTraversalRequest['direction'],
	directed: boolean,
): string | undefined {
	if (!directed) {
		if (edge.sourceEntityId === entityId) return edge.targetEntityId
		if (edge.targetEntityId === entityId) return edge.sourceEntityId
		return undefined
	}
	if (direction !== 'incoming' && edge.sourceEntityId === entityId) {
		return edge.targetEntityId
	}
	if (direction !== 'outgoing' && edge.targetEntityId === entityId) {
		return edge.sourceEntityId
	}
	return undefined
}

export function traverseGraph(
	snapshot: GraphSnapshot,
	schema: GraphLensSchema,
	request: GraphTraversalRequest,
): GraphTraversalResult {
	validateGraphSnapshot(snapshot, schema)
	positiveInteger(request.policy.maxDepth, 'maxDepth')
	positiveInteger(request.policy.maxEntities, 'maxEntities')
	positiveInteger(request.policy.maxEdges, 'maxEdges')
	unique(request.startEntityIds, 'start entity ids')
	const entityById = new Map(
		snapshot.entities.map((entity) => [entity.id, entity]),
	)
	const relationById = new Map(
		schema.relations.map((relation) => [relation.id, relation]),
	)
	for (const id of request.startEntityIds) {
		if (!entityById.has(id)) throw new Error(`unknown graph start entity ${id}`)
	}
	for (const relationId of request.relationIds) {
		if (!schema.relations.some(({ id }) => id === relationId)) {
			throw new Error(`unknown graph relation ${relationId}`)
		}
	}
	const selectedEntities = new Map<string, GraphEntity>()
	const selectedEdges = new Map<string, GraphEdge>()
	const queue = request.startEntityIds.map((id) => ({ id, depth: 0 }))
	const visited = new Set<string>()
	const unknown = new Set<GraphTraversalResult['unknownContext'][number]>()
	let truncated = false
	while (queue.length > 0) {
		const current = queue.shift()
		if (!current || visited.has(current.id)) continue
		visited.add(current.id)
		const entity = entityById.get(current.id)
		if (!entity) continue
		if (selectedEntities.size >= request.policy.maxEntities) {
			truncated = true
			unknown.add('entity_limit')
			break
		}
		selectedEntities.set(entity.id, entity)
		const adjacent = snapshot.edges.filter(
			(edge) =>
				(request.relationIds.length === 0 ||
					request.relationIds.includes(edge.relation)) &&
				edgeTouches(
					edge,
					current.id,
					request.direction,
					relationById.get(edge.relation)?.directed !== false,
				) !== undefined,
		)
		if (current.depth >= request.policy.maxDepth) {
			if (adjacent.some((edge) => !selectedEdges.has(edge.id))) {
				truncated = true
				unknown.add('depth_limit')
			}
			continue
		}
		for (const edge of adjacent) {
			if (!selectedEdges.has(edge.id)) {
				if (selectedEdges.size >= request.policy.maxEdges) {
					truncated = true
					unknown.add('edge_limit')
					break
				}
				selectedEdges.set(edge.id, edge)
			}
			const next = edgeTouches(
				edge,
				current.id,
				request.direction,
				relationById.get(edge.relation)?.directed !== false,
			)
			if (next && !visited.has(next))
				queue.push({ id: next, depth: current.depth + 1 })
		}
	}
	const consistentEdges = [...selectedEdges.values()].filter((edge) => {
		const complete =
			selectedEntities.has(edge.sourceEntityId) &&
			selectedEntities.has(edge.targetEntityId)
		if (!complete) {
			truncated = true
			unknown.add('entity_limit')
		}
		return complete
	})
	return {
		entities: [...selectedEntities.values()],
		edges: consistentEdges,
		truncated,
		unknownContext: [...unknown],
	}
}

export function answerGraphRelationship(
	snapshot: GraphSnapshot,
	schema: GraphLensSchema,
	request: GraphTraversalRequest,
): GraphRelationshipAnswer {
	const traversal = traverseGraph(snapshot, schema, request)
	if (traversal.edges.length === 0) {
		return {
			status: 'insufficient_memory',
			truncated: traversal.truncated,
			unknownContext: traversal.unknownContext,
		}
	}
	return {
		status: 'answered',
		entityIds: traversal.entities.map(({ id }) => id),
		edgeIds: traversal.edges.map(({ id }) => id),
		truncated: traversal.truncated,
		unknownContext: traversal.unknownContext,
	}
}
