import { z } from 'zod'

import {
	arraySchema,
	defineOperation,
	defineSchema,
	type OperationContext,
	type ValueSchema,
} from '../contracts'
import type { LearningRegistry } from '../registry'
import {
	learningObservationSchema,
	learningObservationValueSchema,
	learningObservationsValueSchema,
	zodValueSchema,
} from './schemas'
import {
	LEARNING_MODEL_CAPABILITY,
	type LearningModelCapability,
	type SemanticStage,
} from './types'

export const stringArrayValueSchema = defineSchema({
	id: 'adapt.learning.string-array', version: '1',
	parse(value: unknown) { return z.array(z.string()).readonly().parse(value) },
})
export const booleanValueSchema = zodValueSchema(
	'adapt.learning.boolean', '1', z.boolean(),
)

const screenedObservationSchema = z.object({
	status: z.enum(['new', 'duplicate']),
	observation: learningObservationSchema,
}).strict().readonly()
export type ScreenedObservation = z.infer<typeof screenedObservationSchema>
export const screenedObservationValueSchema = zodValueSchema(
	'adapt.learning.screened-observation', '1', screenedObservationSchema,
)
export const screenedObservationsValueSchema = arraySchema(
	'adapt.learning.screened-observations', '1', screenedObservationValueSchema,
)

export const semanticUsageSchema = z.object({
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	totalTokens: z.number().optional(),
}).strict().optional()

export function semanticStageSchema<T>(value: z.ZodType<T>) {
	return z.object({ value, raw: z.unknown(), usage: semanticUsageSchema }).strict().readonly()
}

export function modelCapability(context: OperationContext): LearningModelCapability {
	const model = context.capabilities.get<LearningModelCapability>(LEARNING_MODEL_CAPABILITY)
	if (model === undefined) throw new Error('learning model capability is unavailable')
	return model
}

export function claimProviderCall(context: OperationContext, nodeId: string): void {
	if (!context.budget.claim({ kind: 'provider_call', amount: 1, nodeId })) {
		throw new Error(`provider budget is exhausted for ${nodeId}`)
	}
}

export function contextJson(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

export const commonOperationRefs = {
	screen: { id: 'adapt.learning.screen-observation', version: '1' },
	hasNew: { id: 'adapt.learning.has-new-observations', version: '1' },
} as const

export function registerCommonOperations(registry: LearningRegistry): void {
	if (registry.getOperation(commonOperationRefs.screen) !== undefined) return
	registry.registerOperation(defineOperation({
		...commonOperationRefs.screen,
		inputSchemas: {
			observation: learningObservationValueSchema,
			processedInputIds: stringArrayValueSchema,
		},
		outputSchemas: { screened: screenedObservationValueSchema },
		requiredCapabilities: [],
		run: ({ observation, processedInputIds }) => ({
			screened: {
				status: processedInputIds.includes(observation.id) ? 'duplicate' as const : 'new' as const,
				observation,
			},
		}),
	}))
	registry.registerOperation(defineOperation({
		...commonOperationRefs.hasNew,
		inputSchemas: { screened: screenedObservationsValueSchema },
		outputSchemas: {
			applies: booleanValueSchema,
			observations: learningObservationsValueSchema,
		},
		requiredCapabilities: [],
		run: ({ screened }) => {
			const observations = screened
				.filter(({ status }) => status === 'new')
				.map(({ observation }) => observation)
			return { applies: observations.length > 0, observations }
		},
	}))
}

export function semanticStageValueSchema<T>(
	id: string,
	schema: z.ZodType<T>,
) {
	return zodValueSchema<SemanticStage<T>>(id, '1', semanticStageSchema(schema))
}

export function optionalValueSchema<T>(
	id: string,
	valueSchema: ValueSchema<T>,
): ValueSchema<T | undefined> {
	return defineSchema({
		id,
		version: '1',
		accepts: (producer) => producer === valueSchema,
		parse(value) {
			return value === undefined ? undefined : valueSchema.parse(value)
		},
	})
}
