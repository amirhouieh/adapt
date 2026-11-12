import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { expect, it } from 'vitest'
import { Brain } from '../src/brain'
import type { TextNeuron } from '../src/neurons'
import { MemoryBrainStore } from '../src/stores'

// Replies by what the call is for (the system prompt), so parallel calls
// get the right reply whatever their order.
function routedModel(): LanguageModel {
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	const reply = (system: string): unknown => {
		if (system.includes('You select which specialist')) return { ids: ['tea', 'coffee'] }
		if (system.includes('You have specialist knowledge below'))
			return { response: 'You like tea.', gaps: [] }
		// The coffee neuron's reply is missing fields (as LFM3 did with `gaps`).
		if (system.includes('Likes coffee.')) return { relevant: true }
		if (system.includes('Likes tea.'))
			return { relevant: true, relevance: 1, confidence: 1, response: 'Likes tea.', gaps: [] }
		return { purpose: 'Track drinks.', evolutionGuidance: null, synthesisDirective: null }
	}
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'routed',
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions) {
			const system = options.prompt
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n')
			return {
				content: [{ type: 'text', text: JSON.stringify(reply(system)) }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: 'r', timestamp: new Date(), modelId: 'routed' },
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return model as unknown as LanguageModel
}

const neuron = (id: string) => ({
	id,
	type: 'text' as const,
	name: id,
	description: `Tracks ${id}`,
	instructions: `Track ${id}.`,
})

it('ask() answers from the other neurons when one neuron query fails', async () => {
	const brain = await Brain.create({
		prompt: 'Track drinks.',
		model: routedModel(),
		autoSetup: false,
		store: new MemoryBrainStore(),
		neurons: [neuron('tea'), neuron('coffee')],
		internalNeurons: {
			globalUnderstanding: false,
			globalQueryUnderstanding: false,
			injectionGaps: false,
			queryGaps: false,
		},
		evolution: { enabled: false },
	})
	await (brain.getNeuron('tea') as unknown as TextNeuron).setUnderstanding('Likes tea.')
	await (brain.getNeuron('coffee') as unknown as TextNeuron).setUnderstanding('Likes coffee.')
	const failed: string[] = []
	brain.on('neuron:query:failed', (event) => failed.push(event.neuronId))

	const result = await brain.ask('What do I drink?')

	expect(result.insight).toBe('You like tea.')
	expect(failed).toEqual(['coffee'])
	await brain.dispose()
})
