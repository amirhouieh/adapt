/**
 * Core types for Neurons
 *
 * A Neuron is an autonomous agent that builds understanding over time.
 * It has a fixed purpose, type-specific understanding, and tools it can use.
 */

export type NeuronOrigin = 'prompt' | 'developer' | 'emergent'
export type NeuronStatus = 'active' | 'dormant'
export type Significance = 'routine' | 'notable' | 'critical'

export interface NeuronHealth {
	activation: number // 0.0 - 1.0
	threshold: number // gates participation
	status: NeuronStatus
	lastAccessed: Date
	signalThresholds: {
		maxDismissalRate: number // Default: 0.8 - alert when dismissal rate exceeds this
		minRelevance: number // Default: 0.3 - alert when query relevance falls below this
		minConfidence: number // Default: 0.3 - alert when query confidence falls below this
		maxObservationsWithoutSynthesis: number // Default: 3 * maxObservations
	}
}

/**
 * Runtime metrics for neuron operations, separated by phase
 */
export interface NeuronMetrics {
	ingestion: {
		observationCount: number
		dismissalCount: number
		dismissalRate: number
		synthesisCount: number
		observationsSinceLastSynthesis: number
	}
	query: {
		count: number
		relevanceScores: number[] // rolling window of last 10
		confidenceScores: number[] // rolling window of last 10
		gaps: string[] // accumulated gap descriptions
	}
}

export interface NeuronMetadata {
	id: string
	instructions: string
	origin: NeuronOrigin
	health: NeuronHealth
}

/**
 * Base interface all neurons implement
 */
export interface Neuron<TUnderstanding = unknown> {
	readonly id: string
	readonly instructions: string
	readonly origin: NeuronOrigin

	// Current state
	getUnderstanding(): Promise<TUnderstanding>
	getHealth(): NeuronHealth
	getMetrics(): NeuronMetrics

	// Core operations
	learn(batch: unknown[]): Promise<unknown>
	query(question: string): Promise<unknown>

	// Introspection
	getSummary(): Promise<string>
	getMetadata(): NeuronMetadata
}

/**
 * Token usage information from LLM calls
 */
export interface TokenUsage {
	inputTokens: number
	outputTokens: number
	totalTokens: number
}

/**
 * Static metadata for a neuron type.
 * Brain's evolution system uses descriptors for dispatch and LLM prompts.
 */
export interface NeuronTypeDescriptor {
	/** Type identifier: 'text' | future types */
	type: string
	/** When to use this type (for evaluator/decomposition prompts) */
	description: string
	/** Instantiate the right class from config + store */
	factory(
		config: Record<string, unknown>,
	): import('./base/class').BaseNeuron<unknown>
	/** Zod schema for merge LLM output (e.g., z.string() for text, z.array() for list) */
	mergeUnderstandingSchema: import('zod').ZodType
	/** Zod schema for split LLM output */
	splitUnderstandingSchema: import('zod').ZodType
}
