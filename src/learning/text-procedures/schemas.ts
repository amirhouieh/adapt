import { z } from 'zod'

import { defineSchema } from '../contracts'
import type { ModelOperationInput } from './contracts'

const textInputSchema = z
	.object({
		deliveryId: z.string().min(1),
		eventId: z.string().min(1).optional(),
		text: z.string(),
		observedAt: z.string().min(1),
		urgency: z.enum(['normal', 'urgent']).optional(),
	})
	.strict()
	.readonly()
const lensSchema = z
	.object({
		purpose: z.string().min(1),
		developerInstructions: z.array(z.string().min(1)).readonly(),
		instructionPrecedence: z.array(z.string().min(1)).readonly(),
		incomingTextRole: z.literal('data-only'),
	})
	.strict()
	.readonly()

export const modelOperationInputSchema: z.ZodType<ModelOperationInput> = z
	.object({
		lens: lensSchema,
		memory: z
			.object({ text: z.string(), revision: z.number().int().nonnegative() })
			.strict()
			.readonly(),
		inputs: z.array(textInputSchema).min(1).readonly(),
		limits: z
			.object({
				loadedContextTokens: z.number().int().positive(),
				reservedOutputTokens: z.number().int().positive(),
			})
			.strict()
			.readonly(),
	})
	.strict()
	.readonly()

export const modelOperationInputValueSchema = defineSchema({
	id: 'adapt.text-procedure.input',
	version: '1',
	parse: (value: unknown) => modelOperationInputSchema.parse(value),
})
