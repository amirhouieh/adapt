/**
 * Memory strategies. Run after the two-step update, before the memory is
 * saved (same commit):
 * - continuous: memory grows; nothing happens here.
 * - cumulative: over maxTokens, one call shortens the memory, keeping what
 *   matters most.
 * - decay: at 80% of maxTokens, one call shortens the memory, keeping recent
 *   detail and shortening older facts more.
 */

import {
	type AdaptLLMPlugin,
	type AdaptRepairOptions,
	generate,
	type LanguageModel,
} from '../../llm'

export const STRATEGIES = ['continuous', 'cumulative', 'decay'] as const
export type Strategy = (typeof STRATEGIES)[number]

export interface GovernanceConfig {
	strategy: Strategy
	/** Memory size (estimated tokens) the strategy keeps to. */
	maxTokens?: number
}

/**
 * Same as Brain's default. 8000 stays under the two-step memory cap (8192
 * tokens), so memory is shortened before an update can be refused for size.
 * `continuous` never shortens: once the memory reaches the cap, updates are
 * refused and the neuron stops learning.
 */
export const DEFAULT_GOVERNANCE: Required<GovernanceConfig> = {
	strategy: 'cumulative',
	maxTokens: 8000,
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export async function applyStrategy(
	input: {
		memory: string
		/** The neuron's topic (its instructions). */
		topic: string
		/** Developer rules (from `adjust`), as the update step sees them. */
		rules: readonly string[]
		governance: GovernanceConfig
		/** The memory cap of the learning setup; limits stay below it. */
		maxCharacters: number
		/** Output limit for the strategy call, the same as the update step's. */
		maxOutputTokens: number
		llm: AdaptLLMPlugin
		model: LanguageModel
		abortSignal?: AbortSignal
	} & AdaptRepairOptions,
): Promise<string> {
	const { memory, governance } = input
	if (governance.strategy === 'continuous') return memory
	const maxTokens = Math.min(
		governance.maxTokens ?? DEFAULT_GOVERNANCE.maxTokens,
		Math.floor(input.maxCharacters / 4),
	)
	const limit = governance.strategy === 'decay' ? maxTokens * 0.8 : maxTokens
	if (estimateTokens(memory) <= limit) return memory

	const result = await generate({
		llm: input.llm,
		model: input.model,
		system: shortenSystem(
			governance.strategy,
			input.topic,
			input.rules,
			maxTokens,
		),
		prompt: `Understanding:\n${memory}`,
		maxOutputTokens: input.maxOutputTokens,
		abortSignal: input.abortSignal,
		repairWithFeedback: input.repairWithFeedback,
		maxRepairAttempts: input.maxRepairAttempts,
	})
	// Like the update step: a cut-off or empty reply is not a memory.
	const text = result.text.trim()
	if (result.finishReason !== 'stop' || !text)
		throw new Error(
			`${governance.strategy} strategy returned no usable memory (finish: ${result.finishReason}, ${text.length} chars)`,
		)
	return text
}

/**
 * Same plain style as the two-step update prompt. Target: 70% of maxTokens,
 * given in words (about 0.75 words per token) because models follow word
 * counts better than token counts.
 */
export function shortenSystem(
	strategy: Exclude<Strategy, 'continuous'>,
	topic: string,
	rules: readonly string[],
	maxTokens: number,
): string {
	const words = Math.floor(maxTokens * 0.7 * 0.75)
	const rulesBlock =
		rules.length === 0
			? ''
			: `\n\nRules from the developer:\n${rules.map((rule) => `- ${rule}`).join('\n')}`
	const keep =
		strategy === 'decay'
			? 'Keep recent facts in detail. Shorten older facts more, or drop them if they no longer matter.'
			: 'Keep the facts that matter most for the topic.'
	return `Here is our understanding of this topic:
${topic}${rulesBlock}

It has grown too long. Shorten it to at most ${words} words.
${keep}
Where something changed, keep the current value.
Do not add anything that is not in the understanding: no advice, no lessons, no next steps.
Reply with the shorter understanding only, in plain text.`
}
