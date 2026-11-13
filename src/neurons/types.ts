/**
 * Core types for Neurons
 *
 * A Neuron is an autonomous agent that builds a plain-text understanding
 * over time, learned in two steps (extract, then update).
 */

import type { TextInput } from '../learning/text-state'
import type { AdaptRepairOptions, LanguageModel } from '../llm'
import type { NeuronStore } from '../stores'
import type {
	CascadableConfig,
	ResolvedCascadableConfig,
} from '../types/config'
import type { EventsFromMap, UnifiedHandler } from '../types/events'
import type {
	AdaptiveTextLearningConfig,
	AdaptiveTextLearnOutput,
} from './adaptive-runtime'
import type { NeuronState } from './state'
import type { GovernanceConfig } from './strategies'

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
 * Token usage information from LLM calls
 */
export interface TokenUsage {
	inputTokens: number
	outputTokens: number
	totalTokens: number
}

/**
 * Usage data for events (partial — LLM calls may not report all fields)
 */
export interface EventUsage {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
}

// ── Learn ───────────────────────────────────────────────────────────────────

/** What a neuron learns from: plain text, or a TextInput with caller-owned ids and times. */
export type LearnInput = string | TextInput

/**
 * Options for learn() call
 */
export interface LearnOptions {
	/** Ignored. Learning is always the two-step extract/update flow. */
	forceSynthesize?: boolean
}

/**
 * Output from learn() - discriminated union of all possible outcomes
 */
export type LearnOutput =
	| {
			status: 'observed'
			output: unknown[]
			usage?: EventUsage
	  }
	| {
			status: 'observe:dismissed'
			output: unknown[]
			gaps: string[]
			usage?: EventUsage
	  }
	| { status: 'observe:error'; error: unknown }
	| {
			status: 'synthesized'
			newUnderstanding: string
			significance: Significance
			evolution: string
			reasoning?: string
			usage?: EventUsage
	  }
	| {
			status: 'synthesize:dismissed'
			output: string
			usage?: EventUsage
	  }
	| { status: 'synthesize:error'; error: unknown }
	| AdaptiveTextLearnOutput

export interface AdjustResult {
	changedFields: string[]
	adjustedConfig: boolean
	adjustedUnderstanding: boolean
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Thresholds that trigger the understand phase
 */
export interface UnderstandThresholds {
	maxObservations?: number
	maxTokens?: number
	minImportance?: number
}

export interface QueryConfig {
	/** Optional model override for query phase */
	model?: LanguageModel
}

export interface NeuronConfig extends CascadableConfig, AdaptRepairOptions {
	/** Default model for all operations */
	model: LanguageModel
	/** Natural language instructions for what this neuron tracks and watches for */
	instructions: string
	/** Optional unique identifier */
	id?: string
	/** Optional display name */
	name?: string
	/** Optional description of neuron purpose */
	description?: string
	/** How the neuron was created */
	origin?: NeuronOrigin
	/** Injected store */
	store: NeuronStore
	/** Memory strategy: cumulative (default, 8000 tokens), decay or continuous. */
	governance?: Partial<GovernanceConfig>
	/** Thresholds Brain reads for health signals and evolution. */
	understand?: { thresholds?: UnderstandThresholds }
	/** Query phase configuration */
	query?: QueryConfig
	/** Health configuration (Living Brain) */
	health?: Partial<NeuronHealth>
	/** Subscribe before initialization starts, so init events can be observed. */
	onEvent?: UnifiedHandler<NeuronEvent>
	/** Supply an explicit adaptive text-learning setup. Omit for the default two-step setup. */
	learning?: AdaptiveTextLearningConfig
}

/** NeuronConfig after models are cascaded and defaults applied. */
export interface ResolvedNeuronConfig extends ResolvedCascadableConfig {
	instructions: string
	id: string
	origin: NeuronOrigin
	understand: { thresholds: Required<UnderstandThresholds> }
	query: { model: LanguageModel }
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * Events a Neuron emits.
 */
export interface NeuronEventMap {
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
		newUnderstanding: string
		previousUnderstanding: string
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
		config: NeuronState
	}
	'neuron:prompts:regenerated': {
		neuronId: string
		observePrompt: string
		understandPrompt: string
	}
	'neuron:understanding:set': {
		neuronId: string
		understanding: string
	}
	'neuron:understanding:adjusted': {
		neuronId: string
		directive: string
		evolution: string
		significance: Significance
	}
}

export type NeuronEvent = EventsFromMap<NeuronEventMap>
