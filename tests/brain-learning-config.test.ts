import type {
	LanguageModelV3,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain'
import type { TextNeuron } from '../src/neurons'
import { MemoryBrainStore } from '../src/stores'

// Replies in order; records which model got each call.
function scriptedModel(modelId: string, replies: string[], calls: string[]): LanguageModel {
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	let call = 0
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId,
		supportedUrls: {},
		async doGenerate() {
			calls.push(modelId)
			const text = replies[call++]
			if (text === undefined) throw new Error(`${modelId}: no reply for call ${call}`)
			return {
				content: [{ type: 'text', text }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: `r-${call}`, timestamp: new Date(), modelId },
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return model as unknown as LanguageModel
}

const neuron = (id: string, governance?: { strategy?: 'continuous' | 'cumulative' | 'decay'; maxTokens?: number }) => ({
	id,
	type: 'text' as const,
	name: id,
	description: `Tracks ${id}`,
	instructions: `Track ${id}.`,
	focus: null,
	...(governance ? { governance } : {}),
})

async function createBrain(calls: string[], learning: Parameters<typeof Brain.create>[0]['learning']) {
	const prompt = JSON.stringify({ purpose: 'Track things.', evolutionGuidance: null, synthesisDirective: null })
	return Brain.create({
		prompt: 'Track things.',
		model: scriptedModel('brain', [prompt], calls),
		autoSetup: false,
		store: new MemoryBrainStore(),
		neurons: [neuron('plain'), neuron('own', { maxTokens: 2000 })],
		learning,
		internalNeurons: { globalUnderstanding: false, globalQueryUnderstanding: false, injectionGaps: false, queryGaps: false },
		evolution: { enabled: false },
	})
}

const text = (brain: Brain, id: string) => brain.getNeuron(id) as unknown as TextNeuron

describe('Brain applies learning config to the neurons it creates', () => {
	it('uses Brain defaults when learning.governance is not set', async () => {
		const brain = await createBrain([], undefined)
		expect(text(brain, 'plain').getGovernance()).toEqual({ strategy: 'cumulative', maxTokens: 8000 })
		await brain.dispose()
	})

	it('learning.governance applies at create; a neuron’s own governance wins per field', async () => {
		const brain = await createBrain([], { governance: { strategy: 'decay', maxTokens: 6000 } })
		expect(text(brain, 'plain').getGovernance()).toEqual({ strategy: 'decay', maxTokens: 6000 })
		expect(text(brain, 'own').getGovernance()).toEqual({ strategy: 'decay', maxTokens: 2000 })
		await brain.dispose()
	})

	it('learning.model is the model neurons learn with', async () => {
		const calls: string[] = []
		const learnModel = scriptedModel('learner', ['Likes tea.', 'Likes tea.'], calls)
		const brain = await createBrain(calls, { model: learnModel })
		calls.length = 0
		await brain.getNeuron('plain')?.learn(['I like tea.'])
		expect(calls).toEqual(['learner', 'learner'])
		await brain.dispose()
	})

	it('brain.update({ learning }) also applies to neurons added later', async () => {
		const brain = await createBrain([], undefined)
		await brain.update({ learning: { governance: { strategy: 'continuous', maxTokens: 3000 } } })
		expect(text(brain, 'plain').getGovernance()).toEqual({ strategy: 'continuous', maxTokens: 3000 })
		await brain.addNeuron(neuron('later'))
		expect(text(brain, 'later').getGovernance()).toEqual({ strategy: 'continuous', maxTokens: 3000 })
		await brain.dispose()
	})
})
