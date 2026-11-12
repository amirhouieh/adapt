/**
 * Shared types for all neuron types
 *
 * SharedNeuronEventMap defines the events that BaseNeuron emits.
 * Understanding-specific fields use `unknown` since each neuron type
 * has a different understanding shape (string, ListItem[], etc.).
 */

import type { LanguageModel } from '../../llm'
import type { ResolvedCascadableConfig } from '../../types/config'
import type {
	NeuronHealth,
	NeuronOrigin,
	NeuronStatus,
	Significance,
	TokenUsage,
} from '../types'

/**
 * Thresholds that trigger the understand phase
 */
export interface UnderstandThresholds {
	maxObservations?: number
	maxTokens?: number
	minImportance?: number
}

/**
 * Base resolved config — common fields shared across all neuron types.
 *
 * Each subclass config extends this and adds type-specific fields (e.g. governance).
 */
export interface BaseResolvedConfig extends ResolvedCascadableConfig {
	instructions: string
	observeInstructions: string | null
	understandInstructions: string | null
	id: string
	origin: NeuronOrigin
	understand: { thresholds: Required<UnderstandThresholds> }
	query: { model: LanguageModel }
}

/**
 * Input shape for BaseNeuron.update() — all fields optional.
 *
 * Type-specific fields (like governance) pass through via the index signature
 * and are handled by each subclass's applyTypeSpecificUpdates().
 */
export interface BaseNeuronUpdateInput {
	id?: string
	name?: string
	description?: string
	origin?: NeuronOrigin
	model?: LanguageModel
	blueprintModel?: LanguageModel
	instructions?: string
	observeInstructions?: string | null
	understandInstructions?: string | null
	focus?: string | null
	understand?: { thresholds?: UnderstandThresholds }
	query?: { model?: LanguageModel }
	health?: Partial<NeuronHealth>
}

/**
 * Usage data for events (partial — LLM calls may not report all fields)
 */
export interface EventUsage {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
}

/**
 * Event map shared across all neuron types
 *
 * BaseNeuron extends TypedEmitter<SharedNeuronEventMap>.
 * Understanding-typed fields use `unknown` — consumers can narrow
 * based on the concrete neuron type if needed.
 */
export interface SharedNeuronEventMap {
	// Init
	'neuron:init:started': { neuronId: string }
	'neuron:init:completed': {
		neuronId: string
		systemPrompt: string
		usage: TokenUsage
	}
	'neuron:init:failed': { neuronId: string; error: string }

	// Observe phase
	'neuron:observe:started': { neuronId: string; itemCount: number }
	'neuron:observe:thinking': {
		neuronId: string
		thoughts: string[]
		usage: TokenUsage
	}
	'neuron:observed': {
		neuronId: string
		output: unknown[]
		importance: number
		bufferCount: number
		usage?: EventUsage
	}
	'neuron:observe:dismissed': {
		neuronId: string
		output: unknown[]
		gaps: string[]
		usage?: EventUsage
	}
	'neuron:observe:error': { neuronId: string; error: unknown }

	// Synthesize phase (event names preserved for backward compat)
	'neuron:synthesize:started': {
		neuronId: string
		observationCount: number
	}
	'neuron:synthesize:thinking': {
		neuronId: string
		thoughts: string[]
		usage: TokenUsage
	}
	'neuron:synthesized': {
		neuronId: string
		newUnderstanding: unknown
		previousUnderstanding: unknown
		significance: Significance
		evolution: string
		usage?: EventUsage
	}
	'neuron:synthesize:dismissed': {
		neuronId: string
		output: string
		usage?: EventUsage
	}
	'neuron:synthesize:error': { neuronId: string; error: unknown }

	// Learn errors
	'neuron:learn:failed': { neuronId: string; error: string }

	// Query
	'neuron:query:started': { neuronId: string; query: string }
	'neuron:query:completed': {
		neuronId: string
		insight: string
		relevant: boolean
		relevance: number
		confidence: number
		gaps: string[]
		usage: TokenUsage
	}
	'neuron:query:failed': { neuronId: string; error: string }
	'neuron:query:thinking': {
		neuronId: string
		thoughts: string[]
		usage: TokenUsage
	}

	// Health
	'neuron:health:updated': {
		neuronId: string
		activation: number
		status: NeuronStatus
		previousStatus?: NeuronStatus
	}

	// Signal events (Living Brain)
	'neuron:signal': {
		neuronId: string
		description: string
		timestamp: Date
		metrics?: {
			dismissalRate?: number
			avgRelevance?: number
			avgConfidence?: number
			gapCount?: number
			bufferCount?: number
			activation?: number
		}
	}

	// Config updates
	'neuron:config:updated': {
		neuronId: string
		changedFields: string[]
		config: unknown
	}
	'neuron:prompts:regenerated': {
		neuronId: string
		observePrompt: string
		understandPrompt: string
	}
	'neuron:understanding:set': {
		neuronId: string
		understanding: unknown
	}
	'neuron:understanding:adjusted': {
		neuronId: string
		directive: string
		evolution: string
		significance: Significance
	}
}
