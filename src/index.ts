/**
 * Adapt — A self-evolving memory layer for AI applications.
 *
 * @example
 * ```typescript
 * import { Brain } from '@unbody-io/adapt'
 * import { openai } from '@ai-sdk/openai'
 *
 * // First run — fresh brain.
 * const brain = await Brain.create({
 *   prompt: 'Track coding patterns and learning interests.',
 *   model: openai('gpt-4o'),
 * })
 *
 * await brain.inject(['commit: refactor to functional style'])
 * const result = await brain.ask('What is my coding philosophy?')
 *
 * // Subsequent runs (different process / restart) — restore from disk and
 * // hand the runtime back via the second arg. The brain holds its own
 * // plugin reference; there is no global state.
 * //
 * // const brain = await Brain.restore('brain.db', { model: openai('gpt-4o') })
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
export * from './neurons'
