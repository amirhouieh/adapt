import type {
	LearningClockCapability,
	LearningModelCapability,
} from '../../learning/recipes/types'
import type { AdaptUsage, JsonValue } from '../../llm/index'

export type QueryClock = LearningClockCapability
export type QueryModel = Pick<LearningModelCapability, 'generate'>

export interface QueryRegistryEntry {
	readonly memoryId: string
	readonly lensId: string
	readonly memoryRevision: number
	readonly configurationRevision: number
}

export interface QueryMemorySnapshot extends QueryRegistryEntry {
	readonly registryRevision: string
	readonly purpose: string
	readonly memoryType: string
	readonly content: JsonValue
}

export interface QueryPendingLearning {
	readonly id: string
	readonly lensId: string
	readonly memoryId: string
	readonly inputIds: readonly string[]
	readonly reason: string
}

export interface GroundedQuerySnapshot {
	readonly registry: {
		readonly revision: string
		readonly entries: readonly QueryRegistryEntry[]
	}
	readonly memories: readonly QueryMemorySnapshot[]
	readonly pendingLearning: readonly QueryPendingLearning[]
}

export interface GroundedQueryPolicy {
	readonly instructions: string
	readonly maxCandidates: number
	readonly maxSelectedCandidates: number
	readonly maxCandidateCharacters: number
	readonly maxContextCharacters: number
	readonly maxRequestCharacters: number
	readonly maxAnswerCharacters: number
}

export interface QueryCandidate {
	readonly memoryId: string
	readonly lensId: string
	readonly purpose: string
	readonly memoryType: string
	readonly content: JsonValue
}

export interface QuerySelectionRequest {
	readonly question: string
	readonly userConstraints: string
	readonly policyInstructions: string
	readonly candidates: readonly QueryCandidate[]
	readonly maxSelectedCandidates: number
	readonly signal: AbortSignal
}

export interface QuerySelection {
	readonly selectedMemoryIds: readonly string[]
	readonly reason: string
}

export interface QuerySelectionStage {
	readonly value: QuerySelection
	readonly raw: unknown
	readonly usage?: AdaptUsage
}

export interface QueryCandidateSelector {
	select(request: QuerySelectionRequest): Promise<QuerySelectionStage>
}

export interface QueryRevisionPins {
	readonly registry: string
	readonly memories: readonly QueryRegistryEntry[]
}

export interface GroundedQueryCommon {
	readonly scope: 'committed_state'
	readonly evaluatedAt: string
	readonly revisions: QueryRevisionPins
	readonly omittedMemoryIds: readonly string[]
	readonly pendingLearning: readonly QueryPendingLearning[]
	readonly raw: {
		readonly selection?: unknown
		readonly answer?: unknown
	}
}

export type GroundedQueryResult =
	| (GroundedQueryCommon & {
			readonly status: 'answered'
			readonly answer: string
			readonly usedMemoryIds: readonly string[]
			readonly gaps: readonly string[]
	  })
	| (GroundedQueryCommon & {
			readonly status: 'gap'
			readonly reason: string
			readonly usedMemoryIds: readonly string[]
			readonly gaps: readonly string[]
	  })
	| (GroundedQueryCommon & {
			readonly status: 'defer'
			readonly code: 'request_bound' | 'cancelled'
			readonly reason: string
	  })
	| (GroundedQueryCommon & {
			readonly status: 'failure'
			readonly code:
				| 'invalid_snapshot'
				| 'invalid_selection'
				| 'invalid_answer'
				| 'provider_failure'
			readonly reason: string
			readonly cause?: unknown
	  })

export interface RunGroundedQueryInput {
	readonly snapshot: GroundedQuerySnapshot
	readonly question: string
	readonly userConstraints: string
	readonly policy: GroundedQueryPolicy
	readonly model: QueryModel
	readonly selector: QueryCandidateSelector
	readonly clock: QueryClock
	readonly signal: AbortSignal
}
