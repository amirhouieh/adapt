import {
	type AdaptCallSettings,
	type AdaptLLMPlugin,
	generate,
	type LanguageModel,
} from '../../llm'
import type { DevicePriority, DeviceScheduler } from '../../llm/local/scheduler'
import type {
	ProcedurePorts,
	ProseOutcome,
	RequestTokenCount,
} from './contracts'

export interface AdaptTextProcedureProviderConfig {
	readonly llm: AdaptLLMPlugin
	readonly model: LanguageModel
	readonly settings: AdaptCallSettings & { readonly maxOutputTokens: number }
	readonly scheduler: DeviceScheduler
	readonly priority: DevicePriority
}

export function createAdaptTextProcedureProvider(
	config: AdaptTextProcedureProviderConfig,
): ProcedurePorts['provider'] {
	if (config.llm.id !== 'ai-sdk') {
		throw new Error('text procedure provider requires the Adapt AI SDK plugin')
	}
	return {
		async generate(request, signal): Promise<ProseOutcome> {
			try {
				return await config.scheduler.run(
					async () => {
						if (
							config.settings.maxOutputTokens !== request.reservedOutputTokens
						) {
							return {
								status: 'failure',
								code: 'output_reserve_mismatch',
								retryable: false,
							}
						}
						const result = await generate({
							llm: config.llm,
							model: config.model,
							system: request.system,
							prompt: request.prompt,
							abortSignal: signal,
							...config.settings,
						})
						if (result.finishReason !== 'stop') {
							return {
								status: 'failure',
								code: `finish_${result.finishReason}`,
								retryable: result.finishReason !== 'length',
								cause: result.raw,
							}
						}
						const completion = {
							finishReason: 'stop' as const,
							usage: result.usage,
							raw: result.raw,
						}
						if (result.text.trim().length === 0) {
							return {
								status: 'failure',
								code: 'blank_response',
								retryable: true,
								cause: result.raw,
							}
						}
						return { status: 'complete', text: result.text, completion }
					},
					{ priority: config.priority, signal },
				)
			} catch (cause) {
				return {
					status: 'failure',
					code: signal.aborted ? 'cancelled' : 'provider_error',
					retryable: true,
					cause,
				}
			}
		},
	}
}

export interface ConservativeByteTokenCounterConfig {
	readonly requestTemplateOverheadTokens: number
	readonly textTemplateOverheadTokens: number
}

export function createConservativeByteTokenCounter(
	config: ConservativeByteTokenCounterConfig,
): ProcedurePorts['tokens'] {
	if (
		!Number.isInteger(config.requestTemplateOverheadTokens) ||
		config.requestTemplateOverheadTokens < 0
	) {
		throw new Error('request template overhead must be a nonnegative integer')
	}
	if (
		!Number.isInteger(config.textTemplateOverheadTokens) ||
		config.textTemplateOverheadTokens < 0
	) {
		throw new Error('text template overhead must be a nonnegative integer')
	}
	const encoder = new TextEncoder()
	const count = (text: string, overhead: number): RequestTokenCount => ({
		tokens: encoder.encode(text).byteLength + overhead,
		conservativeUpperBound: true,
	})
	return {
		countRequest: (request) =>
			count(JSON.stringify(request), config.requestTemplateOverheadTokens),
		countText: (text) => count(text, config.textTemplateOverheadTokens),
	}
}
