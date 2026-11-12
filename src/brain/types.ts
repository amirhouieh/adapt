import type { AdaptLLMPlugin, AdaptRepairOptions, LanguageModel } from '../llm'
import type { LearnOutput } from '../neurons/base/class'
import type { SharedNeuronEventMap } from '../neurons/base/types'
import type { GeneratedNeuronConfig } from '../neurons/schema.config'
import type { Strategy } from '../neurons/text/strategies'
import type { TokenUsage } from '../neurons/types'
import type { BrainStore, NeuronStatus } from '../stores'
import type {
	CascadableConfig,
	ResolvedCascadableConfig,
} from '../types/config'
import type { EventsFromMap, UnifiedHandler } from '../types/events'
import type { EvolutionDecision } from './evaluator/types'

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
 * Governance configuration (text neuron memory strategy)
 */
export interface GovernanceConfig {
	strategy?: Strategy
	maxTokens?: number
}

/**
 * Learning config - applied to all auto-generated neurons
 *
 * Semantic fields (instructions, name, description) go through the evaluator
 * when used in brain.update(). Mechanical fields cascade directly to neurons.
 */
export interface LearningConfig extends CascadableConfig {
	/** Neuron instructions (semantic — goes through evaluator) */
	instructions?: string
	/** Neuron name (semantic — goes through evaluator) */
	name?: string
	/** Neuron description (semantic — goes through evaluator) */
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
	/** Model used for evolution evaluation (runtime, recurring). Falls back to default model. */
	model?: LanguageModel
	/** Number of signals before auto-evaluation */
	evaluatorSignalThreshold?: number
	/** Whether to auto-evaluate when threshold reached */
	autoEvaluate?: boolean
	/** Coverage gap detection config */
	coverageGap?: {
		/** Relevance below this counts as "not relevant" (default: 0.3) */
		relevanceThreshold?: number
		/** Number of gap queries before signaling (default: 5) */
		gapCountThreshold?: number
		/** Window size for counting (default: 20) */
		windowSize?: number
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
	/** Explicit neuron definitions (uses existing text/list types). Created on init. */
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
 * from `this.state` on every access. External readers (evaluator, evolution
 * handlers, evals) consume this shape.
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
			gapCountThreshold: number
			windowSize: number
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
	/** Present only when signal-driven evaluation was triggered */
	evolutionResults?: {
		decisions: EvolutionDecision[]
		created: string[]
		updated: string[]
		deleted: string[]
		merged: string[]
		split: string[]
	}
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

	// Signal events (Living Brain)
	'brain:signal:received': {
		source: string
		description: string
		timestamp: Date
	}

	// Evaluator events (Living Brain)
	'evaluator:evaluation:started': {
		signalCount: number
	}
	'evaluator:evaluation:completed': {
		source: 'auto' | 'manual'
		decisionCount: number
		decisions: Array<{
			action: 'create' | 'merge' | 'split' | 'update' | 'delete'
			reasoning: string
			guidance: string
			targets: string[]
		}>
		reasoning: string
	}
	'evaluator:evaluation:failed': {
		error: string
	}

	// Evolution action events (Living Brain)
	'evolution:action:started': {
		action: string
		targets: string[]
		timestamp: Date
	}
	'evolution:action:executed': {
		action: 'create' | 'merge' | 'split' | 'update' | 'delete'
		reasoning: string
		guidance: string
		targets: string[]
		timestamp: Date
		result: {
			newNeuronIds?: string[]
			deletedNeuronIds?: string[]
			updatedNeuronIds?: string[]
		}
	}
	'evolution:action:failed': {
		action: string
		targets: string[]
		error: string
		timestamp: Date
	}

	// Brain config update events
	'brain:config:updated': {
		updates: Partial<BrainConfig>
		changedFields: string[]
	}
}

/**
 * Combined Brain event map (Brain's own events + forwarded neuron events)
 */
export type BrainEventMap = BrainOwnEventMap & SharedNeuronEventMap

/**
 * Union type of all Brain events
 */
export type BrainEvent = EventsFromMap<BrainEventMap>
