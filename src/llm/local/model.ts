import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel as AiLanguageModel } from 'ai'
import type { AdaptModelConfig } from '../index'

/**
 * LM Studio's OpenAI-compatible endpoint. llama.cpp's `llama-server` serves
 * the same API; pass its URL (default `http://localhost:8080/v1`).
 */
export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:1234/v1'

/** Liquid LFM3 1.7B, as LM Studio names it. Qwen: `qwen/qwen3.5-2b`. */
export const DEFAULT_LOCAL_MODEL_ID = 'lfm3-1.7b'

/** A model served by a local OpenAI-compatible endpoint. Plain data, so it is saved with the brain. */
export type LocalModel = AdaptModelConfig<
	'ai-sdk',
	'local',
	{ baseURL: string }
>

/**
 * A local model. With no arguments: LFM3 on LM Studio at localhost:1234.
 *
 * @example
 * localModel()                                   // LFM3 on LM Studio
 * localModel('qwen/qwen3.5-2b')                  // Qwen on LM Studio
 * localModel('lfm3', { baseURL: 'http://localhost:8080/v1' }) // llama.cpp
 */
export function localModel(
	id: string = DEFAULT_LOCAL_MODEL_ID,
	options: { baseURL?: string } = {},
): LocalModel {
	return {
		plugin: 'ai-sdk',
		provider: 'local',
		id,
		options: { baseURL: options.baseURL ?? DEFAULT_LOCAL_BASE_URL },
	}
}

/** AI SDK provider factory for {@link LocalModel} configs. */
export function localProvider(
	id: string,
	config: AdaptModelConfig<'ai-sdk'>,
): AiLanguageModel {
	const baseURL = config.options?.baseURL
	if (typeof baseURL !== 'string') {
		throw new Error(
			'Local model config needs options.baseURL. Build it with localModel().',
		)
	}
	// LM Studio rejects response_format 'json_object'; this makes the SDK send 'json_schema'.
	return createOpenAICompatible({
		name: 'local',
		baseURL,
		supportsStructuredOutputs: true,
	})(id)
}
