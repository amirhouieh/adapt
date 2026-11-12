/**
 * Memory strategies. Run after the two-step update, before the memory is
 * saved (same commit):
 * - continuous: memory grows; nothing happens here.
 * - cumulative: over maxTokens, one call summarizes the memory into a seed.
 * - decay: at 80% of maxTokens, one call compresses older parts and keeps
 *   recent detail.
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

export const DEFAULT_GOVERNANCE: Required<GovernanceConfig> = {
	strategy: 'continuous',
	maxTokens: 4000,
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export async function applyStrategy(
	input: {
		memory: string
		governance: GovernanceConfig
		/** The memory cap of the learning setup; limits stay below it. */
		maxCharacters: number
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

	const prompt =
		governance.strategy === 'cumulative'
			? cumulativeSeedPrompt(memory, maxTokens)
			: decayCompressPrompt(memory, maxTokens)
	const result = await generate({
		llm: input.llm,
		model: input.model,
		prompt,
		abortSignal: input.abortSignal,
		repairWithFeedback: input.repairWithFeedback,
		maxRepairAttempts: input.maxRepairAttempts,
	})
	const text = result.text.trim()
	if (!text)
		throw new Error(`${governance.strategy} strategy returned no memory`)
	return text
}

function cumulativeSeedPrompt(memory: string, maxTokens: number): string {
	return `You are distilling a learning agent's understanding into a seed for a new learning cycle.

CURRENT UNDERSTANDING:
${memory}

TASK:
Create a seed (approximately ${Math.floor(maxTokens * 0.7)} tokens) that captures:
- Core patterns and facts discovered
- Key insights worth preserving
- Foundation for continued learning

The seed should be self-contained — a fresh starting point, not a continuation.
Write it as if beginning a new document that builds on established knowledge.

Output ONLY the seed, nothing else.`
}

function decayCompressPrompt(memory: string, maxTokens: number): string {
	return `You are compressing a learning agent's understanding using decay - older information fades while recent stays detailed.

CURRENT UNDERSTANDING:
${memory}

TASK:
The understanding should have three temporal sections:
- Current State: What's true right now (keep detailed)
- Recent Developments: What changed recently (moderate detail)
- Historical Context: Long-standing patterns (compress heavily)

Compress the Historical Context section significantly while preserving key patterns.
Move older items from Recent Developments to Historical Context.
Keep Current State detailed.

Target approximately ${Math.floor(maxTokens * 0.7)} tokens total.
Output ONLY the restructured understanding with the three sections clearly labeled.`
}
