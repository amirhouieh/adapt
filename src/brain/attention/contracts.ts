import type { AdaptUsage, JsonValue } from '../../llm'

export interface AttentionPortion {
	readonly id: string
	readonly inputId: string
	readonly sourceId: string
	readonly text: string
	readonly observedAt: string
	readonly eventAt?: string
}

export interface AttentionLens {
	readonly id: string
	readonly revision: number
	readonly description: string
	/** Verbatim developer-owned routing constraints. */
	readonly routingInstructions: string
	readonly metadata: JsonValue
	readonly learningStatus: 'active' | 'paused'
}

export interface AttentionRoutingRule {
	readonly id: string
	readonly priority: number
	readonly match: {
		readonly portionIds?: readonly string[]
		readonly sourceIds?: readonly string[]
	}
	readonly includeLensIds: readonly string[]
	readonly excludeLensIds: readonly string[]
	readonly coverage: 'complete' | 'partial'
}

export interface AttentionPolicy {
	readonly maxPortions: number
	readonly maxPortionCharacters: number
	readonly maxRequestContextCharacters: number
	readonly maxCandidateLenses: number
	readonly maxDestinationsPerPortion: number
	readonly maxProviderCalls: number
	readonly maxUncoveredSpans: number
	readonly maxDiscoveryActions: number
	readonly maxRecheckActions: number
}

export interface AttentionCandidateSelection {
	readonly lensIds: readonly string[]
	readonly metadataExaminedLensIds: readonly string[]
	readonly omittedLensIds: readonly string[]
	readonly provenance: JsonValue
}

export interface AttentionCandidateSelector {
	select(input: {
		readonly portion: AttentionPortion
		readonly lenses: readonly AttentionLens[]
		readonly limit: number
	}): AttentionCandidateSelection
}

export interface AttentionRoutingInput {
	readonly portions: readonly AttentionPortion[]
	readonly lenses: readonly AttentionLens[]
	readonly rules: readonly AttentionRoutingRule[]
	readonly policy: AttentionPolicy
}

export type AttentionCoverageState =
	| 'complete'
	| 'partial'
	| 'uncovered'
	| 'unknown'

export type AttentionModelProvenance =
	| {
			readonly stage: 'lens'
			readonly lensId: string
			readonly raw: unknown
			readonly usage?: AdaptUsage
	  }
	| {
			readonly stage: 'aggregate_coverage'
			readonly lensIds: readonly string[]
			readonly raw: unknown
			readonly usage?: AdaptUsage
	  }

export interface AttentionCoverage {
	readonly portionId: string
	readonly state: AttentionCoverageState
	readonly selectedLensIds: readonly string[]
	readonly matchedPausedLensIds: readonly string[]
	readonly ruleIds: readonly string[]
	readonly semanticExaminedLensIds: readonly string[]
	readonly metadataExaminedLensIds: readonly string[]
	readonly omittedLensIds: readonly string[]
	readonly uncoveredSpans: readonly string[]
	readonly retainedScope?: 'quoted_spans' | 'whole_portion'
	readonly reason: string
	readonly candidateProvenance?: JsonValue
	readonly model?: readonly AttentionModelProvenance[]
}

export interface AttentionSelectedWork {
	readonly lensId: string
	readonly portions: readonly AttentionPortion[]
	readonly provenance: readonly {
		readonly portionId: string
		readonly source: 'developer_rule' | 'semantic_model'
		readonly ruleIds: readonly string[]
	}[]
}

export type AttentionAction = {
	readonly kind: 'discover' | 'recheck' | 'pending'
	readonly portion: AttentionPortion
	readonly uncoveredSpans: readonly string[]
	readonly reason:
		| 'uncovered'
		| 'partial_coverage'
		| 'candidate_truncation'
		| 'semantic_unknown'
		| 'input_bound'
		| 'context_bound'
		| 'action_budget'
		| 'paused_lens'
}

export interface AttentionRoutingResult {
	readonly selectedWork: readonly AttentionSelectedWork[]
	readonly coverage: readonly AttentionCoverage[]
	readonly actions: readonly AttentionAction[]
	readonly omittedPortionIds: readonly string[]
	readonly providerCalls: number
	readonly usage: readonly AdaptUsage[]
}

export interface DiscoveryBufferEntry {
	readonly portion: AttentionPortion
	readonly uncoveredSpans: readonly string[]
	readonly reason: AttentionAction['reason']
	readonly firstRetainedAt: string
	readonly lastRetainedAt: string
	readonly expiresAt: string
	readonly retainCount: number
}

export interface DiscoveryBufferPolicy {
	readonly maxItems: number
	readonly maxCharacters: number
	readonly maxAgeMs: number
	readonly overflowPolicy: 'evict_oldest' | 'reject_new'
}

export interface DiscoveryBufferEviction {
	readonly entry: DiscoveryBufferEntry
	readonly reason: 'age' | 'count' | 'characters'
}

export interface DiscoveryBufferResult {
	readonly retained: readonly DiscoveryBufferEntry[]
	readonly evicted: readonly DiscoveryBufferEviction[]
	readonly rejected: readonly AttentionAction[]
	readonly overflow: boolean
}
