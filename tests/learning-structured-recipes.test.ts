import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/llm'
import {
	LEARNING_ID_CAPABILITY,
	LEARNING_ITEM_VALIDATOR_CAPABILITY,
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	learningLensValueSchema,
	learningObservationsValueSchema,
	listMemorySnapshotValueSchema,
	planRecipe,
	registerStructuredStateRecipe,
	runRecipe,
	stringArrayValueSchema,
	type LearningDecisionResult,
	type LearningItemValidatorCapability,
	type LearningModelCapability,
	type LearningObservation,
	type ListMemorySnapshot,
	type SemanticStage,
} from '../src/learning/index'

const itemDataSchema = z
	.object({
		title: z.string(),
		status: z.enum(['open', 'completed']),
	})
	.strict()

class QueuedModel implements LearningModelCapability {
	readonly generateRequests: Array<{ system: string; prompt: string }> = []
	constructor(readonly generations: unknown[]) {}
	async generate<T>(
		request: Parameters<LearningModelCapability['generate']>[0],
	): Promise<SemanticStage<T>> {
		this.generateRequests.push({ system: request.system, prompt: request.prompt })
		const value = this.generations.shift()
		return { value: request.schema.parse(value) as T, raw: value }
	}
	async decide<TAnswer extends string>(): Promise<
		LearningDecisionResult<TAnswer>
	> {
		throw new Error('structured recipe does not use the decision capability')
	}
}

function observation(id: string, text: string): LearningObservation {
	return { id, text, observedAt: '2026-09-30T12:00:00.000Z' }
}

function extraction(
	candidates: Array<{
		id: string
		data: Record<string, JsonValue>
		sourceObservationIds: string[]
	}>,
	irrelevantObservationIds: string[] = [],
	pendingObservationIds: string[] = [],
) {
	return {
		candidates,
		irrelevantObservationIds,
		pendingObservationIds,
		contextTruncated: false,
	}
}

function resolution(
	...resolutions: Array<{
		candidateId: string
		decision: 'existing' | 'new_item' | 'unknown'
		matchedItemId?: string
		reason: string
	}>
) {
	return { resolutions }
}

function transitions(
	...items: Array<{
		candidateId: string
		action: 'add' | 'update' | 'no_change' | 'defer'
		data?: Record<string, JsonValue>
		observationIds: string[]
		reason: string
	}>
) {
	return { transitions: items }
}

function recipeConfig(version: string, overrides: Partial<{
	maxObservations: number
	maxListCandidates: number
	maxContextCharacters: number
}> = {}) {
	return {
		recipeId: 'test.structured',
		version,
		maxObservations: overrides.maxObservations ?? 4,
		maxListCandidates: overrides.maxListCandidates ?? 6,
		maxContextCharacters: overrides.maxContextCharacters ?? 10_000,
	}
}

const validator: LearningItemValidatorCapability = {
	parse(value) {
		return itemDataSchema.parse(value)
	},
	validateTransition(previous, next) {
		if (previous.title !== next.title) throw new Error('title identity cannot change')
	},
}

async function execute(
	registry: LearningRegistry,
	version: string,
	model: LearningModelCapability,
	options: {
		observations?: LearningObservation[]
		processedInputIds?: string[]
		memory?: ListMemorySnapshot
		memoryRevision?: number
	} = {},
) {
	const observations = options.observations ?? [
		observation('input-1', 'Send the Q3 report to legal by Friday.'),
	]
	const processedInputIds = options.processedInputIds ?? []
	const memory = options.memory ?? {
		id: 'list-memory',
		revision: options.memoryRevision ?? 3,
		items: [],
		processedInputIds,
		candidateContextTruncated: false,
	}
	const roots = {
		lens: {
			schema: learningLensValueSchema,
			value: {
				purpose: 'Track commitments and their state.',
				memoryType: 'list',
				schema: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						status: { enum: ['open', 'completed'] },
					},
					required: ['title', 'status'],
				},
				developerConstraints:
					'Use only supplied observations. Preserve stable commitment identity.',
				identityRules:
					'The recipient is part of identity; similar report wording alone is not identity.',
			},
		},
		memory: { schema: listMemorySnapshotValueSchema, value: memory },
		observations: {
			schema: learningObservationsValueSchema,
			value: observations,
		},
		processedInputIds: {
			schema: stringArrayValueSchema,
			value: processedInputIds,
		},
	}
	const plan = planRecipe(registry, {
		recipe: { id: 'test.structured', version },
		roots,
		memoryType: 'list',
		availableCapabilities: new Set([
			LEARNING_MODEL_CAPABILITY,
			LEARNING_ID_CAPABILITY,
			LEARNING_ITEM_VALIDATOR_CAPABILITY,
		]),
		revisions: { memory: 3, configuration: 2, registry: 'registry-1' },
		limits: { maxNodes: 12, maxCollectionItems: 4, maxOperations: 24 },
	})
	const claims: Array<{ kind: string; nodeId: string }> = []
	let nextItemId = 0
	const capabilities = new Map<string, unknown>([
		[LEARNING_MODEL_CAPABILITY, model],
		[
			LEARNING_ID_CAPABILITY,
			{ next: () => `generated-item-${(nextItemId += 1)}` },
		],
		[LEARNING_ITEM_VALIDATOR_CAPABILITY, validator],
	])
	return runRecipe(plan, {
		signal: new AbortController().signal,
		capabilities: {
			has: (id) => capabilities.has(id),
			get: <T>(id: string) => capabilities.get(id) as T | undefined,
		},
		budget: {
			claim(claim) {
				claims.push(claim)
				return true
			},
			snapshot: () => ({ claims: [...claims] }),
		},
	})
}

describe('built-in structured state recipe', () => {
	it('consumes exact duplicate delivery without calling the model', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, {
			processedInputIds: ['input-1'],
		})
		expect(output.result).toEqual({
			outcome: 'no_change',
			reason: 'candidate states are unchanged',
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('adds a distinct commitment with a supplied stable item id', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const data = { title: 'Send Q3 report to legal', status: 'open' }
		const model = new QueuedModel([
			extraction([{ id: 'candidate-1', data, sourceObservationIds: ['input-1'] }]),
			resolution({
				candidateId: 'candidate-1',
				decision: 'new_item',
				reason: 'No matching recipient exists.',
			}),
			transitions({
				candidateId: 'candidate-1',
				action: 'add',
				data,
				observationIds: ['input-1'],
				reason: 'Explicit new commitment.',
			}),
		])
		const output = await execute(registry, '1', model)
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: {
				actions: [
					{ kind: 'add', item: { id: 'generated-item-1', data } },
				],
			},
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
		expect(model.generateRequests).toHaveLength(3)
		const extractionPrompt = JSON.parse(model.generateRequests[0]?.prompt ?? '')
		expect(extractionPrompt.itemSchema).toEqual({
			type: 'object',
			properties: {
				title: { type: 'string' },
				status: { enum: ['open', 'completed'] },
			},
			required: ['title', 'status'],
		})
		const claims = (output.budget as { claims: Array<{ kind: string }> }).claims
		expect(claims.filter(({ kind }) => kind === 'provider_call')).toHaveLength(3)
	})

	it('updates a matched stable item using only bounded retrieved memory', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(
			registry,
			recipeConfig('1', { maxListCandidates: 1 }),
		)
		const current = {
			id: 'commit-a',
			data: { title: 'Send Q3 report to finance', status: 'open' as const },
		}
		const omitted = {
			id: 'commit-b',
			data: { title: 'Book the hidden room', status: 'open' as const },
		}
		const data = { title: current.data.title, status: 'completed' }
		const model = new QueuedModel([
			extraction([{ id: 'candidate-1', data, sourceObservationIds: ['input-1'] }]),
			resolution({
				candidateId: 'candidate-1',
				decision: 'existing',
				matchedItemId: 'commit-a',
				reason: 'Same recipient and report.',
			}),
			transitions({
				candidateId: 'candidate-1',
				action: 'update',
				data: { status: 'completed' },
				observationIds: ['input-1'],
				reason: 'Completion was explicit.',
			}),
		])
		const output = await execute(registry, '1', model, {
			memory: {
				id: 'list-memory',
				revision: 3,
				items: [current, omitted],
				processedInputIds: [],
				candidateContextTruncated: false,
			},
		})
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: {
				actions: [
					{
						kind: 'update',
						itemId: 'commit-a',
						data: { title: current.data.title, status: 'completed' },
					},
				],
			},
		})
		expect(model.generateRequests[2]?.prompt).not.toContain('Book the hidden room')
	})

	it('commits a resolved input while leaving an independent unknown input pending', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const second = observation('input-2', 'The report is ready.')
		const firstData = { title: 'Send Q3 report to legal', status: 'open' }
		const secondData = { title: 'Prepare report', status: 'completed' }
		const model = new QueuedModel([
			extraction([
				{ id: 'candidate-1', data: firstData, sourceObservationIds: ['input-1'] },
				{ id: 'candidate-2', data: secondData, sourceObservationIds: ['input-2'] },
			]),
			resolution(
				{
					candidateId: 'candidate-1',
					decision: 'new_item',
					reason: 'Distinct legal commitment.',
				},
				{
					candidateId: 'candidate-2',
					decision: 'unknown',
					reason: 'Report identity is ambiguous.',
				},
			),
			transitions({
				candidateId: 'candidate-1',
				action: 'add',
				data: firstData,
				observationIds: ['input-1'],
				reason: 'Explicit new commitment.',
			}),
		])
		const output = await execute(registry, '1', model, {
			observations: [
				observation('input-1', 'Send the Q3 report to legal by Friday.'),
				second,
			],
		})
		expect(output.result).toMatchObject({
			outcome: 'change',
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2'],
			patch: { actions: [{ kind: 'add' }] },
		})
		const transitionPrompt = JSON.parse(model.generateRequests[2]?.prompt ?? '')
		expect(transitionPrompt.candidates).toHaveLength(1)
		expect(transitionPrompt.candidates[0].id).toBe('candidate-1')
	})

	it('allows one observation to create two distinct structured items', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const first = { title: 'Send Q3 report to legal', status: 'open' }
		const second = { title: 'Schedule legal review', status: 'open' }
		const model = new QueuedModel([
			extraction([
				{ id: 'candidate-1', data: first, sourceObservationIds: ['input-1'] },
				{ id: 'candidate-2', data: second, sourceObservationIds: ['input-1'] },
			]),
			resolution(
				{
					candidateId: 'candidate-1',
					decision: 'new_item',
					reason: 'The report delivery is new.',
				},
				{
					candidateId: 'candidate-2',
					decision: 'new_item',
					reason: 'The review is a distinct commitment.',
				},
			),
			transitions(
				{
					candidateId: 'candidate-1',
					action: 'add',
					data: first,
					observationIds: ['input-1'],
					reason: 'Explicit commitment.',
				},
				{
					candidateId: 'candidate-2',
					action: 'add',
					data: second,
					observationIds: ['input-1'],
					reason: 'Explicit commitment.',
				},
			),
		])
		const output = await execute(registry, '1', model, {
			observations: [
				observation(
					'input-1',
					'Send the Q3 report to legal and schedule the legal review.',
				),
			],
		})
		expect(output.result).toMatchObject({
			outcome: 'change',
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
			patch: {
				actions: [
					{ kind: 'add', item: { id: 'generated-item-1', data: first } },
					{ kind: 'add', item: { id: 'generated-item-2', data: second } },
				],
			},
		})
	})

	it('defers every linked candidate when one transition remains unresolved', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const first = { title: 'Send Q3 report to legal', status: 'open' }
		const second = { title: 'Schedule legal review', status: 'open' }
		const model = new QueuedModel([
			extraction([
				{ id: 'candidate-1', data: first, sourceObservationIds: ['input-1'] },
				{ id: 'candidate-2', data: second, sourceObservationIds: ['input-1'] },
			]),
			resolution(
				{
					candidateId: 'candidate-1',
					decision: 'new_item',
					reason: 'The report delivery is new.',
				},
				{
					candidateId: 'candidate-2',
					decision: 'new_item',
					reason: 'The review is new.',
				},
			),
			transitions(
				{
					candidateId: 'candidate-1',
					action: 'add',
					data: first,
					observationIds: ['input-1'],
					reason: 'Explicit commitment.',
				},
				{
					candidateId: 'candidate-2',
					action: 'defer',
					observationIds: ['input-1'],
					reason: 'The review timing is unresolved.',
				},
			),
		])
		const output = await execute(registry, '1', model)
		expect(output.result).toEqual({
			outcome: 'defer',
			reason: 'one or more structured inputs remain unresolved',
			consumedInputIds: [],
			pendingInputIds: ['input-1'],
		})
	})

	it('propagates defer through transitively shared observations', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const first = { title: 'Send Q3 report to legal', status: 'open' }
		const bridge = { title: 'Prepare legal review', status: 'open' }
		const last = { title: 'Book the review room', status: 'open' }
		const model = new QueuedModel([
			extraction([
				{ id: 'candidate-1', data: first, sourceObservationIds: ['input-1'] },
				{
					id: 'candidate-2',
					data: bridge,
					sourceObservationIds: ['input-1', 'input-2'],
				},
				{ id: 'candidate-3', data: last, sourceObservationIds: ['input-2'] },
			]),
			resolution(
				{
					candidateId: 'candidate-1',
					decision: 'new_item',
					reason: 'New report commitment.',
				},
				{
					candidateId: 'candidate-2',
					decision: 'new_item',
					reason: 'New preparation commitment.',
				},
				{
					candidateId: 'candidate-3',
					decision: 'unknown',
					reason: 'Room identity is unresolved.',
				},
			),
		])
		const output = await execute(registry, '1', model, {
			observations: [
				observation('input-1', 'Send the report and prepare legal review.'),
				observation('input-2', 'Prepare legal review and book its room.'),
			],
		})
		expect(output.result).toMatchObject({
			outcome: 'defer',
			consumedInputIds: [],
			pendingInputIds: ['input-1', 'input-2'],
		})
		expect(model.generateRequests).toHaveLength(2)
	})

	it('rejects two candidate updates to the same stable item', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const current = {
			id: 'commit-a',
			data: { title: 'Send Q3 report to legal', status: 'open' as const },
		}
		const completed = { title: current.data.title, status: 'completed' }
		const model = new QueuedModel([
			extraction([
				{
					id: 'candidate-1',
					data: completed,
					sourceObservationIds: ['input-1'],
				},
				{
					id: 'candidate-2',
					data: completed,
					sourceObservationIds: ['input-2'],
				},
			]),
			resolution(
				{
					candidateId: 'candidate-1',
					decision: 'existing',
					matchedItemId: 'commit-a',
					reason: 'Same commitment.',
				},
				{
					candidateId: 'candidate-2',
					decision: 'existing',
					matchedItemId: 'commit-a',
					reason: 'Same commitment.',
				},
			),
			transitions(
				{
					candidateId: 'candidate-1',
					action: 'update',
					data: { status: 'completed' },
					observationIds: ['input-1'],
					reason: 'Completion is explicit.',
				},
				{
					candidateId: 'candidate-2',
					action: 'update',
					data: { status: 'completed' },
					observationIds: ['input-2'],
					reason: 'Repeated completion.',
				},
			),
		])
		const output = await execute(registry, '1', model, {
			observations: [
				observation('input-1', 'The legal report is complete.'),
				observation('input-2', 'The same legal report is complete.'),
			],
			memory: {
				id: 'list-memory',
				revision: 3,
				items: [current],
				processedInputIds: [],
				candidateContextTruncated: false,
			},
		})
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(output.nodes.find(({ nodeId }) => nodeId === 'validate')?.status).toBe(
			'failed',
		)
	})

	it('rejects overlapping or incomplete extraction coverage', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const model = new QueuedModel([
			{
				...extraction([
					{
						id: 'candidate-1',
						data: { title: 'Send report', status: 'open' },
						sourceObservationIds: ['input-1'],
					},
				]),
				pendingObservationIds: ['input-1'],
			},
		])
		const output = await execute(registry, '1', model)
		expect(output.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
		expect(output.nodes.find(({ nodeId }) => nodeId === 'check-extraction')?.status).toBe('failed')
		expect(model.generateRequests).toHaveLength(1)
	})

	it('rejects extracted candidate data that violates the declared item schema', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const model = new QueuedModel([
			extraction([
				{
					id: 'candidate-1',
					data: { title: 'Send report', status: 'invented-state' },
					sourceObservationIds: ['input-1'],
				},
			]),
		])
		const output = await execute(registry, '1', model)
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(
			output.nodes.find(({ nodeId }) => nodeId === 'check-extraction')?.status,
		).toBe('failed')
		expect(model.generateRequests).toHaveLength(1)
	})

	it('rejects an existing resolution outside bounded matches', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const data = { title: 'Send report', status: 'open' }
		const model = new QueuedModel([
			extraction([{ id: 'candidate-1', data, sourceObservationIds: ['input-1'] }]),
			resolution({
				candidateId: 'candidate-1',
				decision: 'existing',
				matchedItemId: 'missing-item',
				reason: 'Claimed match.',
			}),
		])
		const output = await execute(registry, '1', model)
		expect(output.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
		expect(output.nodes.find(({ nodeId }) => nodeId === 'check-resolution')?.status).toBe('failed')
		expect(model.generateRequests).toHaveLength(2)
	})

	it('returns collection overflow as pending while consuming settled work', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(
			registry,
			recipeConfig('1', { maxObservations: 1 }),
		)
		const model = new QueuedModel([extraction([], ['input-1'])])
		const output = await execute(registry, '1', model, {
			observations: [
				observation('input-1', 'An unrelated cafeteria note.'),
				observation('input-2', 'Send the Q3 report to legal.'),
			],
		})
		expect(output.result).toEqual({
			outcome: 'defer',
			reason: 'one or more structured inputs remain unresolved',
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2'],
		})
		expect(output.pending).toMatchObject([{ nodeId: 'screen' }])
	})

	it('keeps oversized supplied context pending without a provider call', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(
			registry,
			recipeConfig('1', { maxContextCharacters: 20 }),
		)
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model)
		expect(output.result).toMatchObject({
			outcome: 'defer',
			consumedInputIds: [],
			pendingInputIds: ['input-1'],
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('rejects a stale memory snapshot before a provider call', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(registry, recipeConfig('1'))
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, { memoryRevision: 2 })
		expect(output.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
		expect(model.generateRequests).toHaveLength(0)
	})

	it('isolates recipe versions and snapshots mutable registration settings', async () => {
		const registry = new LearningRegistry()
		registerStructuredStateRecipe(
			registry,
			recipeConfig('1', { maxContextCharacters: 20 }),
		)
		const mutable = recipeConfig('2')
		registerStructuredStateRecipe(registry, mutable)
		mutable.maxContextCharacters = 20
		const firstModel = new QueuedModel([])
		const first = await execute(registry, '1', firstModel)
		expect(first.result).toMatchObject({ outcome: 'defer' })
		const secondModel = new QueuedModel([extraction([], ['input-1'])])
		const second = await execute(registry, '2', secondModel)
		expect(second.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
		})
		expect(secondModel.generateRequests).toHaveLength(1)
	})
})
