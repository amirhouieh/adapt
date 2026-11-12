import { type ZodType, z } from 'zod'

import { defineSchema, type ValueSchema } from '../contracts'
import type {
	LearningLens,
	LearningObservation,
	ListMemorySnapshot,
	TextMemorySnapshot,
} from './types'

export const learningObservationSchema: ZodType<LearningObservation> = z
	.object({
		id: z.string().min(1),
		text: z.string(),
		observedAt: z.string().min(1),
		eventAt: z.string().min(1).optional(),
	})
	.strict()
	.readonly()

export const learningLensSchema: ZodType<LearningLens> = z
	.object({
		purpose: z.string().min(1),
		memoryType: z.string().min(1),
		schema: z.json(),
		developerConstraints: z.string(),
		identityRules: z.string().optional(),
	})
	.strict()
	.readonly()

export const textMemorySnapshotSchema: ZodType<TextMemorySnapshot> = z
	.object({
		id: z.string().min(1),
		revision: z.number().int().nonnegative(),
		text: z.string(),
		processedInputIds: z.array(z.string().min(1)).readonly(),
	})
	.strict()
	.readonly()

const jsonRecordSchema = z.record(z.string(), z.json()).readonly()
const listMemoryItemSchema = z
	.object({
		id: z.string().min(1),
		data: jsonRecordSchema,
	})
	.strict()
	.readonly()

export const listMemorySnapshotSchema: ZodType<ListMemorySnapshot> = z
	.object({
		id: z.string().min(1),
		revision: z.number().int().nonnegative(),
		items: z.array(listMemoryItemSchema).readonly(),
		processedInputIds: z.array(z.string().min(1)).readonly(),
		candidateContextTruncated: z.boolean(),
	})
	.strict()
	.readonly()

export function zodValueSchema<T>(
	id: string,
	version: string,
	schema: ZodType<T>,
): ValueSchema<T> {
	return defineSchema({ id, version, parse: (value) => schema.parse(value) })
}

export const learningObservationValueSchema = zodValueSchema(
	'adapt.learning.observation',
	'1',
	learningObservationSchema,
)
export const learningObservationsValueSchema = defineSchema({
	id: 'adapt.learning.observations',
	version: '1',
	collectionItem: learningObservationValueSchema,
	parse(value: unknown) {
		return z.array(learningObservationSchema).readonly().parse(value)
	},
})
export const learningLensValueSchema = zodValueSchema(
	'adapt.learning.lens',
	'1',
	learningLensSchema,
)
export const textMemorySnapshotValueSchema = zodValueSchema(
	'adapt.learning.text-memory',
	'1',
	textMemorySnapshotSchema,
)
export const listMemorySnapshotValueSchema = zodValueSchema(
	'adapt.learning.list-memory',
	'1',
	listMemorySnapshotSchema,
)
