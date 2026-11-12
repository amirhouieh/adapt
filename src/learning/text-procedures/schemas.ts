import { z } from 'zod'

import { defineSchema } from '../contracts'
import type { ModelOperationInput, ProseOutcome } from './contracts'

const versionRefSchema = z
	.object({ id: z.string().min(1), version: z.string().min(1) })
	.strict()
	.readonly()
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
		notes: z
			.array(
				z
					.object({ kind: z.enum(['comparison', 'pattern']), text: z.string() })
					.strict()
					.readonly(),
			)
			.readonly(),
		limits: z
			.object({
				loadedContextTokens: z.number().int().positive(),
				reservedOutputTokens: z.number().int().positive(),
				maxNarrativeTokens: z.number().int().positive(),
				maxMemoryCharacters: z.number().int().positive(),
				maxNoteCharacters: z.number().int().positive(),
				allowExplicitClear: z.boolean(),
				lineRevision: z
					.object({
						maxRelatedLines: z.number().int().positive(),
						minRelatedScore: z.number().positive(),
						maxLineCharacters: z.number().int().positive(),
						compactAtCharacters: z.number().int().positive(),
						compactTargetRatio: z.number().gt(0).lt(1),
						minCompactionWords: z.number().int().positive(),
						minClusterScore: z.number().positive(),
						minClusterLines: z.number().int().min(2),
						maxClusterLines: z.number().int().min(2),
						maxCompactionsPerRun: z.number().int().nonnegative(),
						maxChangeSummaryCharacters: z.number().int().positive(),
						strategy: z.enum(['continuous', 'cumulative', 'decay']).optional(),
						screenControlText: z.boolean().optional(),
					})
					.strict()
					.readonly()
					.optional(),
				fieldRevision: z
					.object({
						schema: z.record(z.string(), z.unknown()),
						ordinalFields: z.array(z.string()).readonly(),
						maxOrdinalStep: z.number().int().positive(),
						maxListItems: z.number().int().positive(),
						maxChangeSummaryCharacters: z.number().int().positive(),
						screenControlText: z.boolean().optional(),
						levelDescriptions: z.record(z.string(), z.record(z.string(), z.string())).optional(),
						indicators: z.record(z.string(), z.record(z.string(), z.string())).optional(),
						confirmations: z.number().int().positive(),
					})
					.strict()
					.readonly()
					.optional(),
			})
			.strict()
			.readonly(),
	})
	.strict()
	.readonly()

const completionSchema = z
	.object({
		finishReason: z.literal('stop'),
		usage: z
			.object({
				inputTokens: z.number().optional(),
				outputTokens: z.number().optional(),
				totalTokens: z.number().optional(),
			})
			.strict()
			.optional(),
		raw: z.unknown().optional(),
	})
	.strict()
	.readonly()

export const proseOutcomeSchema: z.ZodType<ProseOutcome> = z.discriminatedUnion(
	'status',
	[
		z
			.object({
				status: z.literal('complete'),
				text: z.string(),
				completion: completionSchema,
			})
			.strict()
			.readonly(),
		z
			.object({ status: z.literal('no_change'), completion: completionSchema })
			.strict()
			.readonly(),
		z
			.object({ status: z.literal('clear'), completion: completionSchema })
			.strict()
			.readonly(),
		z
			.object({ status: z.literal('defer'), completion: completionSchema })
			.strict()
			.readonly(),
		z
			.object({
				status: z.literal('failure'),
				code: z.string().min(1),
				retryable: z.boolean(),
				cause: z.unknown().optional(),
			})
			.strict()
			.readonly(),
	],
)

export const modelOperationInputValueSchema = defineSchema({
	id: 'adapt.text-procedure.input',
	version: '1',
	parse: (value: unknown) => modelOperationInputSchema.parse(value),
})
export const proseOutcomeValueSchema = defineSchema({
	id: 'adapt.text-procedure.prose-outcome',
	version: '1',
	parse: (value: unknown) => proseOutcomeSchema.parse(value),
})
export const optionalProseOutcomeValueSchema = defineSchema<
	ProseOutcome | undefined
>({
	id: 'adapt.text-procedure.optional-prose-outcome',
	version: '1',
	accepts: (producer) => producer === proseOutcomeValueSchema,
	parse: (value: unknown) =>
		value === undefined ? undefined : proseOutcomeSchema.parse(value),
})

export const versionRefValueSchema = defineSchema({
	id: 'adapt.text-procedure.version-ref',
	version: '1',
	parse: (value: unknown) => versionRefSchema.parse(value),
})
