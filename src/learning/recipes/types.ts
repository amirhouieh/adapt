import type { ZodType } from 'zod'
import type { AdaptFinishReason, AdaptUsage, JsonValue } from '../../llm'

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

export interface LearningClockCapability {
	now(): string
}
