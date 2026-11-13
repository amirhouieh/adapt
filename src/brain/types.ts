import type { AdaptLLMPlugin, AdaptRepairOptions, LanguageModel } from '../llm'
import type { GeneratedNeuronConfig } from '../neurons/schema.config'
import type { Strategy } from '../neurons/strategies'
import type { LearnOutput, NeuronEventMap, TokenUsage } from '../neurons/types'
import type { BrainStore, NeuronStatus } from '../stores'
import type {
	CascadableConfig,
	ResolvedCascadableConfig,
} from '../types/config'
import type { EventsFromMap, UnifiedHandler } from '../types/events'
import type { EvolutionChange, EvolutionResult } from './evolution'

// ─────────────────────────────────────────────────────────────────────────────
// Learning Config (passed to neurons)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thresholds Brain reads for neuron health signals and evolution
 */
export interface UnderstandPhaseConfig {
	thresholds?: {
		maxObservations?: number
		maxTokens?: number
		minImportance?: number
	}
}

/**
 * Query phase configuration
 */
export interface QueryPhaseConfig {
	model?: LanguageModel
}

/**
 * Governance configuration (neuron memory strategy)
 */
export interface GovernanceConfig {
	strategy?: Strategy
	maxTokens?: number
}

/**
 * Learning config - applied to all auto-generated neurons
 *
 * Semantic fields (instructions, name, description) run evolution when used
 * in brain.update(). Mechanical fields cascade directly to neurons.
 */
export interface LearningConfig extends CascadableConfig {
	/** Neuron instructions (semantic — runs evolution) */
	instructions?: string
	/** Neuron name (semantic — runs evolution) */
	name?: string
	/** Neuron description (semantic — runs evolution) */
	description?: string
	understand?: UnderstandPhaseConfig
	query?: QueryPhaseConfig
	governance?: GovernanceConfig
}

// ─────────────────────────────────────────────────────────────────────────────
// Brain Config (input)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Init phase configuration (decomposition)
 */
export interface InitPhaseConfig {
	model?: LanguageModel
}

/**
 * Brain query configuration (ask synthesis)
 */
export interface BrainQueryConfig {
	model?: LanguageModel
}

/**
 * Ingest configuration
 */
export interface IngestConfig {
	batchSize?: number
}

/**
 * Evolution configuration (Living Brain)
 */
export interface EvolutionConfig {
	/** Whether evolution is enabled */
	enabled?: boolean
	/** Model for the evolution loop. Falls back to the default model. */
	model?: LanguageModel
	/** Buffered signals that start an evolution run (default: 5) */
	evaluatorSignalThreshold?: number
	/** Run evolution by itself when the threshold is reached (default: true) */
	autoEvaluate?: boolean
	coverageGap?: {
		/** When every neuron answers a question below this relevance, the question is a gap (default: 0.3) */
		relevanceThreshold?: number
	}
}

/**
 * Per-internal-neuron config: true = enabled with defaults, object = enabled with overrides, false = disabled
 */
export type InternalNeuronToggle = boolean | Partial<LearningConfig>

/**
 * Configuration for Brain's internal neurons
 */
export interface InternalNeuronsConfig {
	globalUnderstanding?: InternalNeuronToggle
	globalQueryUnderstanding?: InternalNeuronToggle
	injectionGaps?: InternalNeuronToggle
	queryGaps?: InternalNeuronToggle
}

/**
 * Configuration for the dismissed batch buffer
 */
export interface DismissedBatchBufferConfig {
	/** Max number of dismissed batches to retain (default: 100) */
	maxSize?: number
}

/**
 * Configuration for creating a Brain
 */
export interface BrainConfig extends CascadableConfig, AdaptRepairOptions {
	/** Natural language prompt describing what to track and learn */
	prompt: string
	/** Default model - cascades to all operations */
	model: LanguageModel
	/**
	 * Custom LLM plugin for BYO runtimes (Effect, in-house clients, etc.).
	 * Defaults to the AI SDK plugin which uses the live `model` you passed.
	 */
	llm?: AdaptLLMPlugin
	/** Init phase config (decomposition) */
	init?: InitPhaseConfig
	/** Query config (brain.ask synthesis) */
	query?: BrainQueryConfig
	/** Ingest config */
	ingest?: IngestConfig
	/** Learning config (applied to all neurons) */
	learning?: LearningConfig
	/** Evolution config (Living Brain) */
	evolution?: EvolutionConfig
	/** Brain's own persistence store. Defaults to MemoryBrainStore. */
	store?: BrainStore
	/** Explicit neuron definitions. Created on init. */
	neurons?: GeneratedNeuronConfig[]
	/**
	 * When true (default), Brain auto-generates neurons from the prompt via LLM.
	 * When false, only explicit `neurons` are used — no LLM decomposition.
	 * Both `prompt` and `neurons` can coexist regardless of this flag.
	 */
	autoSetup?: boolean
	/** Internal neurons config (all enabled by default) */
	internalNeurons?: InternalNeuronsConfig
	/** Dismissed batch buffer config */
	dismissedBatchBuffer?: DismissedBatchBufferConfig
	/** Subscribe before initialization starts, so init events can be observed. */
	onEvent?: UnifiedHandler<BrainEvent>
}

/**
 * Per-call runtime override accepted by `Brain.restore(input, runtime?)`.
 * Carries the LLM context the brain needs to interpret persisted model
 * configs after the process has restarted (or otherwise lost the in-memory
 * cache from `Brain.create`).
 *
 * Pick exactly one form:
 *  - `model: openai('gpt-4o')` — covers the 90% case (single AI SDK provider).
 *  - per-slot `init/query/etc.` — when the brain was created with multi-slot
 *    model overrides.
 *  - `llm: customPlugin` — for BYO runtimes (Effect, in-house clients, etc.).
 *
 * All optional. Pass nothing if the same process already cached the live
 * model from a prior `Brain.create` call (in-memory restore).
 */
export interface BrainRuntimeOptions extends AdaptRepairOptions {
	model?: LanguageModel
	blueprintModel?: LanguageModel
	init?: { model?: LanguageModel }
	query?: { model?: LanguageModel }
	evolution?: { model?: LanguageModel }
	learning?: LearningConfig
	llm?: AdaptLLMPlugin
	/** Subscribe before restore initialization starts, so init events can be observed. */
	onEvent?: UnifiedHandler<BrainEvent>
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved Brain Config (computed view of BrainState — returned by brain.config getter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computed view of BrainState in the traditional config shape.
 *
 * Returned by `brain.config` getter. NOT a stored value — it's derived
 * from `this.state` on every access.
 */
export interface ResolvedBrainConfig extends ResolvedCascadableConfig {
	prompt: string
	init: { model: LanguageModel }
	query: { model: LanguageModel }
	ingest: { batchSize: number }
	evolution: {
		enabled: boolean
		model: LanguageModel
		evaluatorSignalThreshold: number
		autoEvaluate: boolean
		coverageGap: {
			relevanceThreshold: number
		}
	}
}

/**
 * Options for brain.inject()
 */
export interface BrainInjectOptions {
	/** Custom inject ID. If not provided, auto-generated with inject_ prefix */
	id?: string
}

/**
 * Result from a single neuron within a batch
 */
export interface NeuronBatchResult {
	neuronId: string
	result: LearnOutput
}

/**
 * Result from processing a single batch
 */
export interface BatchResult {
	/** Unique batch identifier (batch_xxx) */
	id: string
	/** 0-indexed position within the inject operation */
	index: number
	/** Results from each neuron for this batch */
	results: NeuronBatchResult[]
}

/**
 * Result from injecting data into the Brain
 */
export interface BrainInjectResult {
	/** Unique inject identifier (inject_xxx) */
	id: string
	/** Results grouped by batch */
	batches: BatchResult[]
}

/**
 * Result from asking the Brain a question
 */
export interface BrainAskResult {
	/** Synthesized answer integrating all neuron insights */
	insight: string
	/** Individual neuron responses */
	sources: Array<{
		neuronId: string
		relevance: number
		confidence: number
		insight: string
	}>
	/** Aggregated gaps from all neurons */
	gaps: string[]
}

/**
 * Result from brain.consult() — querying internal neurons
 */
export interface ConsultResult {
	insight: string
	sources: Array<{
		neuronId: string
		relevance: number
		confidence: number
		insight: string
	}>
	gaps: string[]
}

/**
 * Options for brain.consult()
 */
export interface ConsultOptions {
	/** Query a specific internal neuron by ID */
	neuron?: string
}

/**
 * Result from brain.update()
 */
export interface BrainUpdateResult {
	/** Brain-level fields that changed */
	changedFields: string[]
	/** Current resolved brain config after update */
	config: ResolvedBrainConfig
	/** Per-neuron summary of what changed (from neuron.update() calls) */
	neuronResults: Array<{
		neuronId: string
		changedFields: string[]
	}>
	/** Present only when the update ran evolution */
	evolution?: EvolutionResult
}

/**
 * Neuron response for ask synthesis
 */
export interface NeuronResponse {
	neuronId: string
	name: string
	relevant: boolean
	relevance: number
	confidence: number
	insight: string
	gaps: string[]
}

/**
 * Brain's own events (not forwarded from neurons)
 */
export interface BrainOwnEventMap {
	// Init
	'brain:init:started': Record<string, never>
	'brain:init:config:generating': Record<string, never>
	'brain:init:config:generated': {
		configs: GeneratedNeuronConfig[]
		usage: TokenUsage
	}
	'brain:init:completed': { neuronIds: string[] }
	'brain:init:failed': { error: string }

	// Inject
	'brain:inject:started': {
		injectId: string
		itemCount: number
		batchCount: number
	}
	'brain:inject:batch:started': {
		injectId: string
		batchId: string
		batchIndex: number
		itemCount: number
	}
	'brain:inject:batch:completed': {
		injectId: string
		batchId: string
		batchIndex: number
		results: NeuronBatchResult[]
	}
	'brain:inject:completed': { injectId: string; batches: BatchResult[] }
	'brain:inject:failed': { injectId: string; error: string }

	// Ask
	'brain:ask:started': { queryId: string; query: string }
	'brain:ask:synthesis:started': {
		queryId: string
		specialists: string[]
	}
	'brain:ask:completed': {
		queryId: string
		insight: string
		sources: BrainAskResult['sources']
		gaps: string[]
		usage: TokenUsage
	}
	'brain:ask:failed': { queryId: string; error: string }

	// Neuron management
	'brain:neuron:added': {
		neuronId: string
		name: string
		instructions: string
	}
	'brain:neuron:removed': {
		neuronId: string
	}
	'brain:neuron:status:changed': {
		neuronId: string
		previousStatus: NeuronStatus
		newStatus: NeuronStatus
	}

	// Evolution
	'brain:signal:received': {
		source: string
		description: string
		timestamp: Date
	}
	'evolution:started': { signalCount: number }
	'evolution:change': EvolutionChange
	'evolution:completed': EvolutionResult
	'evolution:failed': { error: string }

	// Brain config update events
	'brain:config:updated': {
		updates: Partial<BrainConfig>
		changedFields: string[]
	}
}

/**
 * Combined Brain event map (Brain's own events + forwarded neuron events)
 */
export type BrainEventMap = BrainOwnEventMap & NeuronEventMap

/**
 * Union type of all Brain events
 */
export type BrainEvent = EventsFromMap<BrainEventMap>
