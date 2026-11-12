import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { expect, it } from 'vitest'
import { MemoryNeuronStore, TextNeuron } from '../src'

// One JSON reply; records the response format the model was sent.
function replyModel(reply: unknown, sent: LanguageModelV3CallOptions['responseFormat'][]): LanguageModel {
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'reply',
		supportedUrls: {},
		async doGenerate(options) {
			sent.push(options.responseFormat)
			return {
				content: [{ type: 'text', text: JSON.stringify(reply) }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: 'r', timestamp: new Date(), modelId: 'reply' },
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return model as unknown as LanguageModel
}

it('a query reply without gaps is accepted; gaps is still required in what the model is sent', async () => {
	const sent: LanguageModelV3CallOptions['responseFormat'][] = []
	const neuron = await TextNeuron.create({
		model: replyModel({ relevant: true, relevance: 0.9, confidence: 1, response: 'Mostly vegetarian.' }, sent),
		instructions: 'Track my food habits.',
		store: new MemoryNeuronStore(),
	})
	await neuron.setUnderstanding('Mostly vegetarian.')

	const result = await neuron.query('What do I eat?')

	expect(result).toMatchObject({ relevant: true, insight: 'Mostly vegetarian.', gaps: '' })
	const format = sent[0]
	expect(format?.type).toBe('json')
	const schema = (format as { schema?: { required?: string[] } }).schema
	expect(schema?.required).toContain('gaps')
	await neuron.dispose()
})
