import type { AdaptFinishReason, AdaptUsage, JsonValue } from '../../llm'
import type { ZodType } from 'zod'

export interface LearningObservation {
	readonly id: string
	readonly text: string
	readonly observedAt: string
	readonly eventAt?: string
}

export interface LearningLens {
	readonly purpose: string
	readonly memoryType: string
	readonly schema: JsonValue
	/** Verbatim developer-owned constraints. */
	readonly developerConstraints: string
	readonly identityRules?: string
}

export interface TextMemorySnapshot {
	readonly id: string
	readonly revision: number
	readonly text: string
	readonly processedInputIds: readonly string[]
}

export interface ListMemoryItem {
	readonly id: string
	readonly data: Readonly<Record<string, JsonValue>>
}

export interface ListMemorySnapshot {
	readonly id: string
	readonly revision: number
	readonly items: readonly ListMemoryItem[]
	readonly processedInputIds: readonly string[]
	readonly candidateContextTruncated: boolean
}

export type ListPatchAction =
	| {
			readonly kind: 'add'
			readonly item: ListMemoryItem
	  }
	| {
			readonly kind: 'update'
			readonly itemId: string
			readonly data: Readonly<Record<string, JsonValue>>
	  }
	| {
			readonly kind: 'remove'
			readonly itemId: string
	  }

export interface ListPatch {
	readonly actions: readonly ListPatchAction[]
}

export type SemanticStage<T> = {
	readonly value: T
	readonly raw: unknown
	readonly usage?: AdaptUsage
}

export type LearningTextGenerationResult = SemanticStage<string> & {
	readonly finishReason: AdaptFinishReason
}

export interface LearningGenerationRequest<T> {
	readonly system: string
	readonly prompt: string
	readonly schema: ZodType<T>
	readonly signal: AbortSignal
}

export interface LearningTextGenerationRequest {
	readonly system: string
	readonly prompt: string
	readonly signal: AbortSignal
}

export interface LearningDecisionRequest<TAnswer extends string> {
	readonly state: JsonValue
	readonly question: string
	readonly answers: readonly {
		readonly value: TAnswer
		readonly description?: string
	}[]
	readonly instructions?: string
	readonly signal: AbortSignal
}

export type LearningDecisionResult<TAnswer extends string> =
	| {
			readonly status: 'answered'
			readonly answer: TAnswer
			readonly raw: unknown
			readonly usage?: AdaptUsage
			readonly probability?: {
				readonly value: number
				readonly source: string
				readonly calibrated: boolean
			}
	  }
	| {
			readonly status: 'abstained'
			readonly raw: unknown
			readonly usage?: AdaptUsage
			readonly probability?: {
				readonly value: number
				readonly source: string
				readonly calibrated: boolean
			}
	  }

export interface LearningModelCapability {
	generate<T>(request: LearningGenerationRequest<T>): Promise<SemanticStage<T>>
	generateText?(
		request: LearningTextGenerationRequest,
	): Promise<LearningTextGenerationResult>
	decide<TAnswer extends string>(
		request: LearningDecisionRequest<TAnswer>,
	): Promise<LearningDecisionResult<TAnswer>>
}

export interface LearningIdCapability {
	next(kind: string): string
}

export interface LearningClockCapability {
	now(): string
}

export interface LearningItemValidatorCapability {
	parse(value: unknown): Readonly<Record<string, JsonValue>>
	validateTransition?(
		previous: Readonly<Record<string, JsonValue>>,
		next: Readonly<Record<string, JsonValue>>,
	): void
}

export const LEARNING_MODEL_CAPABILITY = 'adapt.learning.model'
export const LEARNING_ID_CAPABILITY = 'adapt.learning.id'
export const LEARNING_CLOCK_CAPABILITY = 'adapt.learning.clock'
export const LEARNING_ITEM_VALIDATOR_CAPABILITY = 'adapt.learning.item-validator'
