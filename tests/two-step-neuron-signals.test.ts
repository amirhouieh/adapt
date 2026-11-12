import type {
	LanguageModelV3,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { MemoryNeuronStore, TextNeuron } from '../src'
import type { LanguageModel } from '../src/llm'

// Plain-text model: replies are returned in order, one per call.
function scriptedModel(replies: string[]): LanguageModel {
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	let call = 0
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'scripted',
		supportedUrls: {},
		async doGenerate() {
			const text = replies[call++]
			if (text === undefined) throw new Error(`no reply for call ${call}`)
			return {
				content: [{ type: 'text', text }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: `r-${call}`, timestamp: new Date(), modelId: 'scripted' },
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return model as unknown as LanguageModel
}

describe('two-step TextNeuron signals to Brain', () => {
	it('dismisses when extract finds nothing relevant', async () => {
		const neuron = await TextNeuron.create({
			model: scriptedModel(['NONE']),
			instructions: 'Track coding preferences.',
			store: new MemoryNeuronStore(),
		})
		const events: string[] = []
		neuron.on((event) => events.push(event.type))
		const result = await neuron.learn(['The weather is sunny.'])
		expect(result.status).toBe('observe:dismissed')
		expect(events).toContain('neuron:observe:dismissed')
		expect(await neuron.getUnderstanding()).toBe('')
		await neuron.dispose()
	})

	it('reports synthesized when the understanding changes', async () => {
		const neuron = await TextNeuron.create({
			model: scriptedModel(['Prefers Biome.', 'Uses Biome for formatting.']),
			instructions: 'Track coding preferences.',
			store: new MemoryNeuronStore(),
		})
		const synthesized: unknown[] = []
		neuron.on((event) => {
			if (event.type === 'neuron:synthesized') synthesized.push(event)
		})
		const result = await neuron.learn(['We switched to Biome.'])
		expect(result.status).toBe('synthesized')
		expect(synthesized).toHaveLength(1)
		expect(await neuron.getUnderstanding()).toBe('Uses Biome for formatting.')
		await neuron.dispose()
	})
})
