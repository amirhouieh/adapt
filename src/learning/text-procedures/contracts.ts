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

export interface TextLearningConfig {
	readonly lens: TextLearningLens
	readonly model: VersionRef
	readonly activeProcedure: VersionRef
	readonly allowedProcedures: readonly VersionRef[]
	readonly batching: {
		readonly maxItems: number
		readonly maxInputCharacters: number
		readonly maxInputTokens: number
		readonly maxDelayMs: number
		readonly acceptCallerUrgency: boolean
	}
	readonly input: {
		readonly maxItemCharacters: number
	}
	readonly memory: {
		readonly maxCharacters: number
		readonly allowExplicitClear: boolean
	}
	readonly generation: {
		readonly loadedContextTokens: number
		readonly reservedOutputTokens: number
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
	| {
			readonly status: 'failure'
			readonly code: string
			readonly retryable: boolean
			readonly cause?: unknown
	  }

export interface ModelOperationInput {
	readonly lens: TextLearningLens
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
	readonly limits: {
		readonly loadedContextTokens: number
		readonly reservedOutputTokens: number
	}
}

export interface ProseRequest {
	readonly system: string
	readonly prompt: string
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
	}
	readonly clock: { now(): string }
}
