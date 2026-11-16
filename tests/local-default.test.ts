import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	type AdaptLLMPlugin,
	type AdaptModelConfig,
	Brain,
	createAiSdkLLM,
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_MODEL_ID,
	localModel,
	MemoryBrainStore,
} from '../src'
import { resolveNeuronConfig } from '../src/neurons/config.resolver'

const decomposition = {
	purpose: 'Track coding preferences.',
	synthesisDirective: null,
}

const brainConfig = {
	prompt: 'Track coding preferences.',
	autoSetup: false,
	neurons: [
		{
			id: 'coding',
			name: 'Coding',
			description: 'Tracks coding preferences',
			instructions: 'Track coding preferences.',
		},
	],
	internalNeurons: {
		globalUnderstanding: false,
		globalQueryUnderstanding: false,
		injectionGaps: false,
		queryGaps: false,
	},
	evolution: { enabled: false },
}

// Fake LM Studio / llama.cpp server: OpenAI-compatible chat completions.
const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
let server: Server
let baseURL: string

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = ''
		req.on('data', (chunk) => {
			raw += chunk
		})
		req.on('end', () => {
			const body = JSON.parse(raw) as Record<string, unknown>
			requests.push({ url: req.url, body })
			res.setHeader('content-type', 'application/json')
			res.end(
				JSON.stringify({
					id: `chatcmpl-${requests.length}`,
					object: 'chat.completion',
					created: 0,
					model: body.model,
					choices: [
						{
							index: 0,
							message: {
								role: 'assistant',
								content: JSON.stringify(decomposition),
							},
							finish_reason: 'stop',
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
})

describe('local model default', () => {
	it('localModel() is LFM3 on LM Studio', () => {
		expect(localModel()).toEqual({
			plugin: 'ai-sdk',
			provider: 'local',
			id: 'lfm3-1.7b',
			options: { baseURL: 'http://localhost:1234/v1' },
		})
		expect(DEFAULT_LOCAL_MODEL_ID).toBe('lfm3-1.7b')
		expect(DEFAULT_LOCAL_BASE_URL).toBe('http://localhost:1234/v1')
	})

	it('Brain.create with no model calls the local default', async () => {
		const seen: AdaptModelConfig[] = []
		const llm: AdaptLLMPlugin = {
			id: 'ai-sdk',
			model: { toConfig: (input) => input as AdaptModelConfig },
			async call(request) {
				seen.push(request.model)
				return { text: JSON.stringify(decomposition), json: decomposition as never }
			},
		}
		const brain = await Brain.create({ ...brainConfig, llm })
		expect(brain.config.model).toEqual(localModel())
		expect(seen.length).toBeGreaterThan(0)
		expect(seen.every((m) => m.id === 'lfm3-1.7b' && m.provider === 'local')).toBe(true)
		await brain.dispose()
	})

	it('a Neuron with no model uses the local default', () => {
		const config = resolveNeuronConfig({ instructions: 'Track coding preferences.' })
		expect(config.model).toEqual(localModel())
		expect(config.blueprintModel).toEqual(localModel())
	})

	it('a brain talks to the local endpoint, and restore needs no model', async () => {
		requests.length = 0
		const store = new MemoryBrainStore()
		const model = localModel('qwen/qwen3.5-2b', { baseURL })
		const brain = await Brain.create({ ...brainConfig, model, store })
		expect(requests.length).toBeGreaterThan(0)
		expect(requests[0].url).toBe('/v1/chat/completions')
		expect(requests[0].body.model).toBe('qwen/qwen3.5-2b')
		expect((requests[0].body.response_format as { type: string }).type).toBe(
			'json_schema',
		)
		await brain.dispose()

		const restored = await Brain.restore(store)
		expect(restored.config.model).toEqual(model)
		await restored.dispose()

		// A fresh default plugin (new process) resolves the saved config.
		requests.length = 0
		const result = await createAiSdkLLM().call({
			model,
			messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
		})
		expect(result.text).toBe(JSON.stringify(decomposition))
		expect(requests[0].body.model).toBe('qwen/qwen3.5-2b')
	})
})
