import { z } from 'zod'
import type { LearningLens, LearningObservation } from '../../learning'

export interface GraphRelationDefinition {
	readonly id: string
	readonly description: string
	readonly extractionInstructions: string
	readonly sourceEntityTypes: readonly string[]
	readonly targetEntityTypes: readonly string[]
	readonly directed: boolean
	readonly allowSelf: boolean
}

export interface GraphLensSchema {
	readonly lensId: string
	readonly entityTypes: readonly string[]
	readonly relations: readonly GraphRelationDefinition[]
	readonly identity: {
		readonly exactNormalizedLabel: 'same' | 'decision'
		readonly allowModelDeclaredNew: boolean
	}
}

export interface GraphEntity {
	readonly id: string
	readonly type: string
	readonly label: string
	readonly aliases: readonly string[]
}

export interface GraphEdge {
	readonly id: string
	readonly relation: string
	readonly sourceEntityId: string
	readonly targetEntityId: string
}

export interface GraphEdgeHistory {
	readonly changeId: string
	readonly kind: 'removed' | 'replaced'
	readonly previous: GraphEdge
	readonly replacementEdgeId?: string
	readonly changedAt: string
}

export interface GraphSnapshot {
	readonly lensId: string
	readonly revision: number
	readonly entities: readonly GraphEntity[]
	readonly edges: readonly GraphEdge[]
	readonly edgeHistory: readonly GraphEdgeHistory[]
	readonly processedInputIds: readonly string[]
}

export interface GraphLearningPolicy {
	readonly maxObservations: number
	readonly maxObservationChars: number
	readonly maxExtractedRelations: number
	readonly maxIdentityCandidates: number
	readonly maxContextEntities: number
	readonly maxContextEdges: number
	readonly maxContextCharacters: number
}

export interface GraphLearningInput {
	readonly lens: LearningLens
	readonly schema: GraphLensSchema
	readonly snapshot: GraphSnapshot
	readonly observations: readonly LearningObservation[]
	readonly configurationRevision: number
	readonly policy: GraphLearningPolicy
	readonly contextMode: 'complete_snapshot' | 'bounded_store'
}

export interface GraphEndpointCandidate {
	readonly label: string
	readonly entityType: string
}

export interface GraphRelationCandidate {
	readonly inputId: string
	readonly action: 'add' | 'remove'
	readonly source: GraphEndpointCandidate
	readonly relation: string
	readonly target: GraphEndpointCandidate
}

export interface GraphCandidateBatch {
	readonly candidates: readonly GraphRelationCandidate[]
	readonly overflow: boolean
	readonly pendingInputIds: readonly string[]
	readonly rawGeneration?: unknown
}

export type GraphResolvedEndpoint =
	| { readonly state: 'existing'; readonly entityId: string }
	| {
			readonly state: 'new'
			readonly label: string
			readonly entityType: string
	  }

export interface GraphResolvedCandidate {
	readonly candidate: GraphRelationCandidate
	readonly source: GraphResolvedEndpoint
	readonly target: GraphResolvedEndpoint
}

export interface GraphPendingCandidate {
	readonly candidate: GraphRelationCandidate
	readonly reason:
		| 'ambiguous_identity'
		| 'identity_context_truncated'
		| 'graph_context_truncated'
	readonly endpoint: 'source' | 'target'
}

export interface GraphIdentityMention {
	readonly id: string
	readonly label: string
	readonly entityType: string
}

export interface GraphLearningContextRequest {
	readonly lensId: string
	readonly expectedMemoryRevision: number
	readonly expectedConfigRevision: number
	readonly mentions: readonly GraphIdentityMention[]
	readonly inputIds: readonly string[]
	readonly maxEntities: number
	readonly maxEdges: number
	readonly maxSerializedChars: number
}

export interface GraphLearningContextResult {
	readonly lensId: string
	readonly memoryRevision: number
	readonly configRevision: number
	readonly entities: readonly GraphEntity[]
	readonly edges: readonly GraphEdge[]
	readonly processedInputIds: readonly string[]
	readonly identityMatches: readonly {
		readonly mentionId: string
		readonly candidateEntityIds: readonly string[]
		readonly complete: boolean
	}[]
	readonly truncated: boolean
	readonly unknownContext: readonly (
		| 'entity_limit'
		| 'edge_limit'
		| 'serialized_char_limit'
	)[]
}

export interface GraphLearningContextCapability {
	getLearningContext(
		request: GraphLearningContextRequest,
		options: { readonly signal: AbortSignal },
	): Promise<GraphLearningContextResult>
}

export const GRAPH_LEARNING_CONTEXT_CAPABILITY = 'adapt.graph.learning-context'

export interface GraphResolvedContext {
	readonly snapshot: GraphSnapshot
	readonly configurationRevision: number
	readonly identityMatches: GraphLearningContextResult['identityMatches']
	readonly truncated: boolean
	readonly unknownContext: GraphLearningContextResult['unknownContext']
}

export interface GraphResolutionBatch {
	readonly resolved: readonly GraphResolvedCandidate[]
	readonly pending: readonly GraphPendingCandidate[]
	readonly overflow: boolean
	readonly pendingInputIds: readonly string[]
	readonly rawDecisions: readonly unknown[]
	readonly rawGeneration?: unknown
	readonly context: GraphResolvedContext
}

export type GraphEdgeChange =
	| { readonly kind: 'add'; readonly edge: GraphEdge }
	| {
			readonly kind: 'remove'
			readonly edgeId: string
			readonly previous: GraphEdge
			readonly history: GraphEdgeHistory
	  }

export interface GraphPatch {
	readonly expectedRevision: number
	readonly entityUpserts: readonly GraphEntity[]
	readonly edgeChanges: readonly GraphEdgeChange[]
	readonly pending: readonly GraphPendingCandidate[]
	readonly pendingInputIds: readonly string[]
}

export interface GraphTraversalPolicy {
	readonly maxDepth: number
	readonly maxEntities: number
	readonly maxEdges: number
}

export interface GraphTraversalRequest {
	readonly startEntityIds: readonly string[]
	readonly relationIds: readonly string[]
	readonly direction: 'outgoing' | 'incoming' | 'both'
	readonly policy: GraphTraversalPolicy
}

export interface GraphTraversalResult {
	readonly entities: readonly GraphEntity[]
	readonly edges: readonly GraphEdge[]
	readonly truncated: boolean
	readonly unknownContext: readonly (
		| 'depth_limit'
		| 'entity_limit'
		| 'edge_limit'
	)[]
}

export type GraphRelationshipAnswer =
	| {
			readonly status: 'answered'
			readonly entityIds: readonly string[]
			readonly edgeIds: readonly string[]
			readonly truncated: boolean
			readonly unknownContext: GraphTraversalResult['unknownContext']
	  }
	| {
			readonly status: 'insufficient_memory'
			readonly truncated: boolean
			readonly unknownContext: GraphTraversalResult['unknownContext']
	  }

export const graphEntitySchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	label: z.string().min(1),
	aliases: z.array(z.string().min(1)),
})

export const graphEdgeSchema = z.object({
	id: z.string().min(1),
	relation: z.string().min(1),
	sourceEntityId: z.string().min(1),
	targetEntityId: z.string().min(1),
})

export const graphEdgeHistorySchema = z.object({
	changeId: z.string().min(1),
	kind: z.enum(['removed', 'replaced']),
	previous: graphEdgeSchema,
	replacementEdgeId: z.string().min(1).optional(),
	changedAt: z.string().min(1),
})

export const graphSnapshotSchema = z.object({
	lensId: z.string().min(1),
	revision: z.number().int().nonnegative(),
	entities: z.array(graphEntitySchema),
	edges: z.array(graphEdgeSchema),
	edgeHistory: z.array(graphEdgeHistorySchema),
	processedInputIds: z.array(z.string().min(1)),
})

export const graphRelationDefinitionSchema = z.object({
	id: z.string().min(1),
	description: z.string().min(1),
	extractionInstructions: z.string().min(1),
	sourceEntityTypes: z.array(z.string().min(1)).min(1),
	targetEntityTypes: z.array(z.string().min(1)).min(1),
	directed: z.boolean(),
	allowSelf: z.boolean(),
})

export const graphLensSchemaSchema = z.object({
	lensId: z.string().min(1),
	entityTypes: z.array(z.string().min(1)).min(1),
	relations: z.array(graphRelationDefinitionSchema).min(1),
	identity: z.object({
		exactNormalizedLabel: z.enum(['same', 'decision']),
		allowModelDeclaredNew: z.boolean(),
	}),
})

export const graphRelationCandidateSchema = z.object({
	inputId: z.string().min(1),
	action: z.enum(['add', 'remove']),
	source: z.object({ label: z.string().min(1), entityType: z.string().min(1) }),
	relation: z.string().min(1),
	target: z.object({ label: z.string().min(1), entityType: z.string().min(1) }),
})

export const graphCandidateBatchSchema = z.object({
	candidates: z.array(graphRelationCandidateSchema),
	overflow: z.boolean(),
	pendingInputIds: z.array(z.string().min(1)),
	rawGeneration: z.unknown().optional(),
})
