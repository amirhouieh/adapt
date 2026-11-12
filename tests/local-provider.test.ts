import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
	BoundedDeviceScheduler,
	createBoundedDeviceScheduler,
	createLocalLLM,
	DeviceQueueFullError,
	LocalProviderError,
	type LocalFetch,
	type LocalLLMConfig,
	type LocalModelConfig,
} from '../src/llm/local'

const model: LocalModelConfig = {
	plugin: 'local',
	provider: 'test-runtime',
	id: 'test/model',
	options: { temperature: 0, maxOutputTokens: 80, seed: 4 },
}

function completion(
	content: string,
	options: { status?: number; model?: string } = {},
): Response {
	return new Response(
		JSON.stringify({
			model: options.model ?? 'test/model',
			choices: [
				{
					message: { content },
					finish_reason: 'stop',
				},
			],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
		}),
		{
			status: options.status ?? 200,
			headers: { 'x-test-header': 'raw-value' },
		},
	)
}

function config(
	transport: LocalFetch,
	overrides: Partial<LocalLLMConfig> = {},
): LocalLLMConfig {
	return {
		chatCompletionsUrl: 'http://127.0.0.1:1234/v1/chat/completions',
		providerId: 'test-runtime',
		scheduler: createBoundedDeviceScheduler({
			maxConcurrent: 1,
			maxQueued: 8,
		}),
		retry: {
			maxAttempts: 2,
			maxAttemptsCeiling: 2,
			initialDelayMs: 0,
			maxDelayMs: 0,
			backoff: 'fixed',
		},
		requestTimeoutMs: 100,
		defaultMaxOutputTokens: 40,
		defaultPriority: 'foreground',
		transport,
		...overrides,
	}
}

describe('bounded local device scheduler', () => {
	it('shares one concurrency ceiling and ignores later config mutation', async () => {
		const schedulerConfig = { maxConcurrent: 2, maxQueued: 8 }
		const scheduler = new BoundedDeviceScheduler(schedulerConfig)
		schedulerConfig.maxConcurrent = 8
		let active = 0
		let peak = 0
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				scheduler.run(
					async () => {
						active += 1
						peak = Math.max(peak, active)
						await new Promise((resolve) => setTimeout(resolve, 3))
						active -= 1
						return index
					},
					{ priority: index % 2 === 0 ? 'foreground' : 'background' },
				),
			),
		)
		expect(peak).toBe(2)
	})

	it('runs queued queries before older background work', async () => {
		const scheduler = new BoundedDeviceScheduler({
			maxConcurrent: 1,
			maxQueued: 4,
		})
		let release!: () => void
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const blocker = scheduler.run(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
					markStarted()
				}),
			{ priority: 'foreground' },
		)
		await started
		const order: string[] = []
		const background = scheduler.run(
			async () => {
				order.push('background')
			},
			{ priority: 'background' },
		)
		const query = scheduler.run(
			async () => {
				order.push('query')
			},
			{ priority: 'query' },
		)
		release()
		await Promise.all([blocker, background, query])
		expect(order).toEqual(['query', 'background'])
	})

	it('rejects overflow and removes cancelled queued work', async () => {
		const scheduler = new BoundedDeviceScheduler({
			maxConcurrent: 1,
			maxQueued: 1,
		})
		let release!: () => void
		const blocker = scheduler.run(
			() => new Promise<void>((resolve) => (release = resolve)),
			{ priority: 'foreground' },
		)
		const controller = new AbortController()
		const queued = scheduler.run(async () => undefined, {
			priority: 'background',
			signal: controller.signal,
		})
		await expect(
			scheduler.run(async () => undefined, { priority: 'query' }),
		).rejects.toBeInstanceOf(DeviceQueueFullError)
		controller.abort(new DOMException('cancel queued', 'AbortError'))
		await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
		const accepted = scheduler.run(async () => 'accepted', {
			priority: 'query',
		})
		release()
		await expect(accepted).resolves.toBe('accepted')
		await blocker
	})
})

describe('local generation and decision adapter', () => {
	it.each([
		'https://example.com/v1/chat/completions',
		'http://user:secret@127.0.0.1:1234/v1/chat/completions',
		'http://127.0.0.1:1234/v1/chat/completions?remote=true',
		'file:///tmp/provider',
	])('rejects non-local or ambiguous endpoint %s', (chatCompletionsUrl) => {
		expect(() =>
			createLocalLLM(
				config(vi.fn(), {
					chatCompletionsUrl,
				}),
			),
		).toThrow(LocalProviderError)
	})

	it('preserves exact bodies, rejects redirects, and reports runtime model identity', async () => {
		let sentBody = ''
		let redirect: RequestRedirect | undefined
		const exchanges: unknown[] = []
		const transport: LocalFetch = async (_input, init) => {
			sentBody = String(init?.body)
			redirect = init?.redirect
			return completion('{"value":"kept"}', {
				model: 'runtime/artifact-model',
			})
		}
		const llm = createLocalLLM(
			config(transport, {
				exchangeObserver: (exchange) => exchanges.push(exchange),
			}),
		)
		const result = await llm.call<{ value: string }>({
			model,
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'source text' }] },
			],
			output: {
				type: 'object',
				schema: z.object({ value: z.string() }),
			},
		})

		expect(redirect).toBe('error')
		expect(result.json).toEqual({ value: 'kept' })
		expect(result.raw?.attempts[0]?.request.body).toBe(sentBody)
		expect(result.raw?.attempts[0]?.response?.body).toContain(
			'runtime/artifact-model',
		)
		expect(exchanges).toHaveLength(1)
		expect(result.providerMetadata).toMatchObject({
			modelId: 'test/model',
			responseModelId: 'runtime/artifact-model',
			matchesRequestedModel: false,
		})
	})

	it('uses one immutable retry budget and records each raw HTTP failure', async () => {
		let calls = 0
		const mutableConfig = config(async () => {
			calls += 1
			if (calls === 1) return new Response('temporarily unavailable', { status: 503 })
			return completion('{"ok":true}')
		})
		const llm = createLocalLLM(mutableConfig)
		mutableConfig.retry.maxAttempts = 1
		mutableConfig.defaultMaxOutputTokens = 999
		mutableConfig.providerId = 'mutated-after-construction'
		const result = await llm.call<{ ok: boolean }>({
			model: { ...model, options: undefined },
			messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
			output: { type: 'object', schema: z.object({ ok: z.boolean() }) },
		})

		expect(calls).toBe(2)
		expect(result.raw?.attempts).toHaveLength(2)
		expect(result.raw?.attempts[0]?.response).toMatchObject({
			status: 503,
			body: 'temporarily unavailable',
		})
		expect(JSON.parse(result.raw?.attempts[1]?.request.body ?? '{}')).toMatchObject({
			max_tokens: 40,
		})
	})

	it('does not begin physical I/O when the start observer refuses it', async () => {
		const transport = vi.fn(async () => completion('{"ok":true}'))
		const llm = createLocalLLM(
			config(transport, {
				observer: (event) => {
					if (event.state === 'started') throw new Error('journal unavailable')
				},
			}),
		)
		await expect(
			llm.call({
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
			}),
		).rejects.toThrow('journal unavailable')
		expect(transport).not.toHaveBeenCalled()
	})

	it('stops retry backoff when the caller aborts', async () => {
		const controller = new AbortController()
		const transport = vi.fn(async () =>
			new Response('temporarily unavailable', { status: 503 }),
		)
		const llm = createLocalLLM(
			config(transport, {
				retry: {
					maxAttempts: 2,
					maxAttemptsCeiling: 2,
					initialDelayMs: 10_000,
					maxDelayMs: 10_000,
					backoff: 'fixed',
				},
				observer: (event) => {
					if (event.state === 'waiting') {
						controller.abort(new DOMException('stop retries', 'AbortError'))
					}
				},
			}),
		)
		await expect(
			llm.call({
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: 'AbortError' })
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it('returns the plugin structured-failure contract after bounded retries', async () => {
		const transport = vi.fn(async () => completion('not valid json'))
		const llm = createLocalLLM(config(transport))
		const result = await llm.call({
			model,
			messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
			output: { type: 'object', schema: z.object({ ok: z.boolean() }) },
		})

		expect(transport).toHaveBeenCalledTimes(2)
		expect(result).toMatchObject({
			text: 'not valid json',
			json: undefined,
			finishReason: 'error',
		})
		expect(result.raw?.attempts).toHaveLength(2)
	})

	it('keeps the timeout active while reading the body', async () => {
		const transport: LocalFetch = async (_input, init) =>
			({
				ok: true,
				status: 200,
				headers: new Headers(),
				text: () =>
					new Promise<string>((_resolve, reject) => {
						init?.signal?.addEventListener(
							'abort',
							() => reject(init.signal?.reason),
							{ once: true },
						)
					}),
			}) as Response
		const llm = createLocalLLM(
			config(transport, {
				requestTimeoutMs: 5,
				retry: {
					maxAttempts: 1,
					maxAttemptsCeiling: 1,
					initialDelayMs: 0,
					maxDelayMs: 0,
					backoff: 'fixed',
				},
			}),
		)

		const error = await llm
			.call({
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
			})
			.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalProviderError)
		expect((error as LocalProviderError).rawAttempts[0]?.failure).toMatchObject({
			name: 'TimeoutError',
		})
	})

	it('retains the original transport error and refuses a second retry owner', async () => {
		const original = new TypeError('socket closed', {
			cause: new Error('original cause'),
		})
		const llm = createLocalLLM(
			config(async () => {
				throw original
			}),
		)
		const error = await llm
			.call({
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
				settings: { maxRetries: 0 },
			})
			.catch((caught: unknown) => caught)
		expect((error as LocalProviderError).rawAttempts[0]?.failure).toBe(original)

		await expect(
			llm.call({
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
				settings: { maxRetries: 1 },
			}),
		).rejects.toMatchObject({ code: 'unsupported_capability' })
	})

	it('returns answer provenance without claiming calibration', async () => {
		const llm = createLocalLLM(
			config(async () =>
				completion('{"answer":"relevant","probability":0.72}'),
			),
		)
		const result = await llm.decisions.decide(
			{
				state: { text: 'The supplied text concerns the lens.' },
				question: 'Is this relevant?',
				answers: [{ value: 'relevant' }, { value: 'irrelevant' }],
			},
			{ model, priority: 'query' },
		)
		expect(result).toMatchObject({
			status: 'answered',
			answer: 'relevant',
			probability: {
				value: 0.72,
				source: 'generated_self_report',
				calibrated: false,
			},
		})
	})
})
