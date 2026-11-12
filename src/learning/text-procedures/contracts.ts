import type { AdaptUsage } from '../../llm'
import type {
	LearningResult,
	RecipeExecution,
	RevisionPins,
	VersionRef,
} from '../contracts'
import type { LearningRegistry } from '../registry'

export interface TextInput {
	readonly deliveryId: string
	readonly eventId?: string
	readonly text: string
	readonly observedAt: string
	readonly urgency?: 'normal' | 'urgent'
}

export interface TextLearningLens {
	readonly purpose: string
	readonly developerInstructions: readonly string[]
	readonly instructionPrecedence: readonly string[]
	readonly incomingTextRole: 'data-only'
}

/**
 * Settings for the line-revision procedure. Required whenever that procedure
 * is allowed. Scores are rarity-weighted content-word overlaps used only for
 * code-side candidate selection.
 */
export interface LineRevisionConfig {
	readonly maxRelatedLines: number
	readonly minRelatedScore: number
	readonly maxLineCharacters: number
	readonly compactAtCharacters: number
	readonly compactTargetRatio: number
	readonly minCompactionWords: number
	readonly minClusterScore: number
	readonly minClusterLines: number
	readonly maxClusterLines: number
	readonly maxCompactionsPerRun: number
	readonly maxChangeSummaryCharacters: number
	/**
	 * Adapt's existing text strategies, applied to line memory. Required by
	 * line revision version 2. continuous never compacts; cumulative compacts
	 * the largest related cluster at the threshold; decay compacts the oldest
	 * related cluster first.
	 */
	readonly strategy?: 'continuous' | 'cumulative' | 'decay'
	/**
	 * When true, each relevant input is first checked for text that tries to
	 * control the memory (ignore, erase, override, or claim). Flagged inputs
	 * are consumed without being learned. Absent means no check.
	 */
	readonly screenControlText?: boolean
}

/**
 * Settings for the field-revision procedure: one JSON object whose fields are
 * fixed by `schema`. Required whenever that procedure is allowed.
 */
export interface FieldRevisionConfig {
	/** JSON schema: an object of leaf fields, or one level of grouped leaf fields. */
	readonly schema: Readonly<Record<string, unknown>>
	/** Enum fields whose options are an ordered scale, listed lowest first. */
	readonly ordinalFields: readonly string[]
	/** How many steps an ordered rating may move for one input. */
	readonly maxOrdinalStep: number
	/** Maximum items kept in a list-of-strings field. */
	readonly maxListItems: number
	readonly maxChangeSummaryCharacters: number
	readonly screenControlText?: boolean
	/** Optional meaning of each option of an ordered field, shown to the model. */
	readonly levelDescriptions?: Readonly<Record<string, Readonly<Record<string, string>>>>
	/**
	 * Optional concrete yes/no questions for an ordered field, one per option
	 * above the lowest. When present, the model only answers these questions;
	 * code takes the highest option whose question was answered yes as what the
	 * input shows, and moves the stored rating toward it by at most one step.
	 */
	readonly indicators?: Readonly<Record<string, Readonly<Record<string, string>>>>
	/**
	 * How many different sessions (by event id, or by date when absent) must
	 * point the same way before an ordered rating moves one step. 1 moves on
	 * every input. Waiting counts are kept under the reserved `_pending` key.
	 */
	readonly confirmations: number
}

export interface TextLearningConfig {
	readonly lens: TextLearningLens
	readonly model: VersionRef
	readonly activeProcedure: VersionRef
	readonly allowedProcedures: readonly VersionRef[]
	readonly selection: {
		readonly mode: 'fixed' | 'periodic'
		readonly selector: VersionRef
		readonly minCommittedRuns: number
		readonly minElapsedMs: number
		readonly maxCatalogueEntries: number
		readonly autoActivatePreEvaluated: boolean
	}
	readonly batching: {
		readonly maxItems: number
		readonly maxInputCharacters: number
		readonly maxInputTokens: number
		readonly maxDelayMs: number
		readonly acceptCallerUrgency: boolean
	}
	readonly input: {
		readonly maxItemCharacters: number
		readonly maxRoutingSpanCharacters: number
	}
	readonly memory: {
		readonly maxCharacters: number
		readonly maxNarrativeTokens: number
		readonly splitPressureCharacters: number
		readonly allowExplicitClear: boolean
		readonly standaloneCapacity: 'compact' | 'reject'
		readonly compactionProcedure?: VersionRef
	}
	readonly generation: {
		readonly loadedContextTokens: number
		readonly reservedOutputTokens: number
		readonly maxNoteCharacters: number
		readonly maxProviderCalls: number
		readonly maxTokenClaims: number
		readonly maxBudgetClaims: number
	}
	readonly planning: {
		readonly maxNodes: number
		readonly maxCollectionItems: number
		readonly maxOperations: number
	}
	readonly retries: {
		readonly maxLogicalAttempts: number
		readonly initialDelayMs: number
		readonly maxDelayMs: number
		readonly terminalAfterMs: number
	}
	readonly history: {
		readonly maxEntries: number
		readonly maxCharacters: number
	}
	readonly idempotence: {
		readonly processedIdHorizonMs: number
		readonly maxProcessedIds: number
	}
	readonly lineRevision?: LineRevisionConfig
	readonly fieldRevision?: FieldRevisionConfig
}

export interface CompletionMeta {
	readonly finishReason: 'stop'
	readonly usage?: AdaptUsage
	readonly raw?: unknown
}

export type ProseOutcome =
	| {
			readonly status: 'complete'
			readonly text: string
			readonly completion: CompletionMeta
	  }
	| { readonly status: 'no_change'; readonly completion: CompletionMeta }
	| { readonly status: 'clear'; readonly completion: CompletionMeta }
	| { readonly status: 'defer'; readonly completion: CompletionMeta }
	| {
			readonly status: 'failure'
			readonly code: string
			readonly retryable: boolean
			readonly cause?: unknown
	  }

export interface ProseNote {
	readonly kind: 'comparison' | 'pattern'
	readonly text: string
}

export interface ModelOperationInput {
	readonly lens: TextLearningLens
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
	readonly notes: readonly ProseNote[]
	readonly limits: {
		readonly loadedContextTokens: number
		readonly reservedOutputTokens: number
		readonly maxNarrativeTokens: number
		readonly maxMemoryCharacters: number
		readonly maxNoteCharacters: number
		readonly allowExplicitClear: boolean
		readonly lineRevision?: LineRevisionConfig
		readonly fieldRevision?: FieldRevisionConfig
	}
}

export type ProseResponseContract =
	| {
			readonly kind: 'prose'
			readonly controls: readonly ('no_change' | 'clear' | 'defer')[]
	  }
	| {
			readonly kind: 'exact-token'
			readonly tokens: readonly string[]
			readonly allowDefer: boolean
	  }

export interface ProseRequest {
	readonly system: string
	readonly prompt: string
	readonly response: ProseResponseContract
	readonly loadedContextTokens: number
	readonly reservedOutputTokens: number
}

export interface ProcedurePins {
	readonly execution: RevisionPins
	readonly neuron: {
		readonly id: string
		readonly incarnation: string
		readonly ownershipRevision: number
	}
	readonly procedure: VersionRef
	readonly profile: VersionRef
	readonly model: VersionRef
	readonly learnedStateRevision: number
}

export interface PinnedProcedureRun {
	readonly runId: string
	readonly pins: ProcedurePins
	readonly configuration: TextLearningConfig
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
	readonly signal: AbortSignal
}

export interface ProcedureTrace {
	readonly runId: string
	readonly startedAt: string
	readonly completedAt: string
	readonly procedure: VersionRef
	readonly inputIds: readonly string[]
}

export interface ProcedureProposal {
	readonly pins: ProcedurePins
	readonly execution: Pick<RecipeExecution, 'nodes' | 'pending' | 'budget'>
	readonly result: LearningResult
	readonly trace: ProcedureTrace
}

export interface RequestTokenCount {
	readonly tokens: number
	readonly conservativeUpperBound: boolean
}

export interface ProcedurePorts {
	readonly provider: {
		generate(request: ProseRequest, signal: AbortSignal): Promise<ProseOutcome>
	}
	readonly registry: LearningRegistry
	readonly tokens: {
		countRequest(request: ProseRequest): RequestTokenCount
		countText(text: string): RequestTokenCount
		countTextBound(maxCharacters: number): RequestTokenCount
	}
	readonly clock: { now(): string }
}

export type LearnedChangeSummary = string

export type ExplicitFeedback = string

export interface ProcedureMetrics {
	readonly committedRuns: number
	readonly deferredRuns: number
	readonly failedRuns: number
	readonly meanBatchItems: number
	readonly elapsedSinceSelectionMs?: number
}

export type SelectionTrigger = 'periodic' | 'feedback' | 'operational'

export interface SelectionStatePin {
	readonly neuron: ProcedurePins['neuron']
	readonly learnedStateRevision: number
	readonly procedure: VersionRef
	readonly profile: VersionRef
	readonly profileRevision: number
	readonly model: VersionRef
	readonly allowedCatalogueDigest: string
	readonly referencedDefinitionDigest: string
}

export interface ProcedureSelectionInput {
	readonly review: {
		readonly id: string
		readonly trigger: SelectionTrigger
		readonly contextDigest: string
		readonly evidenceRefs: readonly string[]
	}
	readonly lens: TextLearningLens
	readonly state: SelectionStatePin
	readonly currentNarrative: string
	readonly learnedChanges: readonly LearnedChangeSummary[]
	readonly pending: readonly TextInput[]
	readonly feedback: readonly ExplicitFeedback[]
	readonly metrics: ProcedureMetrics
	readonly allowed: readonly {
		readonly procedure: VersionRef
		readonly expectedEffect: string
		readonly token: string
	}[]
	readonly limits: {
		readonly loadedContextTokens: number
		readonly reservedOutputTokens: number
		readonly maxContextCharacters: number
		readonly maxCatalogueEntries: number
	}
	readonly signal: AbortSignal
}

export interface SelectionSnapshotRef {
	readonly review: ProcedureSelectionInput['review']
	readonly state: SelectionStatePin
}

export type SelectionOutcome =
	| {
			readonly status: 'candidate'
			readonly procedure: VersionRef
			readonly expectedEffectHypothesis: string
			readonly snapshot: SelectionSnapshotRef
	  }
	| { readonly status: 'no_change'; readonly reason: string }
	| { readonly status: 'defer'; readonly reason: string }
	| {
			readonly status: 'failure'
			readonly code: string
			readonly retryable: boolean
	  }

export interface SelectionPorts {
	readonly provider: ProcedurePorts['provider']
	readonly tokens: ProcedurePorts['tokens']
}
