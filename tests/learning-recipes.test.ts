import { describe, expect, it } from 'vitest'

import type { AdaptFinishReason } from '../src/llm'

import {
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	learningLensValueSchema,
	learningObservationsValueSchema,
	planRecipe,
	registerNarrativeRecipe,
	runRecipe,
	stringArrayValueSchema,
	textMemorySnapshotValueSchema,
	type LearningDecisionResult,
	type LearningModelCapability,
	type LearningObservation,
	type LearningTextGenerationResult,
	type LearningTextGenerationRequest,
	type SemanticStage,
} from '../src/learning/index'

const observation: LearningObservation = {
	id: 'input-1',
	text: 'Financial records justify audit-trail complexity.',
	observedAt: '2026-09-30T12:00:00.000Z',
}

type QueuedGeneration = unknown | Error | ((request: unknown) => unknown)
type QueuedTextGeneration =
	| string
	| Error
	| ((request: LearningTextGenerationRequest) => string)

class QueuedModel implements LearningModelCapability {
	readonly generateRequests: unknown[] = []
	readonly textGenerateRequests: LearningTextGenerationRequest[] = []
	readonly decisionRequests: unknown[] = []
	constructor(
		readonly generations: QueuedGeneration[],
		readonly textGenerations: QueuedTextGeneration[] = [],
		readonly textFinishReasons: AdaptFinishReason[] = [],
	) {}
	async generate<T>(
		request: Parameters<LearningModelCapability['generate']>[0],
	): Promise<SemanticStage<T>> {
		this.generateRequests.push(request)
		const queued = this.generations.shift()
		if (queued instanceof Error) throw queued
		const value = typeof queued === 'function' ? queued(request) : queued
		return { value: request.schema.parse(value) as T, raw: value }
	}
	async generateText(
		request: LearningTextGenerationRequest,
	): Promise<LearningTextGenerationResult> {
		this.textGenerateRequests.push(request)
		const queued = this.textGenerations.shift()
		if (queued instanceof Error) throw queued
		const value = typeof queued === 'function' ? queued(request) : queued
		if (value === undefined) throw new Error('missing queued text generation')
		return {
			value,
			raw: value,
			finishReason: this.textFinishReasons.shift() ?? 'stop',
		}
	}
	async decide<TAnswer extends string>(
		request: Parameters<LearningModelCapability['decide']>[0],
	): Promise<LearningDecisionResult<TAnswer>> {
		this.decisionRequests.push(request)
		throw new Error('narrative recipe does not use a separate decision')
	}
}

function narrativeConfig(
	version: string,
	overrides: Partial<{
		outputMode: 'edit-action' | 'plain-text'
		maxObservations: number
		maxObservationCharacters: number
		maxMemoryCharacters: number
		maxContextCharacters: number
	}> = {},
) {
	return {
		recipeId: 'test.narrative',
		version,
		...(overrides.outputMode === undefined
			? {}
			: { outputMode: overrides.outputMode }),
		maxObservations: overrides.maxObservations ?? 4,
		maxObservationCharacters: overrides.maxObservationCharacters ?? 500,
		maxMemoryCharacters: overrides.maxMemoryCharacters ?? 2_000,
		maxContextCharacters: overrides.maxContextCharacters ?? 10_000,
	}
}

function unchanged(reason = 'The observation is already represented.') {
	return { action: 'unchanged', target: '', text: '', reason }
}

function appended(text: string, reason = 'The observation adds a durable detail.') {
	return { action: 'append', target: '', text, reason }
}

function replaced(target: string, text: string) {
	return {
		action: 'replace',
		target,
		text,
		reason: 'The observation explicitly corrects this passage.',
	}
}

function deferred(reason = 'The observation is tentative.') {
	return { action: 'defer', target: '', text: '', reason }
}

async function execute(
	registry: LearningRegistry,
	version: string,
	model: LearningModelCapability,
	options: {
		observations?: readonly LearningObservation[]
		processedInputIds?: readonly string[]
		memoryRevision?: number
		memoryText?: string
		maxProviderCalls?: number
		developerConstraints?: string
		signal?: AbortSignal
		resolveModel?: boolean
	} = {},
) {
	const observations = options.observations ?? [observation]
	const processedInputIds = options.processedInputIds ?? []
	const roots = {
		lens: {
			schema: learningLensValueSchema,
			value: {
				purpose: 'Maintain scoped preferences.',
				memoryType: 'text',
				schema: { type: 'string' },
				developerConstraints:
					options.developerConstraints ??
					'Use supplied evidence and preserve unrelated memory.',
				identityRules:
					'Keep contextual exceptions distinct from global reversals.',
			},
		},
		memory: {
			schema: textMemorySnapshotValueSchema,
			value: {
				id: 'memory-1',
				revision: options.memoryRevision ?? 3,
				text: options.memoryText ?? 'Prefers simple designs.',
				processedInputIds,
			},
		},
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
		recipe: { id: 'test.narrative', version },
		roots,
		memoryType: 'text',
		availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
		revisions: { memory: 3, configuration: 2, registry: 'registry-1' },
		limits: { maxNodes: 10, maxCollectionItems: 4, maxOperations: 20 },
	})
	const claims: Array<{ kind: string }> = []
	return runRecipe(plan, {
		signal: options.signal ?? new AbortController().signal,
		capabilities: {
			has: (id) => id === LEARNING_MODEL_CAPABILITY,
			get: <T>(id: string) =>
				id === LEARNING_MODEL_CAPABILITY && options.resolveModel !== false
					? (model as T)
					: undefined,
		},
		budget: {
			claim: (claim) => {
				if (
					claim.kind === 'provider_call' &&
					claims.filter(({ kind }) => kind === 'provider_call').length >=
						(options.maxProviderCalls ?? Number.POSITIVE_INFINITY)
				) {
					return false
				}
				claims.push(claim)
				return true
			},
			snapshot: () => ({ claims }),
		},
	})
}

function assessRaw(output: Awaited<ReturnType<typeof execute>>): unknown[] {
	const rawOutput = output.nodes.find(({ nodeId }) => nodeId === 'assess')
		?.rawOutput as
		| { assessments?: { raw?: unknown[] } }
		| undefined
	return rawOutput?.assessments?.raw ?? []
}

describe('built-in narrative recipe', () => {
	it('keeps versioned bounds isolated and snapshots mutable registration config', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { maxObservationCharacters: 10 }),
		)
		const mutable = narrativeConfig('2')
		registerNarrativeRecipe(registry, mutable)
		mutable.maxObservationCharacters = 1

		const first = new QueuedModel([])
		const firstOutput = await execute(registry, '1', first)
		expect(firstOutput.result).toMatchObject({
			outcome: 'defer',
			pendingInputIds: ['input-1'],
		})
		expect(first.generateRequests).toHaveLength(0)

		const second = new QueuedModel([unchanged()])
		const secondOutput = await execute(registry, '2', second)
		expect(secondOutput.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
		})
		expect(second.generateRequests).toHaveLength(1)
	})

	it('rejects a stale memory snapshot before a provider call', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, { memoryRevision: 2 })
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('consumes an exact duplicate without invoking the provider', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, {
			processedInputIds: ['input-1'],
		})
		expect(output.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('appends one scoped detail while preserving current understanding verbatim', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const addition =
			'For financial records, a clear audit trail justifies extra complexity.'
		const output = await execute(
			registry,
			'1',
			new QueuedModel([appended(addition)]),
		)
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { text: `Prefers simple designs.\n${addition}` },
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
	})

	it('settles reaffirmation without forcing a change', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const output = await execute(
			registry,
			'1',
			new QueuedModel([unchanged()]),
		)
		expect(output.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
		})
	})

	it('commits an independent useful observation while preserving ambiguity as pending', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const second = {
			...observation,
			id: 'input-2',
			text: 'I might prefer live review, but I am not sure.',
		}
		const addition =
			'For financial records, audit trails justify scoped complexity.'
		const output = await execute(
			registry,
			'1',
			new QueuedModel([appended(addition), deferred()]),
			{ observations: [observation, second] },
		)
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { text: `Prefers simple designs.\n${addition}` },
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2'],
		})
	})

	it('keeps a tentative observation pending without forcing an edit', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const tentative = {
			...observation,
			text: 'I might prefer live review, but I am not sure yet.',
		}
		const output = await execute(
			registry,
			'1',
			new QueuedModel([deferred('The preference is not settled.')]),
			{
				observations: [tentative],
				memoryText: 'Prefers asynchronous written design reviews.',
			},
		)
		expect(output.result).toEqual({
			outcome: 'defer',
			reason: 'The preference is not settled.',
			consumedInputIds: [],
			pendingInputIds: ['input-1'],
		})
	})

	it('applies an exact correction while preserving unrelated clauses', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const output = await execute(
			registry,
			'1',
			new QueuedModel([
				replaced('The region is eu-west.', 'The region is eu-central.'),
			]),
			{
				memoryText:
					'The region is eu-west. Releases require a signed change record.',
			},
		)
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: {
				text: 'The region is eu-central. Releases require a signed change record.',
			},
		})
	})

	it('rejects a nonunique replacement target and consumes nothing', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const output = await execute(
			registry,
			'1',
			new QueuedModel([replaced('Keep this.', 'Replace this.')]),
			{ memoryText: 'Keep this. Keep this.' },
		)
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(output.nodes.find(({ nodeId }) => nodeId === 'assess')?.status).toBe(
			'failed',
		)
	})

	it('rejects a malformed action tuple instead of treating it as settled', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const output = await execute(
			registry,
			'1',
			new QueuedModel([
				{
					...unchanged(),
					text: 'Unsupported edit.',
				},
			]),
		)
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(output.nodes.find(({ nodeId }) => nodeId === 'assess')?.status).toBe(
			'failed',
		)
	})

	it('rejects observation identifiers copied into learned text', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const output = await execute(
			registry,
			'1',
			new QueuedModel([appended('Evidence input-1 supports complexity.')]),
		)
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
	})

	it('enforces the memory bound after generation without a wire maxLength', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const model = new QueuedModel([appended('x'.repeat(2_001))])
		const output = await execute(registry, '1', model)
		expect(output.nodes.find(({ nodeId }) => nodeId === 'assess')?.status).toBe(
			'failed',
		)
		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		const request = model.generateRequests[0] as {
			schema: { safeParse(value: unknown): { success: boolean } }
		}
		expect(request.schema.safeParse(appended('x'.repeat(2_001))).success).toBe(
			true,
		)
	})

	it('defers an oversized complete request without truncating constraints', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { maxContextCharacters: 500 }),
		)
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, {
			developerConstraints: 'Preserve this supplied rule. '.repeat(100),
		})
		expect(output.result).toMatchObject({
			outcome: 'defer',
			pendingInputIds: ['input-1'],
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('passes bounded lens context and no observation identifier to each request', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const model = new QueuedModel([unchanged()])
		await execute(registry, '1', model)
		const request = model.generateRequests[0] as
			| { prompt: string; system: string }
			| undefined
		expect(request).toBeDefined()
		expect(JSON.parse(request?.prompt ?? '')).toEqual({
			lens: {
				purpose: 'Maintain scoped preferences.',
				memoryType: 'text',
				schema: { type: 'string' },
				identityRules:
					'Keep contextual exceptions distinct from global reversals.',
			},
			provisionalUnderstanding: 'Prefers simple designs.',
			observation: {
				text: 'Financial records justify audit-trail complexity.',
			},
		})
		expect(request?.prompt).not.toContain('input-1')
		expect(request?.system).toContain(
			'Preserve these immutable developer constraints verbatim:\nUse supplied evidence and preserve unrelated memory.',
		)
		expect(request?.system).toContain(
			'Return the final action directly; no earlier classification can force an edit.',
		)
		expect(request?.system).not.toContain('Cite evidence')
		expect(model.decisionRequests).toHaveLength(0)
	})

	it('uses plain text to replace the complete understanding through the existing patch contract', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { outputMode: 'plain-text' }),
		)
		const next =
			'Prefers simple designs. Financial records justify audit-trail complexity.'
		const model = new QueuedModel([], [next])
		const output = await execute(registry, '1', model)

		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { kind: 'replace_text', memoryId: 'memory-1', text: next },
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
		expect(model.generateRequests).toHaveLength(0)
		expect(model.textGenerateRequests).toHaveLength(1)
		expect(model.textGenerateRequests[0]).toMatchObject({
			system: expect.stringContaining(
				'Purpose:\nMaintain scoped preferences.',
			),
			prompt:
				'Current understanding:\nPrefers simple designs.\n\nObservation:\nFinancial records justify audit-trail complexity.',
		})
		expect(model.textGenerateRequests[0]?.system).toContain(
			'Preserve these immutable developer constraints verbatim:\nUse supplied evidence and preserve unrelated memory.',
		)
	})

	it('maps exact plain text to no change and initial plain text to append', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { outputMode: 'plain-text' }),
		)
		const model = new QueuedModel([], [
			'Prefers simple designs.',
			'Financial records justify audit-trail complexity.',
		])
		const unchangedOutput = await execute(registry, '1', model)
		const initialOutput = await execute(registry, '1', model, { memoryText: '' })

		expect(unchangedOutput.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
			pendingInputIds: [],
		})
		expect(initialOutput.result).toMatchObject({
			outcome: 'change',
			patch: {
				text: 'Financial records justify audit-trail complexity.',
			},
		})
	})

	it('keeps blank plain output and provider failure pending', async () => {
		for (const generation of ['   ', new Error('provider unavailable')]) {
			const registry = new LearningRegistry()
			registerNarrativeRecipe(
				registry,
				narrativeConfig('1', { outputMode: 'plain-text' }),
			)
			const output = await execute(
				registry,
				'1',
				new QueuedModel([], [generation]),
			)
			expect(output.result).toMatchObject({
				outcome: 'defer',
				consumedInputIds: [],
				pendingInputIds: ['input-1'],
			})
		}
	})

	it.each(['length', 'tool-calls', 'error', 'unknown'] as const)(
		'keeps noncomplete plain output pending for finish reason %s',
		async (finishReason) => {
			const registry = new LearningRegistry()
			registerNarrativeRecipe(
				registry,
				narrativeConfig('1', { outputMode: 'plain-text' }),
			)
			const output = await execute(
				registry,
				'1',
				new QueuedModel([], ['Partial revised memory.'], [finishReason]),
			)

			expect(output.result).toMatchObject({
				outcome: 'defer',
				consumedInputIds: [],
				pendingInputIds: ['input-1'],
			})
			expect(output.result).not.toHaveProperty('patch')
			expect(assessRaw(output)[0]).toMatchObject({
				message: `plain-text generation did not complete with stop: ${finishReason}`,
				cause: 'Partial revised memory.',
			})
		},
	)

	it('keeps duplicate and revision guards ahead of plain generation', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { outputMode: 'plain-text' }),
		)
		const model = new QueuedModel([], ['unused'])
		const duplicate = await execute(registry, '1', model, {
			processedInputIds: ['input-1'],
		})
		const stale = await execute(registry, '1', model, { memoryRevision: 2 })

		expect(duplicate.result).toMatchObject({
			outcome: 'no_change',
			consumedInputIds: ['input-1'],
		})
		expect(stale.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})
		expect(model.textGenerateRequests).toHaveLength(0)
	})

	it('fails plain mode clearly when the model lacks plain-text generation', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { outputMode: 'plain-text' }),
		)
		const queued = new QueuedModel([])
		const structuredOnly: LearningModelCapability = {
			generate: queued.generate.bind(queued),
			decide: queued.decide.bind(queued),
		}
		const output = await execute(registry, '1', structuredOnly)

		expect(output.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
			reason:
				'learning model capability does not support plain-text generation',
		})
	})

	it('rejects oversized plain output and preserves abort cancellation', async () => {
		const boundedRegistry = new LearningRegistry()
		registerNarrativeRecipe(
			boundedRegistry,
			narrativeConfig('1', {
				outputMode: 'plain-text',
				maxMemoryCharacters: 20,
			}),
		)
		const oversized = await execute(
			boundedRegistry,
			'1',
			new QueuedModel([], ['x'.repeat(21)]),
			{ memoryText: 'Short.' },
		)
		expect(oversized.result).toMatchObject({
			outcome: 'failure',
			code: 'operation_failed',
		})

		const cancelledRegistry = new LearningRegistry()
		registerNarrativeRecipe(
			cancelledRegistry,
			narrativeConfig('1', { outputMode: 'plain-text' }),
		)
		const controller = new AbortController()
		controller.abort(new Error('cancel plain generation'))
		const cancelledModel = new QueuedModel([], ['unused'])
		const cancelled = await execute(cancelledRegistry, '1', cancelledModel, {
			signal: controller.signal,
		})
		expect(cancelled.result).toMatchObject({
			outcome: 'failure',
			code: 'cancelled',
		})
		expect(cancelledModel.textGenerateRequests).toHaveLength(0)
	})

	it('shows each later observation the accepted provisional edit', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const second = {
			...observation,
			id: 'input-2',
			text: 'Auditability can justify the added complexity.',
		}
		const addition =
			'For financial records, audit trails justify scoped complexity.'
		const model = new QueuedModel([appended(addition), unchanged()])
		const output = await execute(registry, '1', model, {
			observations: [observation, second],
		})
		const secondRequest = model.generateRequests[1] as { prompt: string }
		expect(JSON.parse(secondRequest.prompt)).toMatchObject({
			provisionalUnderstanding: `Prefers simple designs.\n${addition}`,
		})
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { text: `Prefers simple designs.\n${addition}` },
			consumedInputIds: ['input-1', 'input-2'],
		})
	})

	it('composes a later correction against the provisional edit', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const second = {
			...observation,
			id: 'input-2',
			text: 'Correction: the audit trail is required only for regulated records.',
		}
		const first = 'Audit trails justify complexity for financial records.'
		const corrected =
			'Audit trails justify complexity only for regulated financial records.'
		const model = new QueuedModel([appended(first), replaced(first, corrected)])
		const output = await execute(registry, '1', model, {
			observations: [observation, second],
		})
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { text: `Prefers simple designs.\n${corrected}` },
			consumedInputIds: ['input-1', 'input-2'],
		})
	})

	it('preserves completed work and pending IDs when a later provider call fails', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const second = { ...observation, id: 'input-2', text: 'A second fact.' }
		const third = { ...observation, id: 'input-3', text: 'A third fact.' }
		const addition = 'Audit trails justify scoped complexity.'
		const failure = new Error('local provider unavailable')
		const output = await execute(
			registry,
			'1',
			new QueuedModel([appended(addition), failure]),
			{ observations: [observation, second, third] },
		)
		expect(output.result).toMatchObject({
			outcome: 'change',
			patch: { text: `Prefers simple designs.\n${addition}` },
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2', 'input-3'],
		})
		expect(assessRaw(output)).toEqual([appended(addition), failure])
	})

	it('preserves remaining observations when provider budget is exhausted', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const second = { ...observation, id: 'input-2', text: 'A second fact.' }
		const third = { ...observation, id: 'input-3', text: 'A third fact.' }
		const addition = 'Audit trails justify scoped complexity.'
		const output = await execute(
			registry,
			'1',
			new QueuedModel([appended(addition)]),
			{
				observations: [observation, second, third],
				maxProviderCalls: 1,
			},
		)
		expect(output.result).toMatchObject({
			outcome: 'change',
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2', 'input-3'],
		})
	})

	it('keeps edit-action budget exhaustion ahead of model resolution', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(registry, narrativeConfig('1'))
		const model = new QueuedModel([])
		const output = await execute(registry, '1', model, {
			maxProviderCalls: 0,
			resolveModel: false,
		})

		expect(output.result).toMatchObject({
			outcome: 'defer',
			consumedInputIds: [],
			pendingInputIds: ['input-1'],
		})
		expect(model.generateRequests).toHaveLength(0)
	})

	it('returns collection overflow as pending input', async () => {
		const registry = new LearningRegistry()
		registerNarrativeRecipe(
			registry,
			narrativeConfig('1', { maxObservations: 1 }),
		)
		const second = { ...observation, id: 'input-2', text: 'A second fact.' }
		const output = await execute(
			registry,
			'1',
			new QueuedModel([unchanged()]),
			{ observations: [observation, second] },
		)
		expect(output.result).toMatchObject({
			outcome: 'defer',
			consumedInputIds: ['input-1'],
			pendingInputIds: ['input-2'],
		})
	})
})
