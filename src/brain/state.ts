/**
 * Brain state types
 *
 * The state object is the single source of truth for all persisted Brain data.
 * Cached in memory as `this.state`, backed by `store.state`.
 * Same pattern as NeuronState — everything persisted, stateTransforms
 * handle the serialization boundary for non-serializable types (models).
 *
 * What lives in state (persisted):
 * - prompt — brain identity/purpose
 * - models — all model slots (live model inputs on fresh create; model configs in store)
 * - ingest — batch size config
 * - evolution — evolution system config + runtime counters
 *
 * What stays outside state (not serializable, immutable, or runtime-only):
 * - store — the persistence layer itself
 * - neurons Map — live instances, rebuilt from store.neurons on restore
 * - evaluator, orchestrator — rebuilt on init
 * - autoSetup — constructor config, only affects first init
 * - neuronStoreFactory — constructor config, factory function
 * - configNeurons — constructor config, only affects first init
 */

import type { AdaptLLMPlugin, AdaptModelConfig, LanguageModel } from '../llm'
import { toModelConfig } from '../llm'
import type { PromptContext } from './prompts/prompt.decompose-brain-prompt'

// ── Model types ─────────────────────────────────────────────────────────────

/**
 * Model reference as stored in the store (serializable).
 */
export type StoredBrainModelRef = AdaptModelConfig & {
	/** Legacy 0.0.5 shape. Deserialized into `id`. */
	modelId?: string
}

/**
 * All model slots a Brain uses.
 * In the cache: live LanguageModel inputs or restored AdaptModelConfig values.
 * In the store: serialized AdaptModelConfig values.
 */
export interface BrainModelSlots {
	default: LanguageModel
	blueprint: LanguageModel
	init: LanguageModel
	query: LanguageModel
	evolution: LanguageModel
}

// ── State types ─────────────────────────────────────────────────────────────

/**
 * Persisted Brain state — backed by store.state.
 * Single source of truth for all Brain config and runtime data.
 */
export interface BrainState {
	// Identity
	prompt: string

	// LLM-extracted context from brain prompt (null before init)
	promptContext: PromptContext | null

	// Models (LanguageModel in cache; StoredBrainModelRef in store)
	models: BrainModelSlots

	// Ingest config
	ingest: {
		batchSize: number
	}

	// Evolution config + runtime counters
	evolution: {
		enabled: boolean
		evaluatorSignalThreshold: number
		autoEvaluate: boolean
		coverageGap: {
			relevanceThreshold: number
		}
	}
}

// ── Transform types ─────────────────────────────────────────────────────────

/**
 * Serialize/deserialize pair for a single state key.
 * Keys not in the transforms map pass through as-is.
 */
export interface BrainStateTransform {
	serialize: (value: unknown) => unknown
	deserialize: (value: unknown) => unknown
}

// ── Serialization helpers ───────────────────────────────────────────────────

/**
 * Extract a serializable model config from a model input.
 */
export function toBrainModelRef(
	model: LanguageModel,
	plugin: AdaptLLMPlugin,
): StoredBrainModelRef {
	return toModelConfig(model, plugin) as StoredBrainModelRef
}

/**
 * Serialize all brain model slots for store persistence.
 */
export function serializeBrainModelSlots(
	models: BrainModelSlots,
	plugin: AdaptLLMPlugin,
): Record<string, StoredBrainModelRef> {
	return Object.fromEntries(
		Object.entries(models).map(([key, model]) => [
			key,
			toBrainModelRef(model, plugin),
		]),
	)
}

/**
 * Rehydrate brain model slots into persisted model configs. Do not synthesize
 * AI SDK Gateway strings here; the active LLM plugin interprets the config at
 * call time.
 */
export function deserializeBrainModelSlots(
	stored: Record<string, StoredBrainModelRef>,
): BrainModelSlots {
	const out: Record<string, LanguageModel> = {}
	for (const [key, ref] of Object.entries(stored)) {
		out[key] = normalizeStoredBrainModelRef(ref)
	}
	return out as unknown as BrainModelSlots
}

function normalizeStoredBrainModelRef(
	ref: StoredBrainModelRef,
): AdaptModelConfig {
	return {
		plugin: ref.plugin ?? 'ai-sdk',
		...(ref.provider ? { provider: ref.provider } : {}),
		id: ref.id ?? ref.modelId ?? 'unknown',
		...(ref.options ? { options: ref.options } : {}),
	}
}

/**
 * Create initial BrainState from resolved config values.
 */
export function createInitialBrainState(config: {
	prompt: string
	model: LanguageModel
	blueprintModel: LanguageModel
	initModel: LanguageModel
	queryModel: LanguageModel
	evolutionModel: LanguageModel
	batchSize: number
	evolution: BrainState['evolution']
}): BrainState {
	return {
		prompt: config.prompt,
		promptContext: null,
		models: {
			default: config.model,
			blueprint: config.blueprintModel,
			init: config.initModel,
			query: config.queryModel,
			evolution: config.evolutionModel,
		},
		ingest: {
			batchSize: config.batchSize,
		},
		evolution: config.evolution,
	}
}
