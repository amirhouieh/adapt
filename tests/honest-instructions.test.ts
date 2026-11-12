import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { MemoryNeuronStore, TextNeuron } from '../src'

function createQueuedJsonModel(responses: unknown[]) {
	let callCount = 0
	const prompts: Array<{ system?: string; prompt: string }> = []
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'honest-instructions',
		supportedUrls: {},
		async doGenerate(
			opts: LanguageModelV3CallOptions,
		): Promise<LanguageModelV3GenerateResult> {
			prompts.push({
				system:
					typeof opts.prompt?.[0]?.content === 'string'
						? opts.prompt[0].content
						: undefined,
				prompt: JSON.stringify(opts.prompt),
			})
			const response = responses[callCount++]
			if (!response) {
				throw new Error(`No queued response for call ${callCount}`)
			}
			return {
				content: [{ type: 'text', text: JSON.stringify(response) }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: {
					id: `r-${callCount}`,
					timestamp: new Date(),
					modelId: 'honest-instructions',
				},
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return {
		model: model as unknown as LanguageModel,
		getCallCount: () => callCount,
		getPrompts: () => prompts,
	}
}

function skillsResponse() {
	return { skills: [], dynamicsSkills: [] }
}

function makeState(id: string, value: unknown) {
	return { id, value, updated_at: new Date().toISOString() }
}

describe('honest neuron instructions', () => {
	it('puts verbatim phase instructions into runtime prompts', async () => {
		const instructions = 'Shared rule R0. NEVER invent facts.'
		const observeInstructions = 'Observe rule R1. Keep feature requests as P3.'
		const understandInstructions =
			'Understand rule R2. DATA LOSS IS ALWAYS P0.'
		const focus = 'Focus rule R3. Ignore customer tone.'
		const { model } = createQueuedJsonModel([skillsResponse()])

		const neuron = await TextNeuron.create({
			id: 'incidents',
			model,
			store: new MemoryNeuronStore(),
			instructions,
			observeInstructions,
			understandInstructions,
			focus,
		})

		const observePrompt = neuron.getObserveSystemPrompt() ?? ''
		const understandPrompt = neuron.getUnderstandSystemPrompt() ?? ''

		expect(observePrompt).toContain(observeInstructions)
		expect(observePrompt).toContain(focus)
		expect(observePrompt).not.toContain(understandInstructions)
		expect(understandPrompt).toContain(understandInstructions)
		expect(understandPrompt).not.toContain(observeInstructions)
		expect(understandPrompt).not.toContain(focus)
	})

	it('omits the developer-instructions layer when resolved instructions are empty', async () => {
		const { model } = createQueuedJsonModel([skillsResponse()])

		const neuron = await TextNeuron.create({
			id: 'empty',
			model,
			store: new MemoryNeuronStore(),
			instructions: '',
		})

		expect(neuron.getObserveSystemPrompt()).toContain('observe phase')
		expect(neuron.getObserveSystemPrompt()).not.toContain(
			'## Developer Instructions',
		)
		expect(neuron.getUnderstandSystemPrompt()).toContain('understand phase')
		expect(neuron.getUnderstandSystemPrompt()).not.toContain(
			'## Developer Instructions',
		)
	})

	it('regenerates only affected prompts for phase-instruction updates', async () => {
		const queued = createQueuedJsonModel([
			skillsResponse(),
			skillsResponse(),
			skillsResponse(),
		])

		const neuron = await TextNeuron.create({
			id: 'updates',
			model: queued.model,
			store: new MemoryNeuronStore(),
			instructions: 'Shared R0.',
			observeInstructions: 'Observe R1.',
			understandInstructions: 'Understand R2.',
			focus: 'Focus R3.',
		})
		expect(queued.getCallCount()).toBe(1)

		const initialUnderstand = neuron.getUnderstandSystemPrompt()
		await neuron.update({ observeInstructions: 'Observe R1 updated.' })
		expect(queued.getCallCount()).toBe(1)
		expect(neuron.getObserveSystemPrompt()).toContain('Observe R1 updated.')
		expect(neuron.getUnderstandSystemPrompt()).toBe(initialUnderstand)

		const observeAfterObserveUpdate = neuron.getObserveSystemPrompt()
		await neuron.update({ understandInstructions: 'Understand R2 updated.' })
		expect(queued.getCallCount()).toBe(2)
		expect(neuron.getUnderstandSystemPrompt()).toContain(
			'Understand R2 updated.',
		)
		expect(neuron.getObserveSystemPrompt()).toBe(observeAfterObserveUpdate)

		await neuron.update({ instructions: 'Shared R0 updated.' })
		expect(queued.getCallCount()).toBe(3)
		expect(neuron.getObserveSystemPrompt()).toContain('Observe R1 updated.')
		expect(neuron.getObserveSystemPrompt()).not.toContain('Shared R0 updated.')
		expect(neuron.getUnderstandSystemPrompt()).toContain(
			'Understand R2 updated.',
		)
		expect(neuron.getUnderstandSystemPrompt()).not.toContain(
			'Shared R0 updated.',
		)
	})

	it('adjusts raw instruction fields and rebuilds prompts without observe identity', async () => {
		const queued = createQueuedJsonModel([
			skillsResponse(),
			{
				adjustConfig: true,
				adjustUnderstanding: false,
				reasoning: 'Directive changes behavior only.',
			},
			{
				instructions: 'Shared v2.',
				observeInstructions: 'Observe v2 R1.',
				understandInstructions: 'Understand v2 R2.',
				focus: 'Focus v2 R3.',
			},
			skillsResponse(),
		])

		const neuron = await TextNeuron.create({
			id: 'adjust',
			model: queued.model,
			store: new MemoryNeuronStore(),
			instructions: 'Shared v1.',
		})

		const result = await neuron.adjust('Track the new incident rubric.')

		expect(result.adjustedConfig).toBe(true)
		expect(result.adjustedUnderstanding).toBe(false)
		expect(neuron.getObserveSystemPrompt()).toContain('Observe v2 R1.')
		expect(neuron.getObserveSystemPrompt()).toContain('Focus v2 R3.')
		expect(neuron.getUnderstandSystemPrompt()).toContain('Understand v2 R2.')
		expect(neuron.getObserveSystemPrompt()).not.toContain('identity')
	})

	it('migrates legacy restored prompts to the deterministic instruction prompts', async () => {
		const store = new MemoryNeuronStore()
		const instructions = 'Track incidents. ALWAYS keep feature requests as P3.'

		await store.state.add(makeState('instructions', instructions))
		await store.state.add(makeState('observe_prompt', 'LEGACY OBSERVE PROMPT'))
		await store.state.add(makeState('understand_prompt', 'LEGACY UNDERSTAND PROMPT'))

		const neuron = await TextNeuron.restore(store, { id: 'legacy' })

		expect(neuron.getObserveSystemPrompt()).toContain(
			'You are the observe phase of a neuron.',
		)
		expect(neuron.getObserveSystemPrompt()).toContain(instructions)
		expect(neuron.getObserveSystemPrompt()).not.toContain('LEGACY OBSERVE PROMPT')
		expect(neuron.getUnderstandSystemPrompt()).toContain(
			'You are the understand phase of a text neuron.',
		)
		expect(neuron.getUnderstandSystemPrompt()).toContain(instructions)
		expect(neuron.getUnderstandSystemPrompt()).not.toContain(
			'LEGACY UNDERSTAND PROMPT',
		)
	})

	it('supports observer-only neurons with skipUnderstand', async () => {
		const queued = createQueuedJsonModel([
			{
				status: 'observed',
				output: ['Customer requested dark mode.'],
				importance: 1,
				gaps: [],
			},
		])
		const store = new MemoryNeuronStore()

		const neuron = await TextNeuron.create({
			id: 'observer-only',
			model: queued.model,
			store,
			instructions: 'Keep feature requests as observations.',
			skipUnderstand: true,
			observationSchema: { type: 'string' },
			understand: { thresholds: { maxObservations: 1 } },
		})

		const result = await neuron.learn(['Please add dark mode.'], {
			forceSynthesize: true,
		})

		expect(result.status).toBe('observed')
		expect(queued.getCallCount()).toBe(1)
		expect(await neuron.getUnderstanding()).toBe('')
		expect(await store.observations.count({ metadata_status: 'pending' })).toBe(1)
		expect(await store.observations.count({ metadata_status: 'processed' })).toBe(
			0,
		)
	})

	it('does not rebuild understand prompts when updating skipUnderstand neurons', async () => {
		const queued = createQueuedJsonModel([
			{
				status: 'observed',
				output: ['Customer requested dark mode.'],
				importance: 1,
				gaps: [],
			},
		])

		const neuron = await TextNeuron.create({
			id: 'observer-only-update',
			model: queued.model,
			store: new MemoryNeuronStore(),
			instructions: 'Keep feature requests as observations.',
			skipUnderstand: true,
			observationSchema: { type: 'string' },
		})

		await neuron.update({
			instructions: 'Keep product requests as observations.',
			understandInstructions: 'Never synthesize product requests.',
		})
		await neuron.learn(['Please add dark mode.'], { forceSynthesize: true })

		expect(neuron.getUnderstandSystemPrompt()).toBeNull()
		expect(queued.getCallCount()).toBe(1)
	})

	it('allows subscribing before TextNeuron create and restore init events fire', async () => {
		const store = new MemoryNeuronStore()
		const createEvents: string[] = []

		const neuron = await TextNeuron.create({
			id: 'eventful',
			model: createQueuedJsonModel([skillsResponse()]).model,
			store,
			instructions: 'Track init events.',
			onEvent: (event) => createEvents.push(event.type),
		})

		expect(createEvents).toContain('neuron:init:started')
		expect(createEvents).toContain('neuron:init:completed')
		await neuron.dispose()

		const restoreEvents: string[] = []
		await TextNeuron.restore(store, {
			onEvent: (event) => restoreEvents.push(event.type),
		})

		expect(restoreEvents).toContain('neuron:init:started')
		expect(restoreEvents).toContain('neuron:init:completed')
	})
})
