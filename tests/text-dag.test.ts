import { describe, expect, it } from 'vitest'

import type {
	LearningDecisionResult,
	LearningModelCapability,
	LearningTextGenerationRequest,
	LearningTextGenerationResult,
	SemanticStage,
} from '../src/learning'
import type {
	AdaptLLMPlugin,
	AdaptModelConfig,
	AdaptModelTurnRequest,
} from '../src/llm'
import { MemoryNeuronStore } from '../src/stores/memory'
import {
	createAdaptTextDagObserver,
	createTextDagLearner,
	type TextDagConfig,
	type TextDagDependencies,
	type TextDagObserver,
} from '../src/neurons/text/dag'

class TestClock {
	private tick = 0
	now(): string {
		const value = new Date(Date.UTC(2026, 9, 1, 8, 0, this.tick))
		this.tick += 1
		return value.toISOString()
	}
}

class TestIds {
	private nextId = 0
	next(kind: string): string {
		this.nextId += 1
		return `${kind}-${this.nextId}`
	}
}

class QueuedModel implements LearningModelCapability {
	readonly requests: unknown[] = []
	readonly textRequests: LearningTextGenerationRequest[] = []
	constructor(
		private readonly values: Array<
			| unknown
			| Error
			| ((request: Parameters<LearningModelCapability['generate']>[0]) => unknown)
		>,
		private readonly events?: string[],
		private readonly textValues: Array<string | Error> = [],
	) {}

	async generate<T>(
		request: Parameters<LearningModelCapability['generate']>[0],
	): Promise<SemanticStage<T>> {
		this.events?.push('narrative')
		this.requests.push(request)
		const queued = this.values.shift()
		if (queued instanceof Error) throw queued
		const raw = typeof queued === 'function' ? queued(request) : queued
		return { value: request.schema.parse(raw) as T, raw }
	}

	async generateText(
		request: LearningTextGenerationRequest,
	): Promise<LearningTextGenerationResult> {
		this.events?.push('narrative')
		this.textRequests.push(request)
		const value = this.textValues.shift()
		if (value instanceof Error) throw value
		if (value === undefined) throw new Error('missing queued text generation')
		return { value, raw: value, finishReason: 'stop' }
	}

	async decide<TAnswer extends string>(): Promise<
		LearningDecisionResult<TAnswer>
	> {
		throw new Error('the narrative recipe does not call decide')
	}
}

function config(
	outputMode?: 'edit-action' | 'plain-text',
): TextDagConfig {
	return {
		neuronId: 'preferences',
		memoryId: 'current',
		registryRevision: 'text-dag-test-1',
		instructions: 'Remember durable interface preferences.',
		purpose: 'Maintain durable interface preferences.',
		developerConstraints: 'Use only supplied evidence.',
		identityRules: 'Keep scoped preferences distinct.',
		observationSchema: { type: 'string' },
		understandingSchema: { type: 'string' },
		observe: {
			recipeId: 'test.text.observe',
			operationId: 'test.text.observe.run',
			version: '1',
		},
		narrative: {
			recipeId: 'test.text.narrative',
			version: '1',
			...(outputMode === undefined ? {} : { outputMode }),
			maxObservations: 4,
			maxObservationCharacters: 500,
			maxMemoryCharacters: 2_000,
			maxContextCharacters: 10_000,
		},
		planningLimits: {
			maxNodes: 8,
			maxCollectionItems: 4,
			maxOperations: 12,
		},
		maxProviderCalls: 4,
	}
}

function dependencies(
	store: MemoryNeuronStore,
	observer: TextDagObserver,
	model: LearningModelCapability,
	textDagConfig: TextDagConfig = config(),
): TextDagDependencies {
	return {
		store,
		observer,
		model,
		clock: new TestClock(),
		ids: new TestIds(),
		config: textDagConfig,
	}
}

function observed(
	text: string,
	events?: string[],
): TextDagObserver {
	return {
		async observe() {
			events?.push('observe')
			return {
				status: 'observed',
				output: [text],
				importance: 0.8,
				gaps: [],
			}
		},
	}
}

function append(text: string) {
	return {
		action: 'append',
		target: '',
		text,
		reason: 'The observation adds a durable preference.',
	}
}

describe('standalone Text DAG learner', () => {
	it('runs observe before the fixed narrative DAG and commits two sequential deliveries', async () => {
		const store = new MemoryNeuronStore()
		const events: string[] = []
		const model = new QueuedModel(
			[append('Uses compact navigation.'), append('Uses visible labels.')],
			events,
		)
		const observer: TextDagObserver = {
			async observe(request) {
				events.push('observe')
				return {
					status: 'observed',
					output: [`Derived: ${String(request.context.data[0])}`],
					importance: 0.8,
					gaps: [],
				}
			},
		}
		const learner = createTextDagLearner(
			dependencies(store, observer, model),
		)

		const first = await learner.learn({ id: 'delivery-1', text: 'raw-one' })
		const second = await learner.learn({ id: 'delivery-2', text: 'raw-two' })

		expect(events).toEqual(['observe', 'narrative', 'observe', 'narrative'])
		expect(first.observeExecution?.nodes.map(({ nodeId }) => nodeId)).toEqual([
			'observe',
		])
		expect(
			first.narrativeExecution?.nodes.map(({ nodeId }) => nodeId),
		).toEqual(['screen', 'has-new', 'assess', 'validate'])
		expect(second.status).toBe('changed')
		expect(await learner.getUnderstanding()).toBe(
			'Uses compact navigation.\nUses visible labels.',
		)
		expect(second.revisions.memory_revision).toBe(4)
		expect(await store.pendingWork.list()).toEqual([])
		expect(
			(await store.observations.list()).map(({ data, metadata_status }) => ({
				data,
				metadata_status,
			})),
		).toEqual([
			{ data: 'Derived: raw-one', metadata_status: 'processed' },
			{ data: 'Derived: raw-two', metadata_status: 'processed' },
		])
	})

	it('threads plain-text mode through the narrative DAG and persists its complete replacement', async () => {
		const store = new MemoryNeuronStore()
		const observations = [
			'Prefers routine updates by email. Prefers planning on Tuesday.',
			'Now prefers routine updates in Signal instead of email.',
		]
		const observer: TextDagObserver = {
			async observe() {
				const text = observations.shift()
				if (text === undefined) throw new Error('missing queued observation')
				return { status: 'observed', output: [text], importance: 1, gaps: [] }
			},
		}
		const model = new QueuedModel([], undefined, [
			'Prefers routine updates by email. Prefers planning on Tuesday.',
			'Prefers routine updates in Signal. Prefers planning on Tuesday.',
		])
		const learner = createTextDagLearner(
			dependencies(store, observer, model, config('plain-text')),
		)

		expect(
			(await learner.learn({ id: 'plain-source-1', text: 'first raw input' }))
				.status,
		).toBe('changed')
		const revised = await learner.learn({
			id: 'plain-source-2',
			text: 'second raw input',
		})
		expect(revised.status).toBe('changed')
		expect(revised.narrativeExecution?.nodes.map(({ nodeId }) => nodeId)).toEqual(
			['screen', 'has-new', 'assess', 'validate'],
		)
		expect(model.requests).toHaveLength(0)
		expect(model.textRequests).toHaveLength(2)

		const reopened = createTextDagLearner(
			dependencies(store, observed('unused'), new QueuedModel([]), config('plain-text')),
		)
		expect(await reopened.getUnderstanding()).toBe(
			'Prefers routine updates in Signal. Prefers planning on Tuesday.',
		)
	})

	it('reads committed memory after recreating the learner and deduplicates source IDs', async () => {
		const store = new MemoryNeuronStore()
		let observeCalls = 0
		const observer: TextDagObserver = {
			async observe() {
				observeCalls += 1
				return {
					status: 'observed',
					output: ['A derived preference.'],
					importance: 1,
					gaps: [],
				}
			},
		}
		const first = createTextDagLearner(
			dependencies(store, observer, new QueuedModel([append('Saved memory.')])),
		)
		expect(
			(await first.learn({ id: 'stable-source-id', text: 'temporary raw text' }))
				.status,
		).toBe('changed')

		const reopened = createTextDagLearner(
			dependencies(store, observer, new QueuedModel([])),
		)
		expect(await reopened.getUnderstanding()).toBe('Saved memory.')
		const duplicate = await reopened.learn({
			id: 'stable-source-id',
			text: 'temporary raw text',
		})
		expect(duplicate.status).toBe('duplicate')
		expect(observeCalls).toBe(1)
		expect(await store.pendingWork.list()).toEqual([])
	})

	it('keeps failed source or derived work unresolved without archiving raw text', async () => {
		const observerStore = new MemoryNeuronStore()
		const observerFailure = createTextDagLearner(
			dependencies(
				observerStore,
				{
					async observe() {
						return {
							status: 'error',
							output: null,
							error: new Error('observer unavailable'),
						}
					},
				},
				new QueuedModel([]),
			),
		)
		const failedObserve = await observerFailure.learn({
			id: 'source-failure',
			text: 'raw pending text',
		})
		expect(failedObserve.status).toBe('failure')
		expect(await observerStore.pendingWork.list()).toMatchObject([
			{ input_ids: ['source-failure'], inputs: [{ text: 'raw pending text' }] },
		])

		const narrativeStore = new MemoryNeuronStore()
		const narrativeFailure = createTextDagLearner(
			dependencies(
				narrativeStore,
				observed('Derived only.'),
				new QueuedModel([
					{
						action: 'append',
						target: 'invalid target',
						text: 'Invalid result.',
						reason: 'Invalid tuple.',
					},
				]),
			),
		)
		const failedNarrative = await narrativeFailure.learn({
			id: 'source-consumed',
			text: 'raw discarded after observation',
		})
		expect(failedNarrative.status).toBe('failure')
		expect((await narrativeStore.observations.list())[0]?.metadata_status).toBe(
			'pending',
		)
		const unresolvedNarrativeWork = await narrativeStore.pendingWork.list()
		expect(unresolvedNarrativeWork).toHaveLength(1)
		expect('inputs' in (unresolvedNarrativeWork[0] ?? {})).toBe(false)
		expect(await narrativeStore.processedInputs.get('source-consumed')).toBeDefined()
	})

	it('uses the real observer prompt and explicit string schema inside the observe DAG node', async () => {
		const requests: AdaptModelTurnRequest[] = []
		const observerModel = {
			plugin: 'test-observer',
			id: 'shared-model',
		} satisfies AdaptModelConfig
		const llm: AdaptLLMPlugin = {
			id: 'test-observer',
			model: { toConfig: () => observerModel },
			async call(request) {
				requests.push(request)
				return {
					json: {
						status: 'observed',
						output: ['Exact derived observation.'],
						importance: 0.9,
						gaps: [],
					},
					raw: { provider: 'raw-observer-result' },
					toolCalls: [],
					finishReason: 'stop',
				}
			},
		}
		const learner = createTextDagLearner(
			dependencies(
				new MemoryNeuronStore(),
				createAdaptTextDagObserver({ llm, model: observerModel }),
				new QueuedModel([append('Learned through real observe.')]),
			),
		)

		const result = await learner.learn({
			id: 'real-observe-source',
			text: 'the exact raw delivery',
		})

		expect(result.status).toBe('changed')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.system).toContain(config().instructions)
		expect(JSON.stringify(requests[0]?.messages)).toContain(
			'the exact raw delivery',
		)
		expect(requests[0]?.output).toMatchObject({
			type: 'object',
		})
		expect(result.observeExecution?.nodes).toHaveLength(1)
		expect(result.observations.map(({ text }) => text)).toEqual([
			'Exact derived observation.',
		])
	})
})
