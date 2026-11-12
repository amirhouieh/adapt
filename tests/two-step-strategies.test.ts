import type {
	LanguageModelV3,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { MemoryNeuronStore, TextNeuron } from '../src'
import { shortenSystem } from '../src/neurons/text/strategies'
import type { LanguageModel } from '../src/llm'

// Plain-text model: replies are returned in order, one per call.
// A missing reply throws, so an unexpected strategy call fails the test.
// A reply is text, or text with a finish reason other than 'stop'.
type Reply = string | { text: string; finish: 'length' }

function scriptedModel(
	replies: Reply[],
	limits: Array<number | undefined> = [],
): LanguageModel {
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
		async doGenerate(options) {
			limits.push(options.maxOutputTokens)
			const reply = replies[call++]
			if (reply === undefined) throw new Error(`no reply for call ${call}`)
			const { text, finish } =
				typeof reply === 'string' ? { text: reply, finish: 'stop' as const } : reply
			return {
				content: [{ type: 'text', text }],
				finishReason: { unified: finish, raw: finish },
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

// Memory cap: maxTokens 10 → about 40 characters (4 characters per token).
const LONG = 'Uses Biome for formatting and linting everywhere.' // 49 chars, over 40
const NEAR = 'Uses Biome for format and lint ok.' // 34 chars: over 80% (32), under 40

async function learnWith(
	replies: string[],
	governance: { strategy: 'continuous' | 'cumulative' | 'decay'; maxTokens: number },
) {
	const neuron = await TextNeuron.create({
		model: scriptedModel(replies),
		instructions: 'Track coding preferences.',
		store: new MemoryNeuronStore(),
		governance,
	})
	const result = await neuron.learn(['We switched to Biome.'])
	const memory = await neuron.getUnderstanding()
	await neuron.dispose()
	return { result, memory }
}

describe('two-step memory strategies', () => {
	it('continuous keeps the updated memory as is (no extra call)', async () => {
		const { result, memory } = await learnWith(['Prefers Biome.', LONG], {
			strategy: 'continuous',
			maxTokens: 10,
		})
		expect(result.status).toBe('synthesized')
		expect(memory).toBe(LONG)
	})

	it('cumulative summarizes into a seed when over maxTokens', async () => {
		const { result, memory } = await learnWith(
			['Prefers Biome.', LONG, 'Seed: uses Biome.'],
			{ strategy: 'cumulative', maxTokens: 10 },
		)
		expect(result.status).toBe('synthesized')
		expect(memory).toBe('Seed: uses Biome.')
	})

	it('cumulative leaves memory under maxTokens alone', async () => {
		const { memory } = await learnWith(['Prefers Biome.', NEAR], {
			strategy: 'cumulative',
			maxTokens: 10,
		})
		expect(memory).toBe(NEAR)
	})

	it('decay compresses at 80% of maxTokens', async () => {
		const { result, memory } = await learnWith(
			['Prefers Biome.', NEAR, 'Current State: uses Biome.'],
			{ strategy: 'decay', maxTokens: 10 },
		)
		expect(result.status).toBe('synthesized')
		expect(memory).toBe('Current State: uses Biome.')
	})

	it('the strategy call uses the same output limit as the update step', async () => {
		const limits: Array<number | undefined> = []
		const neuron = await TextNeuron.create({
			model: scriptedModel(['Prefers Biome.', LONG, 'Seed: uses Biome.'], limits),
			instructions: 'Track coding preferences.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'cumulative', maxTokens: 10 },
		})
		await neuron.learn(['We switched to Biome.'])
		await neuron.dispose()
		// extract, update, strategy
		expect(limits).toEqual([8192, 8192, 8192])
	})

	it('a cut-off strategy reply (finish: length) is not saved', async () => {
		const neuron = await TextNeuron.create({
			model: scriptedModel([
				'Prefers Biome.',
				LONG,
				{ text: 'Current State: uses Bi', finish: 'length' },
			]),
			instructions: 'Track coding preferences.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'decay', maxTokens: 10 },
		})
		await neuron.learn(['We switched to Biome.'])
		expect(await neuron.getUnderstanding()).toBe('')
		await neuron.dispose()
	})

	it('the shorten prompt names the topic and rules, a word target, and adds nothing', () => {
		const prompt = shortenSystem('decay', 'Track my renovation.', ['Keep owner names.'], 300)
		expect(prompt).toContain('Track my renovation.')
		expect(prompt).toContain('- Keep owner names.')
		expect(prompt).toContain('at most 157 words') // 300 × 0.7 × 0.75
		expect(prompt).toContain('Keep recent facts in detail.')
		expect(prompt).toContain('Do not add anything')
		expect(shortenSystem('cumulative', 'T', [], 300)).not.toContain('recent')
	})

	it('governance can be changed with update()', async () => {
		const neuron = await TextNeuron.create({
			model: scriptedModel([]),
			instructions: 'Track coding preferences.',
			store: new MemoryNeuronStore(),
		})
		expect(neuron.getGovernance()).toEqual({ strategy: 'cumulative', maxTokens: 8000 })
		const { changedFields } = await neuron.update({
			governance: { strategy: 'decay' },
		})
		expect(changedFields).toContain('governance.strategy')
		expect(neuron.getGovernance()).toEqual({ strategy: 'decay', maxTokens: 8000 })
		await neuron.dispose()
	})
})
