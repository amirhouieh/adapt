import type {
	LearningCommitResult,
	LearningVersionBindings,
	StoredVersionRef,
} from '../../stores/types'

export interface TextInput {
	readonly deliveryId: string
	readonly eventId?: string
	readonly text: string
	readonly observedAt: string
	readonly urgency?: 'normal' | 'urgent'
}

export interface TextCoordinatorConfiguration {
	readonly batching: {
		readonly maxItems: number
		readonly maxInputCharacters: number
		readonly maxInputTokens: number
		readonly maxDelayMs: number
		readonly acceptCallerUrgency: boolean
	}
	readonly input: { readonly maxItemCharacters: number }
	readonly memory: {
		readonly maxCharacters: number
		readonly allowExplicitClear: boolean
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

export interface TextProfileSnapshot<
	TConfiguration extends
		TextCoordinatorConfiguration = TextCoordinatorConfiguration,
> {
	readonly ref: StoredVersionRef
	readonly revision: number
	readonly configuration: TConfiguration
	readonly bindings: LearningVersionBindings
	readonly createdAt: string
}

export interface TextProcedureStateSnapshot<
	TConfiguration extends
		TextCoordinatorConfiguration = TextCoordinatorConfiguration,
> {
	readonly runId: string
	readonly pins: {
		readonly execution: {
			readonly memory: number
			readonly configuration: number
			readonly registry: string
		}
		readonly neuron: {
			readonly id: string
			readonly incarnation: string
			readonly ownershipRevision: number
		}
		readonly procedure: StoredVersionRef
		readonly profile: StoredVersionRef
		readonly model: StoredVersionRef
		readonly learnedStateRevision: number
	}
	readonly configuration: TConfiguration
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
	readonly signal: AbortSignal
}

export type TextProcedureDecision =
	| {
			readonly status: 'change'
			readonly narrative: string
			readonly proposal: unknown
			readonly completion?: unknown
			readonly explanation?: string
	  }
	| {
			readonly status: 'clear'
			readonly proposal: unknown
			readonly completion?: unknown
			readonly explanation?: string
	  }
	| {
			readonly status: 'no_change'
			readonly proposal: unknown
			readonly completion?: unknown
			readonly reason?: string
	  }
	| {
			readonly status: 'defer'
			readonly reason: string
			readonly proposal?: unknown
	  }
	| {
			readonly status: 'failure'
			readonly code: string
			readonly retryable: boolean
			readonly reason: string
			readonly proposal?: unknown
	  }

export type TextRunProcedure<
	TConfiguration extends
		TextCoordinatorConfiguration = TextCoordinatorConfiguration,
> = (
	snapshot: TextProcedureStateSnapshot<TConfiguration>,
) => Promise<TextProcedureDecision>

export interface TextStateIds {
	next(
		kind:
			| 'work'
			| 'attempt'
			| 'run'
			| 'candidate'
			| 'history'
			| 'change'
			| 'supersede'
			| 'profile'
			| 'activation',
	): string
}

export interface TextStateClock {
	now(): string
}

export interface TextStateScheduler {
	schedule(dueAt: string, callback: () => void): unknown
	cancel(handle: unknown): void
}

export interface TextStatePolicy {
	readonly headStateId: string
	readonly narrativeMemoryId: string
	readonly stateKind: string
	readonly maxRetainedProfiles: number
	readonly maxFlushRuns: number
}

export type TextEnqueueResult =
	| { readonly status: 'queued'; readonly dueAt: string }
	| {
			readonly status: 'deduplicated'
			readonly coverage: 'pending' | 'processed'
	  }
	| { readonly status: 'conflict'; readonly reason: 'delivery-id-reused' }
	| { readonly status: 'input_too_large' }

export interface TextCoordinatorSnapshot {
	readonly activeProfile?: StoredVersionRef
	readonly memoryRevision: number
	readonly learnedStateRevision: number
	readonly pendingDeliveryIds: readonly string[]
	readonly runningRunIds: readonly string[]
	readonly candidateIds: readonly string[]
	readonly processedCoverage: {
		readonly retainedIds: number
		readonly oldestProcessedAt?: string
		readonly horizonMs: number
		readonly maxIds: number
	}
}

export type TextRunResult =
	| { readonly status: 'idle' }
	| { readonly status: 'memory-capacity'; readonly reason: string }
	| {
			readonly status: 'deferred'
			readonly runId: string
			readonly retryAt: string
	  }
	| {
			readonly status: 'terminal-failure'
			readonly runId: string
			readonly code: string
	  }
	| {
			readonly status: 'superseded'
			readonly runId: string
			readonly replacementAttemptId: string
	  }
	| {
			readonly status: 'settled'
			readonly runId: string
			readonly commit: LearningCommitResult
	  }

export interface TextSelectionStatePin {
	readonly neuron: {
		readonly id: string
		readonly incarnation: string
		readonly ownershipRevision: number
	}
	readonly learnedStateRevision: number
	readonly procedure: StoredVersionRef
	readonly profile: StoredVersionRef
	readonly profileRevision: number
	readonly model: StoredVersionRef
	readonly allowedCatalogueDigest: string
	readonly referencedDefinitionDigest: string
}

export type TextActivationResult =
	| {
			readonly status: 'activated'
			readonly profile: StoredVersionRef
			readonly supersededAttempts: number
	  }
	| { readonly status: 'stale-selection' | 'busy' | 'conflict' }
