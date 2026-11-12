import type {
	GraphEdge,
	GraphEdgeHistory,
	GraphEntity,
	GraphLensSchema,
	GraphPatch,
	GraphTraversalRequest,
} from '../../neurons/graph'
import type {
	ClaimOutboxInput,
	EnqueueLearningWorkResult,
	LearningCommitResult,
	LearningHistoryRecord,
	LearningRevisionRecord,
	MemoryChangeRecord,
	OutboxRecord,
	PendingWorkContinuation,
	PendingWorkRecord,
	ProcessedInputRecord,
	SettleOutboxInput,
	UpdateLearningConfigRevisionResult,
} from '../types'

export interface MemgraphConnectionConfig {
	readonly uri: string
	readonly username?: string
	readonly password?: string
	readonly database?: string
	readonly connectionTimeoutMs: number
	readonly maxConnectionPoolSize: number
	readonly transactionTimeoutMs: number
}

export interface MemgraphStorePolicy {
	readonly maxRecordsPerCommit: number
	readonly maxSerializedCharsPerCommit: number
	readonly maxContextEntities: number
	readonly maxContextEdges: number
	readonly maxContextChars: number
	readonly maxTraversalDepth: number
	readonly maxTraversalEntities: number
	readonly maxTraversalEdges: number
	readonly maxInspectionRecordsPerNamespace: number
	readonly maxInspectionChars: number
}

export type MemgraphCommitStage = 'after-graph' | 'after-records'

export interface MemgraphGraphStoreOptions {
	readonly connection: MemgraphConnectionConfig
	readonly policy: MemgraphStorePolicy
	readonly onCommitStage?: (stage: MemgraphCommitStage) => void | Promise<void>
}

export interface InitializeGraphLensInput {
	readonly lensId: string
	readonly schema: GraphLensSchema
	readonly initializedAt: string
}

export type InitializeGraphLensResult =
	| {
			readonly status: 'initialized'
			readonly revisions: LearningRevisionRecord
	  }
	| { readonly status: 'existing'; readonly revisions: LearningRevisionRecord }
	| { readonly status: 'conflict'; readonly reason: 'schema' }

export interface ConfigureGraphLensInput {
	readonly lensId: string
	readonly expectedConfigRevision: number
	readonly nextConfigRevision: number
	readonly schema: GraphLensSchema
	readonly updatedAt: string
}

export interface GraphEnqueueInput {
	readonly lensId: string
	readonly work: PendingWorkRecord
}

export interface GraphCommitInput {
	readonly lensId: string
	readonly schema: GraphLensSchema
	readonly logicalAttemptId: string
	readonly pendingWorkId: string
	readonly expectedMemoryRevision: number
	readonly expectedConfigRevision: number
	readonly inputIds: readonly string[]
	readonly remainingWork?: PendingWorkContinuation
	readonly outcome: 'change' | 'no-change'
	readonly patch?: GraphPatch
	readonly history: LearningHistoryRecord
	readonly changes: readonly MemoryChangeRecord[]
	readonly outbox: readonly OutboxRecord[]
	readonly committedAt: string
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

export interface GraphLearningContext {
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

export interface StoredGraphTraversalRequest extends GraphTraversalRequest {
	readonly lensId: string
	readonly maxSerializedChars: number
}

export interface GraphReadOptions {
	readonly signal: AbortSignal
}

export interface GraphInspectionLimits {
	readonly maxRecordsPerNamespace: number
	readonly maxSerializedChars: number
}

export interface StoredGraphTraversalResult {
	readonly lensId: string
	readonly memoryRevision: number
	readonly configRevision: number
	readonly entities: readonly GraphEntity[]
	readonly edges: readonly GraphEdge[]
	readonly truncated: boolean
	readonly unknownContext: readonly (
		| 'depth_limit'
		| 'entity_limit'
		| 'edge_limit'
		| 'revision_changed'
		| 'serialized_char_limit'
	)[]
}

export interface GraphClaimOutboxInput extends ClaimOutboxInput {
	readonly lensId: string
}

export interface GraphSettleOutboxInput extends SettleOutboxInput {
	readonly lensId: string
}

export interface GraphStoreInspection {
	readonly revisions: LearningRevisionRecord
	readonly entities: readonly GraphEntity[]
	readonly edges: readonly GraphEdge[]
	readonly edgeHistory: readonly GraphEdgeHistory[]
	readonly history: readonly LearningHistoryRecord[]
	readonly changes: readonly MemoryChangeRecord[]
	readonly pendingWork: readonly PendingWorkRecord[]
	readonly processedInputs: readonly ProcessedInputRecord[]
	readonly outbox: readonly OutboxRecord[]
	readonly truncated: boolean
}

export interface MemgraphGraphStore {
	initialize(): Promise<void>
	initializeLens(
		input: InitializeGraphLensInput,
	): Promise<InitializeGraphLensResult>
	configureLens(
		input: ConfigureGraphLensInput,
	): Promise<UpdateLearningConfigRevisionResult>
	getRevisions(lensId: string): Promise<LearningRevisionRecord>
	enqueue(input: GraphEnqueueInput): Promise<EnqueueLearningWorkResult>
	getPendingWork(
		lensId: string,
		pendingWorkId: string,
	): Promise<PendingWorkRecord | undefined>
	getLearningContext(
		input: GraphLearningContextRequest,
		options: GraphReadOptions,
	): Promise<GraphLearningContext>
	commit(input: GraphCommitInput): Promise<LearningCommitResult>
	traverse(
		input: StoredGraphTraversalRequest,
		options: GraphReadOptions,
	): Promise<StoredGraphTraversalResult>
	claimOutbox(input: GraphClaimOutboxInput): Promise<OutboxRecord[]>
	settleOutbox(input: GraphSettleOutboxInput): Promise<OutboxRecord | undefined>
	inspect(
		lensId: string,
		limits: GraphInspectionLimits,
	): Promise<GraphStoreInspection>
	close(): Promise<void>
}
