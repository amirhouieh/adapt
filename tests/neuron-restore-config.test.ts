import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LanguageModel } from 'ai'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { TextNeuron, MemoryNeuronStore } from '../src'
import { createAiSdkLLM } from '../src/llm'
import { SQLiteNeuronStore } from '../src/sqlite'
import type { NeuronStore } from '../src/stores'

function initOnlyModel(): LanguageModel {
	const responses: unknown[] = []
	let callCount = 0
	const usage: LanguageModelV3GenerateResult['usage'] = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	}
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'init-only',
		supportedUrls: {},
		async doGenerate(_opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			const response = responses[callCount++]
			if (!response) throw new Error(`No queued response for call ${callCount}`)
			return {
				content: [{ type: 'text', text: JSON.stringify(response) }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: `r-${callCount}`, timestamp: new Date(), modelId: 'init-only' },
			}
		},
		async doStream() {
			throw new Error('not used')
		},
	}
	return model as unknown as LanguageModel
}

interface Scenario {
	openStore: () => NeuronStore
}

const tmpDirs: string[] = []

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()
		if (dir) rmSync(dir, { recursive: true, force: true })
	}
})

const memoryScenario = (): Scenario => {
	const shared = new MemoryNeuronStore()
	return { openStore: () => shared }
}

const sqliteScenario = (): Scenario => {
	const dir = mkdtempSync(join(tmpdir(), 'adapt-neuron-restore-'))
	tmpDirs.push(dir)
	const path = join(dir, 'neuron.db')
	return { openStore: () => new SQLiteNeuronStore(path) }
}

const scenarios = [
	{ name: 'MemoryNeuronStore', factory: memoryScenario },
	{ name: 'SQLiteNeuronStore', factory: sqliteScenario },
]

describe.each(scenarios)('Standalone neuron restore config precedence ($name)', ({ factory }) => {
	it('persisted thresholds survive a create→restore round-trip', async () => {
		const scenario = factory()
		const neuron1 = await TextNeuron.create({
			id: 'coding',
			name: 'Coding',
			description: 'Tracks coding patterns',
			instructions: 'Track coding patterns and preferences.',
			model: initOnlyModel(),
			store: scenario.openStore(),
			understand: { thresholds: { maxObservations: 7 } },
		})
		expect(neuron1.getUnderstandThresholds().maxObservations).toBe(7)
		await neuron1.dispose()

		const neuron2 = await TextNeuron.restore(scenario.openStore(), { id: 'coding' })
		expect(neuron2.getUnderstandThresholds().maxObservations).toBe(7)
		await neuron2.dispose()
	})

	it('TextNeuron.create on a populated store throws', async () => {
		const scenario = factory()
		const first = await TextNeuron.create({
			id: 'coding',
			instructions: 'Track coding patterns and preferences.',
			model: initOnlyModel(),
			store: scenario.openStore(),
		})
		await first.dispose()

		await expect(
			TextNeuron.create({
				id: 'coding',
				instructions: 'Track coding patterns and preferences.',
				model: initOnlyModel(),
				store: scenario.openStore(),
			}),
		).rejects.toThrow(/already exists/i)
	})

	it('TextNeuron.restore on an empty store throws', async () => {
		const scenario = factory()
		await expect(TextNeuron.restore(scenario.openStore())).rejects.toThrow(/no neuron found/i)
	})

	it('post-restore neuron.update overrides loaded thresholds and persists', async () => {
		const scenario = factory()
		const first = await TextNeuron.create({
			id: 'coding',
			instructions: 'Track coding patterns and preferences.',
			model: initOnlyModel(),
			store: scenario.openStore(),
			understand: { thresholds: { maxObservations: 7 } },
		})
		await first.dispose()

		const restored = await TextNeuron.restore(scenario.openStore())
		await restored.update({ understand: { thresholds: { maxObservations: 12 } } })
		expect(restored.getUnderstandThresholds().maxObservations).toBe(12)
		await restored.dispose()

		const restored2 = await TextNeuron.restore(scenario.openStore())
		expect(restored2.getUnderstandThresholds().maxObservations).toBe(12)
		await restored2.dispose()
	})

	it('TextNeuron.restore resolves persisted models via per-call plugin', async () => {
		const scenario = factory()

		const first = await TextNeuron.create({
			id: 'coding',
			instructions: 'Track coding patterns and preferences.',
			model: initOnlyModel(),
			llm: createAiSdkLLM({
				providers: { test: () => initOnlyModel() as never },
			}),
			store: scenario.openStore(),
			understand: { thresholds: { maxObservations: 7 } },
		})
		await first.dispose()

		// Restore — pass a plugin so persisted model refs resolve.
		const restored = await TextNeuron.restore(scenario.openStore(), {
			llm: createAiSdkLLM({
				providers: { test: () => initOnlyModel() as never },
			}),
		})
		// Persisted model is now an AdaptModelConfig, resolvable through the plugin.
		expect(restored.getUnderstandThresholds().maxObservations).toBe(7)
		await restored.dispose()
	})
})
