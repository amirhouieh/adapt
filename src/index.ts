/**
 * Adapt — A self-evolving memory layer for AI applications.
 *
 * @example
 * ```typescript
 * import { Brain, localModel } from 'adapt-memory'
 *
 * // First run — fresh brain. No model given: LFM3 on LM Studio
 * // (http://localhost:1234/v1). Qwen: model: localModel('qwen/qwen3.5-2b').
 * // llama.cpp: model: localModel('<id>', { baseURL: 'http://localhost:8080/v1' }).
 * // Hosted models work too: pass any AI SDK model, e.g. LFM3 on OpenRouter.
 * const brain = await Brain.create({
 *   prompt: 'Track coding patterns and learning interests.',
 * })
 *
 * await brain.inject(['commit: refactor to functional style'])
 * const result = await brain.ask('What is my coding philosophy?')
 *
 * // Subsequent runs (different process / restart) — restore from disk.
 * // This needs the brain created with a SQLite store:
 * // store: new SQLiteBrainStore('brain.db') from 'adapt-memory/sqlite'.
 * // A local model is saved with the brain, so no second arg is needed.
 * // A hosted model is passed again: Brain.restore('brain.db', { model }).
 * // The brain holds its own plugin reference; there is no global state.
 * //
 * // const brain = await Brain.restore('brain.db')
 * // await brain.ask('What is my coding philosophy?')
 * //
 * // For BYO custom runtimes (Effect, in-house clients):
 * // const brain = await Brain.restore('brain.db', { llm: myCustomPlugin })
 * ```
 */

export * from './brain'
export {
	type AdaptGenerateOptions,
	type AdaptLLMPlugin,
	type AdaptModelConfig,
	type AdaptModelStreamEvent,
	type AdaptModelTurnRequest,
	type AdaptModelTurnResult,
	type AdaptRepairAttempt,
	type AdaptRepairOptions,
	type AdaptRepairWithFeedback,
	type AdaptStreamResult,
	type AiSdkLLMOptions,
	type AiSdkProviderFactory,
	createAiSdkLLM,
} from './llm'
export {
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_MODEL_ID,
	type LocalModel,
	localModel,
} from './llm/local/model'
export * from './neurons'
