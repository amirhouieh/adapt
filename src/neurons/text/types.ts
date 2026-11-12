import type { AdaptRepairOptions, LanguageModel } from '../../llm'
import type { NeuronStore } from '../../stores'
import type { CascadableConfig } from '../../types/config'
import type { EventsFromMap, UnifiedHandler } from '../../types/events'
import type { BaseNeuronState } from '../base/state'
import type {
	BaseResolvedConfig,
	SharedNeuronEventMap,
	UnderstandThresholds,
} from '../base/types'
import type { NeuronOrigin, Significance } from '../types'
import type { AdaptiveTextLearningConfig } from './adaptive-runtime'
import type { GovernanceConfig } from './strategies'

/**
 * TextNeuron event map
 *
 * Extends SharedNeuronEventMap with narrowed types for text-specific fields.
 */
export interface TextNeuronEventMap extends SharedNeuronEventMap {
	'neuron:synthesized': {
		neuronId: string
		newUnderstanding: string
		previousUnderstanding: string
		significance: Significance
		evolution: string
		usage?: {
			inputTokens?: number
			outputTokens?: number
			totalTokens?: number
		}
	}
	'neuron:config:updated': {
		neuronId: string
		changedFields: string[]
		config: ResolvedTextNeuronConfig
	}
	'neuron:understanding:set': {
		neuronId: string
		understanding: string
	}
}

export type TextNeuronEvent = EventsFromMap<TextNeuronEventMap>

// ── Query ───────────────────────────────────────────────────────────────────

export interface QueryConfig {
	/** Optional model override for query phase */
	model?: LanguageModel
}

// ── TextNeuron Config (input) ──────────────────────────────────────────────

export interface TextNeuronConfig extends CascadableConfig, AdaptRepairOptions {
	/** Default model for all operations */
	model: LanguageModel
	/** Natural language instructions for what this neuron tracks and watches for */
	instructions: string
	/** Optional observe-phase-only instructions */
	observeInstructions?: string | null
	/** Optional understand-phase-only instructions */
	understandInstructions?: string | null
	/** Optional focus areas to narrow observation filtering */
	focus?: string | null
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
	/** Memory strategy: continuous (default), cumulative or decay. */
	governance?: Partial<GovernanceConfig>
	/** Thresholds Brain reads for health signals and evolution. */
	understand?: { thresholds?: UnderstandThresholds }
	/** Query phase configuration */
	query?: QueryConfig
	/** Health configuration (Living Brain) */
	health?: Partial<import('../types').NeuronHealth>
	/** Subscribe before initialization starts, so init events can be observed. */
	onEvent?: UnifiedHandler<EventsFromMap<SharedNeuronEventMap>>
	/** Supply an explicit adaptive text-learning setup. Omit for the default two-step setup. */
	learning?: AdaptiveTextLearningConfig
}

// ── Resolved Config ─────────────────────────────────────────────────────────

export type ResolvedTextNeuronConfig = BaseResolvedConfig

export interface TextNeuronUpdateResult {
	changedFields: string[]
	config: ResolvedTextNeuronConfig
}

// ── State ──────────────────────────────────────────────────────────────────

export interface TextNeuronState extends BaseNeuronState {
	governance: Required<GovernanceConfig>
}
