/**
 * Model provider helper for eval scripts
 *
 * PROVIDER=ollama MODEL=deepseek-r1:1.5b  → local Ollama
 * PROVIDER=lmstudio MODEL=qwen2.5-7b  → local LM Studio
 * PROVIDER=openrouter MODEL=google/gemini-2.5-flash  → OpenRouter (default)
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

const PROVIDER = process.env.PROVIDER ?? 'openrouter'
const MODEL = process.env.MODEL ?? 'google/gemini-2.5-flash'

function createModel(): LanguageModel {
	if (PROVIDER === 'ollama') {
		const ollama = createOpenAICompatible({
			name: 'ollama',
			baseURL: 'http://localhost:11434/v1',
			supportsStructuredOutputs: true,
		})
		return ollama.chatModel(MODEL)
	}

	if (PROVIDER === 'lmstudio') {
		const lmstudio = createOpenAICompatible({
			name: 'lmstudio',
			baseURL: 'http://localhost:1234/v1',
			supportsStructuredOutputs: true,
		})
		return lmstudio.chatModel(MODEL)
	}

	const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
	return openrouter(MODEL)
}

export const model = createModel()
export const modelName = `${PROVIDER}/${MODEL}`
