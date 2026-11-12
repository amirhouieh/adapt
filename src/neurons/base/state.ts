/**
 * Neuron state types
 *
 * The state object is the single source of truth for all neuron config and runtime data.
 * Cached in memory as `this.state`, backed by `store.state`.
 *
 * Models are stored as JSON model configs. Runtime plugins interpret those
 * configs when an LLM call is made.
 */

import type { AdaptLLMPlugin, AdaptModelConfig, LanguageModel } from '../../llm'
import { toModelConfig } from '../../llm'
import type { NeuronHealth, NeuronMetrics, NeuronOrigin } from '../types'

// ── Model types ─────────────────────────────────────────────────────────────

/**
 * Model reference as stored in the store (serializable).
 */
export type StoredModelRef = AdaptModelConfig & {
	/** Legacy 0.0.5 shape. Deserialized into `id`. */
	modelId?: string
}

/**
 * All model slots a neuron uses.
 * In the cache: live model inputs or restored AdaptModelConfig values.
 * In the store: serialized AdaptModelConfig values.
 */
export interface ModelSlots {
	default: LanguageModel
	blueprint: LanguageModel
	observer: LanguageModel
	observer_blueprint: LanguageModel
	understand: LanguageModel
	understand_blueprint: LanguageModel
	query: LanguageModel
}

// ── State types ─────────────────────────────────────────────────────────────

/**
 * Base neuron state — shared across all neuron types.
 *
 * Everything that gets cached in `this.state` and persisted to `store.state`.
 * Understanding is NOT here — it lives in `store.understanding` (not cached).
 *
 * What stays outside state (not serializable or immutable):
 * - `id` — immutable neuron identity
 * - `store` — the store reference itself
 * - `initPromise` — internal lazy-init promise
 * - `queryMethod` — runtime query method instance
 */
export interface BaseNeuronState {
	// Semantic identity
	instructions: string
	observeInstructions: string | null
	understandInstructions: string | null
	name: string
	description: string
	focus: string | null
	origin: NeuronOrigin

	// Models (model inputs in cache; StoredModelRef in store)
	models: ModelSlots

	// Phase config
	thresholds: {
		maxObservations: number
		maxTokens: number
		minImportance: number
	}

	// Runtime
	health: NeuronHealth
	metrics: NeuronMetrics
	dismissal_signal_fired: boolean
}

// ── Transform types ─────────────────────────────────────────────────────────

/**
 * Serialize/deserialize pair for a single state key.
 * Keys not in the transforms registry pass through as-is (identity transform).
 */
export interface StateTransform {
	serialize: (value: unknown) => unknown
	deserialize: (value: unknown) => unknown
}

// ── Serialization helpers ───────────────────────────────────────────────────

/**
 * Extract a serializable model config from a model input.
 */
export function toStoredModelRef(
	model: LanguageModel,
	plugin: AdaptLLMPlugin,
): StoredModelRef {
	return toModelConfig(model, plugin) as StoredModelRef
}

/**
 * Serialize all model slots for store persistence
 */
export function serializeModelSlots(
	models: ModelSlots,
	plugin: AdaptLLMPlugin,
): Record<string, StoredModelRef> {
	return Object.fromEntries(
		Object.entries(models).map(([key, model]) => [
			key,
			toStoredModelRef(model, plugin),
		]),
	)
}

/**
 * Rehydrate model slots into persisted model configs. Runtime plugins resolve
 * those configs at call time.
 */
export function deserializeModelSlots(
	stored: Record<string, StoredModelRef>,
): ModelSlots {
	const out: Record<string, LanguageModel> = {}
	for (const [key, ref] of Object.entries(stored)) {
		out[key] = normalizeStoredModelRef(ref)
	}
	return out as unknown as ModelSlots
}

function normalizeStoredModelRef(ref: StoredModelRef): AdaptModelConfig {
	return {
		plugin: ref.plugin ?? 'ai-sdk',
		...(ref.provider ? { provider: ref.provider } : {}),
		id: ref.id ?? ref.modelId ?? 'unknown',
		...(ref.options ? { options: ref.options } : {}),
	}
}
