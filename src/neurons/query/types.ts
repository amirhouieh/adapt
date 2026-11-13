/**
 * Shared QueryMethod interface and types
 *
 * QueryContext does NOT include understanding — each neuron provides
 * understanding-access tools to the QueryMethod instead.
 */

import type {
	AdaptGenerateOptions,
	AdaptLLMPlugin,
	AdaptStreamResult,
	LanguageModel,
} from '../../llm'
import type { TokenUsage } from '../types'

/**
 * Options passed through to generateText from ai-sdk
 */
export type QueryMode = 'direct' | 'tool-based'

export interface QueryOptions extends AdaptGenerateOptions {
	mode?: QueryMode
	model?: LanguageModel
}

/**
 * Result from a query method's processing
 */
export interface QueryResult {
	/** Whether this neuron can help with the query */
	relevant: boolean
	/** How related is this query to the neuron's domain (0.0 - 1.0) */
	relevance: number
	/** How well the neuron could answer from its understanding (0.0 - 1.0) */
	confidence: number
	/** The insight or response to the query */
	insight: string
	/** What could not be answered (empty string if none) */
	gaps: string
	/** Token usage for this operation */
	usage: TokenUsage
}

/**
 * Context provided to query methods
 *
 * Understanding is NOT included — it's accessed via neuron-provided tools.
 */
export interface QueryContext {
	/** The neuron's unique identifier */
	neuronId: string
	/** The neuron's purpose/instructions */
	instructions: string
	/** The question or query to answer */
	question: string
}

/**
 * Event callbacks for query method observability
 */
export interface QueryCallbacks {
	onThinking?: (thoughts: string[], usage: TokenUsage) => void
}

/**
 * Config accepted by QueryMethod.update()
 */
export interface QueryMethodUpdateConfig {
	model?: LanguageModel
	llm?: AdaptLLMPlugin
}

/**
 * A query method defines how understanding is queried
 */
export interface QueryMethod {
	/** Unique identifier for this method */
	readonly name: string

	/** Process a query against understanding and generate a response */
	query(
		context: QueryContext,
		options?: QueryOptions,
		callbacks?: QueryCallbacks,
	): Promise<QueryResult>

	/** Stream a query — returns an Adapt-shaped stream result */
	queryStream?(
		context: QueryContext,
		options?: QueryOptions,
	): Promise<AdaptStreamResult>

	/** Update the method's config (e.g. swap model) */
	update(config: QueryMethodUpdateConfig): void
}
