/**
 * Understanding management strategies
 */
export const STRATEGIES = ['continuous', 'cumulative', 'decay'] as const
export type Strategy = (typeof STRATEGIES)[number]

/**
 * Governance configuration for text understanding management
 */
export interface GovernanceConfig {
	strategy: Strategy
	maxTokens?: number
}
