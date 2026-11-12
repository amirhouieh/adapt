import { describe, expect, it } from 'vitest'

import { createLocalLearningModel } from '../src/learning'
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
	type LocalFetch,
	type LocalModelConfig,
} from '../src/llm/local'

const model: LocalModelConfig = {
	plugin: 'local',
	provider: 'test-runtime',
	id: 'test/model',
	options: { temperature: 0, maxOutputTokens: 80, seed: 4 },
}

function completion(content: string, finishReason: string): Response {
	return new Response(
		JSON.stringify({
			model: model.id,
			choices: [
				{
					message: { content },
					finish_reason: finishReason,
				},
			],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
		}),
		{ status: 200 },
	)
}

function capability(transport: LocalFetch) {
	const llm = createLocalLLM({
		chatCompletionsUrl: 'http://127.0.0.1:1234/v1/chat/completions',
		providerId: 'test-runtime',
		scheduler: createBoundedDeviceScheduler({
			maxConcurrent: 1,
			maxQueued: 1,
		}),
		retry: {
			maxAttempts: 1,
			maxAttemptsCeiling: 1,
			initialDelayMs: 0,
			maxDelayMs: 0,
			backoff: 'fixed',
		},
		requestTimeoutMs: 100,
		defaultMaxOutputTokens: 80,
		defaultPriority: 'foreground',
		transport,
	})
	return createLocalLearningModel({ llm, model, priority: 'foreground' })
}

describe('local learning model plain-text generation', () => {
	it('sends no structured output contract or repair request', async () => {
		let body: unknown
		const learning = capability(async (_input, init) => {
			body = JSON.parse(String(init?.body)) as unknown
			return completion('Complete revised understanding.', 'stop')
		})

		const result = await learning.generateText?.({
			system: 'Return complete memory.',
			prompt: 'Current memory and observation.',
			signal: new AbortController().signal,
		})

		expect(body).not.toHaveProperty('response_format')
		expect(result).toMatchObject({
			value: 'Complete revised understanding.',
			finishReason: 'stop',
			usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
		})
	})

	it.each([
		['length', 'length'],
		['tool_calls', 'tool-calls'],
		['content_filter', 'unknown'],
	] as const)(
		'rejects incomplete provider finish %s as %s',
		async (providerFinishReason, normalizedFinishReason) => {
			const learning = capability(async () =>
				completion('Partial revised understanding.', providerFinishReason),
			)

			await expect(
				learning.generateText?.({
					system: 'Return complete memory.',
					prompt: 'Current memory and observation.',
					signal: new AbortController().signal,
				}),
			).rejects.toMatchObject({
				message: `plain-text generation did not complete with stop: ${normalizedFinishReason}`,
				cause: {
					text: 'Partial revised understanding.',
					finishReason: normalizedFinishReason,
				},
			})
		},
	)
})
