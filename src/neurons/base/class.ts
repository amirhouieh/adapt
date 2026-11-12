/**
 * BaseNeuron — abstract base class for all neuron types
 *
 * Owns the full pipeline: observe → store → understand → governance.
 * Store is injected — neuron has no knowledge of storage backend.
 *
 * All serializable config and runtime data lives in `this.state`,
 * cached in memory and backed by `store.state`.
 * Understanding is NOT cached — it lives in `store.understanding`.
 *
 * Subclasses implement type-specific behavior:
 * - regenUnderstandPrompt (identity/prompt generation)
 * - callUnderstand, postProcessUnderstanding (understand phase)
 * - getUnderstanding, setUnderstanding, getSummary, hasKnowledge
 * - createQueryMethod, applyTypeSpecificUpdates
 */

import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
	type AdaptLLMPlugin,
	type AdaptRepairOptions,
	type AdaptStreamResult,
	generate,
	type LanguageModel,
	Output,
} from '../../llm'
import type {
	EvolutionRecord,
	NeuronStore,
	ObservationRecord,
} from '../../stores'
import { TypedEmitter } from '../../types/events'
import type {
	QueryCallbacks,
	QueryMethod,
	QueryOptions,
	QueryResult,
} from '../base/query'
import { initObserve, observe } from '../observer'
import type {
	Neuron,
	NeuronHealth,
	NeuronMetadata,
	NeuronMetrics,
	NeuronOrigin,
	Significance,
} from '../types'
import {
	resolveObserveInstructions,
	resolveUnderstandInstructions,
} from './instructions'
import type {
	BaseNeuronState,
	ModelSlots,
	StateTransform,
	StoredModelRef,
} from './state'
import { deserializeModelSlots, serializeModelSlots } from './state'
import type { BaseNeuronUpdateInput, SharedNeuronEventMap } from './types'

/**
 * Output from learn() - discriminated union of all possible outcomes
 */
export type LearnOutput =
	| {
			status: 'observed'
			output: unknown[]
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| {
			status: 'observe:dismissed'
			output: unknown[]
			gaps: string[]
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| { status: 'observe:error'; error: unknown }
	| {
			status: 'synthesized'
			newUnderstanding: unknown
			significance: Significance
			evolution: string
			reasoning?: string
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| {
			status: 'synthesize:dismissed'
			output: string
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| { status: 'synthesize:error'; error: unknown }
	| ManagedLearnOutput

/** Typed extension point for neuron-owned learning lifecycles. */
export interface ManagedLearnOutput {
	readonly status: 'managed'
	readonly mode: string
}

/**
 * Options for learn() call
 */
export interface LearnOptions {
	forceSynthesize?: boolean
}

const preparedUnderstandModel: unique symbol = Symbol('preparedUnderstandModel')

/** In-process phase hand-off. This is not a durable checkpoint. */
export type LearnPreparation =
	| { readonly kind: 'complete'; readonly output: LearnOutput }
	| {
			readonly kind: 'synthesize'
			readonly failureEvent: 'emit' | 'skip'
			readonly [preparedUnderstandModel]: LanguageModel
	  }

/**
 * Callbacks for learning observability
 */
export interface LearnCallbacks {
	onObserveStarted?: (itemCount: number) => void
	onObserveThinking?: (thoughts: string[]) => void
	onSynthesizeStarted?: (observationCount: number) => void
	onSynthesizeThinking?: (thoughts: string[]) => void
}

/**
 * Result from callUnderstand — subclass-specific
 */
export type UnderstandCallResult =
	| {
			status: 'synthesized'
			newUnderstanding: unknown
			significance: Significance
			evolution: string
			reasoning?: string
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| {
			status: 'dismissed'
			output: string
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
	  }
	| { status: 'error'; error: unknown }

/**
 * Classification schema for adjust() routing
 */
const adjustClassificationSchema = z.object({
	adjustConfig: z
		.boolean()
		.describe(
			'Whether the directive changes how the node perceives and processes (behavior, focus, criteria, prompts)',
		),
	adjustUnderstanding: z
		.boolean()
		.describe(
			"Whether the directive changes, corrects, or removes something in the node's accumulated knowledge",
		),
	reasoning: z.string().describe('Brief explanation of the classification'),
})

const adjustConfigSchema = z.object({
	instructions: z
		.string()
		.describe(
			'Updated shared developer instructions after applying the directive',
		),
	observeInstructions: z
		.string()
		.nullable()
		.describe(
			'Updated observe-phase override, or null to use shared instructions',
		),
	understandInstructions: z
		.string()
		.nullable()
		.describe(
			'Updated understand-phase override, or null to use shared instructions',
		),
	focus: z
		.string()
		.nullable()
		.describe('Updated observe-only focus, or null if none'),
})

/**
 * Result from adjust() — indicates what was adjusted
 */
export interface AdjustResult {
	changedFields: string[]
	adjustedConfig: boolean
	adjustedUnderstanding: boolean
}

export abstract class BaseNeuron<
		TUnderstanding,
		TState extends BaseNeuronState = BaseNeuronState,
	>
	extends TypedEmitter<SharedNeuronEventMap>
	implements Neuron<TUnderstanding>
{
	readonly id: string
	protected store: NeuronStore
	protected state: TState
	protected queryMethod!: QueryMethod
	protected directQueryMethod?: QueryMethod
	private initialized = false

	// Lazy init promise (for ensureInit)
	private initPromise: Promise<{
		observeSystemPrompt: string
		understandSystemPrompt: string
	}> | null = null

	/**
	 * Transform registry for store ↔ cache boundary.
	 * Keys not in the registry pass through as-is (identity transform).
	 * Subclasses can extend this in their constructor.
	 */
	protected stateTransforms: Record<string, StateTransform>

	/**
	 * The LLM plugin this neuron uses for runtime LLM calls. Each instance
	 * holds its own plugin — there is no global registry. Set at construction.
	 */
	protected llm: AdaptLLMPlugin
	protected repairWithFeedback?: AdaptRepairOptions['repairWithFeedback']
	protected maxRepairAttempts?: number

	constructor(
		id: string,
		llm: AdaptLLMPlugin,
		store: NeuronStore,
		initialState: TState,
		repairOptions?: AdaptRepairOptions,
	) {
		super()
		this.id = id
		this.llm = llm
		this.repairWithFeedback = repairOptions?.repairWithFeedback
		this.maxRepairAttempts = repairOptions?.maxRepairAttempts
		this.store = store
		this.state = initialState
		this.stateTransforms = {
			models: {
				serialize: (v) => serializeModelSlots(v as ModelSlots, this.llm),
				deserialize: (stored) =>
					deserializeModelSlots(stored as Record<string, StoredModelRef>),
			},
			health: {
				serialize: (v) => {
					const h = v as NeuronHealth
					return {
						...h,
						lastAccessed: h.lastAccessed.toISOString(),
					}
				},
				deserialize: (v) => {
					const h = v as Record<string, unknown>
					return {
						...h,
						lastAccessed: new Date(h.lastAccessed as string),
					}
				},
			},
		}
	}

	protected get llmRepairOptions(): AdaptRepairOptions {
		return {
			...(this.repairWithFeedback
				? { repairWithFeedback: this.repairWithFeedback }
				: {}),
			...(this.maxRepairAttempts !== undefined
				? { maxRepairAttempts: this.maxRepairAttempts }
				: {}),
		}
	}

	// ── Abstract — each subclass implements ─────────────────────────────────

	abstract get type(): string
	abstract getUnderstanding(): Promise<TUnderstanding>
	abstract setUnderstanding(value: TUnderstanding): Promise<void>
	abstract getSummary(): Promise<string>
	abstract hasKnowledge(): Promise<boolean>

	/**
	 * Hook for type-specific config updates (e.g. governance).
	 * Returns partial state updates to be merged and persisted.
	 */
	protected abstract applyTypeSpecificUpdates(
		updates: Record<string, unknown>,
		changedFields: string[],
	): Partial<TState>

	/**
	 * Regenerate understand prompt (type-specific — text uses strategy, list uses identity)
	 */
	protected abstract regenUnderstandPrompt(
		model: LanguageModel,
		instructions: string,
	): Promise<void>

	/**
	 * Rebuild a persisted understand prompt from already-loaded state without
	 * making an LLM call. Subclasses return null when they cannot rebuild
	 * deterministically and BaseNeuron should fall back to regenUnderstandPrompt.
	 */
	protected rebuildUnderstandPromptFromState(
		_instructions: string,
	): string | null {
		return null
	}

	/**
	 * Adjust understand prompt from a directive (type-specific)
	 * Unlike regen (stateless), this passes current identity so the LLM can evolve it.
	 */
	protected abstract adjustUnderstandPrompt(
		model: LanguageModel,
		directive: string,
		newInstructions: string,
	): Promise<void>

	/**
	 * Adjust understanding content from a directive (type-specific).
	 * Unlike callUnderstand (which integrates new observations),
	 * this modifies existing understanding based on a natural language directive.
	 */
	protected abstract adjustUnderstanding(
		model: LanguageModel,
		directive: string,
	): Promise<{ evolution: string; significance: Significance }>

	/**
	 * Execute the understand phase (type-specific)
	 */
	protected abstract callUnderstand(
		model: LanguageModel,
		understanding: TUnderstanding,
		observations: string[],
		callbacks?: { onThinking?: (thoughts: string[]) => void },
	): Promise<UnderstandCallResult>

	/**
	 * Transform raw understand output (e.g. apply strategy, dedup, pruning)
	 */
	protected abstract postProcessUnderstanding(
		raw: TUnderstanding,
	): TUnderstanding | Promise<TUnderstanding>

	/**
	 * Create the query method for this neuron type (agentic, tool-based)
	 */
	protected abstract createQueryMethod(): QueryMethod

	/**
	 * Create the direct query method (single-shot, understanding in context).
	 * Optional — falls back to tool-based if not implemented.
	 */
	protected createDirectQueryMethod(): QueryMethod | undefined {
		return undefined
	}

	/**
	 * Generate observation and understanding JSON Schemas.
	 * Text neuron returns hardcoded schemas; list neuron generates via LLM.
	 */
	protected abstract generateSchemas(
		model: LanguageModel,
		instructions: string,
	): Promise<{
		observationSchema: Record<string, unknown>
		understandingSchema: Record<string, unknown>
	}>

	// ── State persistence ────────────────────────────────────────────────────

	/**
	 * Update cache + persist changed keys to store.state.
	 * Each top-level key in updates → one row in store.state.
	 */
	protected async setState(updates: Partial<TState>): Promise<void> {
		Object.assign(this.state, updates)
		const now = new Date().toISOString()
		for (const [key, value] of Object.entries(updates)) {
			const transform = this.stateTransforms[key]
			const serialized = transform ? transform.serialize(value) : value
			const existing = await this.store.state.get(key)
			if (existing) {
				await this.store.state.update(key, {
					value: serialized,
					updated_at: now,
				})
			} else {
				await this.store.state.add({
					id: key,
					value: serialized,
					updated_at: now,
				})
			}
		}
	}

	/**
	 * Load all state from store.state into cache.
	 * Returns true if state was found, false otherwise.
	 */
	protected async loadState(): Promise<boolean> {
		const records = await this.store.state.list()
		if (records.length === 0) return false
		for (const record of records) {
			if (record.id === 'observe_identity') continue
			if (record.id === 'understand_identity' && !(record.id in this.state)) {
				continue
			}
			const transform = this.stateTransforms[record.id]
			;(this.state as Record<string, unknown>)[record.id] = transform
				? transform.deserialize(record.value)
				: record.value
		}
		return true
	}

	private async rebuildRestoredPrompts(): Promise<void> {
		const updates: Partial<TState> = {} as Partial<TState>

		if (!this.state.skipObservation) {
			const result = initObserve(resolveObserveInstructions(this.state))
			;(updates as Record<string, unknown>).observe_prompt = result.systemPrompt
		}

		if (Object.keys(updates).length > 0) {
			await this.setState(updates)
		}

		if (!this.state.skipUnderstand) {
			const instructions = resolveUnderstandInstructions(this.state)
			const prompt = this.rebuildUnderstandPromptFromState(instructions)
			if (prompt !== null) {
				await this.setState({ understand_prompt: prompt } as Partial<TState>)
			} else {
				await this.regenUnderstandPrompt(
					this.state.models.understand_blueprint,
					instructions,
				)
			}
		}
	}

	// ── Init ────────────────────────────────────────────────────────────────

	async init(opts?: { expect?: 'fresh' | 'restore' }): Promise<{
		observeSystemPrompt: string
		understandSystemPrompt: string
	}> {
		if (this.isInitialized()) {
			return {
				observeSystemPrompt: this.state.observe_prompt!,
				understandSystemPrompt: this.state.understand_prompt!,
			}
		}

		this.emit('neuron:init:started', { neuronId: this.id })

		try {
			// Try restoring state from store (skip LLM calls)
			const restored = await this.loadState()

			if (opts?.expect === 'fresh' && restored) {
				throw new Error(
					'Neuron already exists in this store. Use restore() to load it, or use a fresh store.',
				)
			}
			if (opts?.expect === 'restore' && !restored) {
				throw new Error(
					'No neuron found in this store. Use create() to create one.',
				)
			}

			if (!restored) {
				if (!this.state.skipObservation) {
					// Build observe prompt deterministically from verbatim instructions
					const observeResult = initObserve(
						resolveObserveInstructions(this.state),
					)
					this.state.observe_prompt = observeResult.systemPrompt
				}

				if (!this.state.skipUnderstand) {
					// Generate understand prompt (type-specific)
					await this.regenUnderstandPrompt(
						this.state.models.understand_blueprint,
						resolveUnderstandInstructions(this.state),
					)
				}

				// Generate schemas only if not already provided via config
				if (
					this.state.observation_schema === null ||
					this.state.understanding_schema === null
				) {
					const schemas = await this.generateSchemas(
						this.state.models.blueprint,
						this.schemaInstructions(),
					)
					if (this.state.observation_schema === null) {
						this.state.observation_schema = schemas.observationSchema as Record<
							string,
							unknown
						>
					}
					if (this.state.understanding_schema === null) {
						this.state.understanding_schema =
							schemas.understandingSchema as Record<string, unknown>
					}
				}

				// Persist the entire state — every field that lives in BaseNeuronState
				// is data and must round-trip through the store.
				await this.setState({ ...this.state } as Partial<TState>)
			} else {
				await this.rebuildRestoredPrompts()
			}

			// Create query methods
			this.queryMethod = this.createQueryMethod()
			this.directQueryMethod = this.createDirectQueryMethod()
			this.initialized = true

			this.emit('neuron:init:completed', {
				neuronId: this.id,
				systemPrompt: this.state.observe_prompt!,
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			})

			return {
				observeSystemPrompt: this.state.observe_prompt!,
				understandSystemPrompt: this.state.understand_prompt ?? '',
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit('neuron:init:failed', {
				neuronId: this.id,
				error: error.message,
			})
			throw error
		}
	}

	// ── Validation ──────────────────────────────────────────────────────────

	protected validateObservationData(data: unknown): boolean {
		if (!this.state.observation_schema) return true
		return z.fromJSONSchema(this.state.observation_schema).safeParse(data)
			.success
	}

	protected validateUnderstandingData(data: unknown): boolean {
		if (!this.state.understanding_schema) return true
		return z.fromJSONSchema(this.state.understanding_schema).safeParse(data)
			.success
	}

	// ── Identity ────────────────────────────────────────────────────────────

	get instructions(): string {
		return this.state.instructions
	}

	get observeInstructions(): string | null {
		return this.state.observeInstructions
	}

	get understandInstructions(): string | null {
		return this.state.understandInstructions
	}

	get name(): string {
		return this.state.name
	}

	get description(): string {
		return this.state.description
	}

	get focus(): string | null {
		return this.state.focus
	}

	get origin(): NeuronOrigin {
		return this.state.origin
	}

	isInitialized(): boolean {
		// Legacy restored neurons use understand_prompt as a persisted readiness
		// signal. skipUnderstand neurons are marked ready after init completes.
		return this.initialized || this.state.understand_prompt !== null
	}

	private async ensureInit(): Promise<void> {
		if (this.isInitialized()) return
		if (!this.initPromise) {
			this.initPromise = this.init()
		}
		await this.initPromise
	}

	getObserveSystemPrompt(): string | null {
		return this.state.observe_prompt
	}

	getUnderstandSystemPrompt(): string | null {
		return this.state.understand_prompt
	}

	private schemaInstructions(): string {
		return (
			resolveObserveInstructions(this.state) ||
			resolveUnderstandInstructions(this.state) ||
			this.state.instructions
		)
	}

	getUnderstandThresholds() {
		return { ...this.state.thresholds }
	}

	getObservationSchema(): Record<string, unknown> | null {
		return this.state.observation_schema
	}

	getUnderstandingSchema(): Record<string, unknown> | null {
		return this.state.understanding_schema
	}

	// ── Learn (pipeline: observe → store → understand) ────────────────────

	async learn(batch: unknown[], options?: LearnOptions): Promise<LearnOutput> {
		const preparation = await this.prepareLearning(batch, options)
		return this.completeLearning(preparation)
	}

	async prepareLearning(
		batch: unknown[],
		options?: LearnOptions,
	): Promise<LearnPreparation> {
		await this.ensureInit()

		try {
			// Handle forceSynthesize with empty data
			if (
				!this.state.skipUnderstand &&
				options?.forceSynthesize &&
				batch.length === 0
			) {
				const pendingCount = await this.store.observations.count({
					metadata_status: 'pending',
				})
				if (pendingCount > 0) {
					return {
						kind: 'synthesize',
						failureEvent: 'skip',
						[preparedUnderstandModel]: this.state.models.understand,
					}
				}
			}

			// Phase 1: Observe (or skip if skipObservation)
			this.emit('neuron:observe:started', {
				neuronId: this.id,
				itemCount: batch.length,
			})

			let observations: unknown[]
			let importance: number
			let observeUsage:
				| { inputTokens?: number; outputTokens?: number; totalTokens?: number }
				| undefined

			if (this.state.skipObservation) {
				// Skip observe — store raw batch directly
				observations = batch
				importance = 1.0
			} else {
				const observeResult = await observe(
					this.llm,
					this.state.models.observer,
					this.state.observe_prompt!,
					{
						neuronId: this.id,
						instructions: this.state.instructions,
						data: batch,
					},
					this.state.observation_schema ?? undefined,
					{
						onThinking: (thoughts) => {
							this.emit('neuron:observe:thinking', {
								neuronId: this.id,
								thoughts,
								usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
							})
						},
					},
					this.llmRepairOptions,
				)

				if (observeResult.status === 'error') {
					const result: LearnOutput = {
						status: 'observe:error',
						error: observeResult.error,
					}
					await this.handleLearnResult(result)
					return { kind: 'complete', output: result }
				}

				if (observeResult.status === 'dismissed') {
					const result: LearnOutput = {
						status: 'observe:dismissed',
						output: observeResult.output,
						gaps: observeResult.gaps,
						usage: observeResult.usage,
					}
					await this.handleLearnResult(result)
					return { kind: 'complete', output: result }
				}

				// Filter by importance threshold
				const minImportance = this.state.thresholds.minImportance
				if (
					minImportance !== undefined &&
					observeResult.importance < minImportance
				) {
					const result: LearnOutput = {
						status: 'observe:dismissed',
						output: observeResult.output,
						gaps: observeResult.gaps,
						usage: observeResult.usage,
					}
					await this.handleLearnResult(result)
					return { kind: 'complete', output: result }
				}

				observations = observeResult.output
				importance = observeResult.importance
				observeUsage = observeResult.usage
			}

			// Store observations as pending
			for (const item of observations) {
				if (
					!this.state.skipObservation &&
					!this.validateObservationData(item)
				) {
					console.error(`[${this.id}] Skipping invalid observation:`, item)
					continue
				}
				const serialized =
					typeof item === 'string' ? item : JSON.stringify(item)
				await this.store.observations.add({
					id: `obs_${nanoid()}`,
					data: item,
					metadata_importance: importance,
					metadata_tokens: Math.ceil(serialized.length / 4),
					metadata_status: 'pending',
					metadata_created_at: new Date().toISOString(),
				})
			}

			// Check if understand should happen
			const shouldUnderstand =
				!this.state.skipUnderstand &&
				(options?.forceSynthesize ||
					(await this.shouldUnderstand(this.state.thresholds)))

			if (!shouldUnderstand) {
				const bufferState = await this.getBufferState()
				const result: LearnOutput = {
					status: 'observed',
					output: observations,
					usage: observeUsage,
				}
				await this.handleLearnResult(result, bufferState)
				return { kind: 'complete', output: result }
			}

			// Phase 2: Understand
			return {
				kind: 'synthesize',
				failureEvent: 'emit',
				[preparedUnderstandModel]: this.state.models.understand,
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit('neuron:learn:failed', {
				neuronId: this.id,
				error: error.message,
			})
			throw error
		}
	}

	async completeLearning(preparation: LearnPreparation): Promise<LearnOutput> {
		if (preparation.kind === 'complete') return preparation.output
		if (preparation.failureEvent === 'skip') {
			return this.understandFromStore(preparation[preparedUnderstandModel])
		}
		try {
			return await this.understandFromStore(
				preparation[preparedUnderstandModel],
			)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit('neuron:learn:failed', {
				neuronId: this.id,
				error: error.message,
			})
			throw error
		}
	}

	private async understandFromStore(
		model: LanguageModel,
	): Promise<LearnOutput> {
		const pending = await this.store.observations.list({
			metadata_status: 'pending',
		})
		const observations = pending.map((o) =>
			typeof o.data === 'string' ? o.data : JSON.stringify(o.data),
		)

		this.emit('neuron:synthesize:started', {
			neuronId: this.id,
			observationCount: observations.length,
		})

		const understanding = await this.getUnderstanding()
		const understandResult = await this.callUnderstand(
			model,
			understanding,
			observations,
			{
				onThinking: (thoughts) => {
					this.emit('neuron:synthesize:thinking', {
						neuronId: this.id,
						thoughts,
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					})
				},
			},
		)

		// Mark pending observations as processed
		for (const obs of pending) {
			await this.store.observations.update(obs.id, {
				metadata_status: 'processed' as const,
			})
		}

		if (understandResult.status === 'error') {
			const result: LearnOutput = {
				status: 'synthesize:error',
				error: understandResult.error,
			}
			await this.handleLearnResult(result)
			return result
		}

		if (understandResult.status === 'dismissed') {
			const result: LearnOutput = {
				status: 'synthesize:dismissed',
				output: understandResult.output,
				usage: understandResult.usage,
			}
			await this.handleLearnResult(result)
			return result
		}

		const processed = await this.postProcessUnderstanding(
			understandResult.newUnderstanding as TUnderstanding,
		)

		const result: LearnOutput = {
			status: 'synthesized',
			newUnderstanding: processed,
			significance: understandResult.significance,
			evolution: understandResult.evolution,
			reasoning: understandResult.reasoning,
			usage: understandResult.usage,
		}
		await this.handleLearnResult(result)
		return result
	}

	// ── Buffer metrics from store ──────────────────────────────────────────

	async getBufferState(): Promise<{
		count: number
		avgImportance: number
		totalTokens: number
	}> {
		const pending = await this.store.observations.list({
			metadata_status: 'pending',
		})
		const count = pending.length
		const avgImportance =
			count > 0
				? pending.reduce((sum, o) => sum + o.metadata_importance, 0) / count
				: 0
		const totalTokens = Math.ceil(
			pending.reduce((sum, o) => sum + JSON.stringify(o.data).length, 0) / 4,
		)
		return { count, avgImportance, totalTokens }
	}

	async getBufferedObservations(): Promise<
		Array<{ text: string; importance: number }>
	> {
		const pending = await this.store.observations.list({
			metadata_status: 'pending',
		})
		return pending.map((o) => ({
			text: String(o.data),
			importance: o.metadata_importance,
		}))
	}

	async getObservations(filter?: {
		status?: 'pending' | 'processed'
	}): Promise<ObservationRecord[]> {
		return filter?.status
			? this.store.observations.list({ metadata_status: filter.status })
			: this.store.observations.list()
	}

	async setObservations(observations: ObservationRecord[]): Promise<void> {
		await this.store.observations.clear()
		if (observations.length > 0) {
			await this.store.observations.addBatch(observations)
		}
	}

	async updateObservation(
		id: string,
		patch: Partial<Omit<ObservationRecord, 'id'>>,
	): Promise<void> {
		await this.store.observations.update(id, patch)
	}

	async removeObservation(id: string): Promise<void> {
		await this.store.observations.delete(id)
	}

	protected async shouldUnderstand(thresholds: {
		maxObservations: number
		maxTokens: number
	}): Promise<boolean> {
		const { count, totalTokens } = await this.getBufferState()
		return (
			count >= thresholds.maxObservations || totalTokens >= thresholds.maxTokens
		)
	}

	// ── Query (concrete — delegates to queryMethod) ────────────────────────

	async query(question: string, options?: QueryOptions): Promise<QueryResult> {
		await this.ensureInit()
		this.state.health.lastAccessed = new Date()
		this.state.metrics.query.count++

		this.emit('neuron:query:started', {
			neuronId: this.id,
			query: question,
		})

		// Short-circuit if neuron has no knowledge at all
		const bufferState = await this.getBufferState()
		if (!(await this.hasKnowledge()) && bufferState.count === 0) {
			const emptyResult: QueryResult = {
				relevant: false,
				relevance: 0,
				confidence: 0,
				insight: '',
				gaps: '',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			}
			this.emit('neuron:query:completed', {
				neuronId: this.id,
				insight: '',
				relevant: false,
				relevance: 0,
				confidence: 0,
				gaps: [],
				usage: emptyResult.usage,
			})
			return emptyResult
		}

		try {
			const queryOptions = {
				...this.llmRepairOptions,
				...options,
			}
			const method =
				queryOptions.mode === 'direct' && this.directQueryMethod
					? this.directQueryMethod
					: this.queryMethod
			const result = await method.query(
				{
					neuronId: this.id,
					instructions: this.state.instructions,
					question,
				},
				queryOptions,
				{
					onThinking: (thoughts, usage) => {
						this.emit('neuron:query:thinking', {
							neuronId: this.id,
							thoughts,
							usage,
						})
					},
				} satisfies QueryCallbacks,
			)

			this.trackQueryMetrics(result)

			this.emit('neuron:query:completed', {
				neuronId: this.id,
				insight: result.insight,
				relevant: result.relevant,
				relevance: result.relevance,
				confidence: result.confidence,
				gaps: result.gaps ? result.gaps.split('\n').filter(Boolean) : [],
				usage: result.usage,
			})

			this.checkAndEmitSignals()

			return result
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit('neuron:query:failed', {
				neuronId: this.id,
				error: error.message,
			})
			throw error
		}
	}

	// ── Query Stream (returns raw ai-sdk StreamTextResult) ───────────────

	async queryStream(
		question: string,
		options?: QueryOptions,
	): Promise<AdaptStreamResult> {
		await this.ensureInit()
		this.state.health.lastAccessed = new Date()
		this.state.metrics.query.count++

		this.emit('neuron:query:started', {
			neuronId: this.id,
			query: question,
		})

		const method =
			(options?.mode ?? undefined) === 'direct' && this.directQueryMethod
				? this.directQueryMethod
				: this.queryMethod

		if (!method.queryStream) {
			throw new Error(
				`Query method "${method.name}" does not support streaming`,
			)
		}

		return method.queryStream(
			{
				neuronId: this.id,
				instructions: this.state.instructions,
				question,
			},
			{
				...this.llmRepairOptions,
				...options,
			},
		)
	}

	// ── Update ──────────────────────────────────────────────────────────────

	async update(
		updates: BaseNeuronUpdateInput & Record<string, unknown>,
	): Promise<{ changedFields: string[] }> {
		const changedFields: string[] = []
		let needsObserveRegen = false
		let needsUnderstandRegen = false
		let needsSchemaRegen = false
		const stateUpdates: Partial<TState> = {} as Partial<TState>

		if (updates.id !== undefined && updates.id !== this.id) {
			throw new Error(
				'Cannot update immutable field "id". Neuron identity cannot be changed.',
			)
		}

		// ── Metadata (passive) ──

		if (updates.name !== undefined && updates.name !== this.state.name) {
			;(stateUpdates as Record<string, unknown>).name = updates.name
			changedFields.push('name')
		}

		if (
			updates.description !== undefined &&
			updates.description !== this.state.description
		) {
			;(stateUpdates as Record<string, unknown>).description =
				updates.description
			changedFields.push('description')
		}

		if (updates.origin !== undefined && updates.origin !== this.state.origin) {
			;(stateUpdates as Record<string, unknown>).origin = updates.origin
			changedFields.push('origin')
		}

		// ── Models (reactive) ──

		if (
			updates.model !== undefined ||
			updates.blueprintModel !== undefined ||
			updates.observer?.model !== undefined ||
			updates.observer?.blueprintModel !== undefined ||
			updates.understand?.model !== undefined ||
			updates.understand?.blueprintModel !== undefined ||
			updates.query?.model !== undefined
		) {
			const newModels = { ...this.state.models }
			if (updates.model !== undefined) {
				newModels.default = updates.model
				changedFields.push('model')
			}
			if (updates.blueprintModel !== undefined) {
				newModels.blueprint = updates.blueprintModel
				changedFields.push('blueprintModel')
			}
			if (updates.observer?.model !== undefined) {
				newModels.observer = updates.observer.model
				changedFields.push('observer.model')
			}
			if (updates.observer?.blueprintModel !== undefined) {
				newModels.observer_blueprint = updates.observer.blueprintModel
				changedFields.push('observer.blueprintModel')
				needsObserveRegen = true
			}
			if (updates.understand?.model !== undefined) {
				newModels.understand = updates.understand.model
				changedFields.push('understand.model')
			}
			if (updates.understand?.blueprintModel !== undefined) {
				newModels.understand_blueprint = updates.understand.blueprintModel
				changedFields.push('understand.blueprintModel')
				needsUnderstandRegen = true
			}
			if (updates.query?.model !== undefined) {
				newModels.query = updates.query.model
				changedFields.push('query.model')
				this.queryMethod.update({ model: updates.query.model })
				this.directQueryMethod?.update({ model: updates.query.model })
			}

			;(stateUpdates as Record<string, unknown>).models = newModels
		}

		// ── Instructions (reactive) ──

		if (
			updates.instructions !== undefined &&
			updates.instructions !== this.state.instructions
		) {
			;(stateUpdates as Record<string, unknown>).instructions =
				updates.instructions
			changedFields.push('instructions')
			needsObserveRegen = true
			needsUnderstandRegen = true
			needsSchemaRegen = true
		}

		if (
			updates.observeInstructions !== undefined &&
			updates.observeInstructions !== this.state.observeInstructions
		) {
			;(stateUpdates as Record<string, unknown>).observeInstructions =
				updates.observeInstructions
			changedFields.push('observeInstructions')
			needsObserveRegen = true
			needsSchemaRegen = true
		}

		if (
			updates.understandInstructions !== undefined &&
			updates.understandInstructions !== this.state.understandInstructions
		) {
			;(stateUpdates as Record<string, unknown>).understandInstructions =
				updates.understandInstructions
			changedFields.push('understandInstructions')
			needsUnderstandRegen = true
			needsSchemaRegen = true
		}

		// ── Focus (reactive) ──

		if (updates.focus !== undefined && updates.focus !== this.state.focus) {
			;(stateUpdates as Record<string, unknown>).focus = updates.focus
			changedFields.push('focus')
			needsObserveRegen = true
			needsSchemaRegen = true
		}

		// ── Thresholds ──

		if (updates.understand?.thresholds) {
			const newThresholds = {
				...this.state.thresholds,
				...updates.understand.thresholds,
			}
			;(stateUpdates as Record<string, unknown>).thresholds = newThresholds
			changedFields.push('understand.thresholds')
		}

		// ── Health config (passive, nested) ──

		if (updates.health) {
			const newHealth = { ...this.state.health }
			if (updates.health.threshold !== undefined) {
				newHealth.threshold = updates.health.threshold
				changedFields.push('health.threshold')
			}
			if (updates.health.signalThresholds) {
				const st = updates.health.signalThresholds
				newHealth.signalThresholds = { ...newHealth.signalThresholds }
				if (st.maxDismissalRate !== undefined) {
					newHealth.signalThresholds.maxDismissalRate = st.maxDismissalRate
					changedFields.push('health.signalThresholds.maxDismissalRate')
				}
				if (st.minConfidence !== undefined) {
					newHealth.signalThresholds.minConfidence = st.minConfidence
					changedFields.push('health.signalThresholds.minConfidence')
				}
				if (st.maxObservationsWithoutSynthesis !== undefined) {
					newHealth.signalThresholds.maxObservationsWithoutSynthesis =
						st.maxObservationsWithoutSynthesis
					changedFields.push(
						'health.signalThresholds.maxObservationsWithoutSynthesis',
					)
				}
			}
			;(stateUpdates as Record<string, unknown>).health = newHealth
		}

		if (
			updates.skipUnderstand !== undefined &&
			updates.skipUnderstand !== this.state.skipUnderstand
		) {
			;(stateUpdates as Record<string, unknown>).skipUnderstand =
				updates.skipUnderstand
			if (updates.skipUnderstand) {
				;(stateUpdates as Record<string, unknown>).understand_prompt = null
			}
			changedFields.push('skipUnderstand')
			if (!updates.skipUnderstand) needsUnderstandRegen = true
		}

		// ── Type-specific updates (subclass implements) ──

		const typeSpecificUpdates = this.applyTypeSpecificUpdates(
			updates,
			changedFields,
		)
		Object.assign(stateUpdates, typeSpecificUpdates)

		// ── Force regen if prompts don't exist yet (first init) ──
		// Skip-observation neurons intentionally leave observe_prompt null.

		if (!this.state.skipObservation && this.state.observe_prompt === null)
			needsObserveRegen = true
		if (!this.state.skipUnderstand && this.state.understand_prompt === null) {
			needsUnderstandRegen = true
		}
		if (this.state.observation_schema === null) needsSchemaRegen = true

		// ── Regenerate prompts ──

		// Apply state updates collected so far (so regen uses fresh instructions/focus)
		if (Object.keys(stateUpdates).length > 0) {
			await this.setState(stateUpdates)
		}

		// Skip-observation neurons never run the observe phase; never regen its prompt.
		if (this.state.skipObservation) needsObserveRegen = false
		if (this.state.skipUnderstand) needsUnderstandRegen = false

		if (needsObserveRegen || needsUnderstandRegen || needsSchemaRegen) {
			const promises: Promise<void>[] = []
			const regenUpdates: Partial<TState> = {} as Partial<TState>

			if (needsObserveRegen) {
				const result = initObserve(resolveObserveInstructions(this.state))
				;(regenUpdates as Record<string, unknown>).observe_prompt =
					result.systemPrompt
			}

			if (needsUnderstandRegen) {
				promises.push(
					this.regenUnderstandPrompt(
						this.state.models.understand_blueprint,
						resolveUnderstandInstructions(this.state),
					),
				)
			}

			await Promise.all(promises)

			// Regenerate schemas if instructions changed
			if (needsSchemaRegen) {
				const schemas = await this.generateSchemas(
					this.state.models.blueprint,
					this.schemaInstructions(),
				)
				;(regenUpdates as Record<string, unknown>).observation_schema =
					schemas.observationSchema
				;(regenUpdates as Record<string, unknown>).understanding_schema =
					schemas.understandingSchema
			}

			// Persist regenerated state
			if (Object.keys(regenUpdates).length > 0) {
				await this.setState(regenUpdates)
			}

			this.emit('neuron:prompts:regenerated', {
				neuronId: this.id,
				observePrompt: this.state.observe_prompt!,
				understandPrompt: this.state.understand_prompt ?? '',
			})
		}

		if (changedFields.length > 0) {
			this.emit('neuron:config:updated', {
				neuronId: this.id,
				changedFields,
				config: { ...this.state },
			})
		}

		return { changedFields }
	}

	// ── Adjust ──────────────────────────────────────────────────────────────

	/**
	 * Adjust neuron behavior from a natural language directive.
	 *
	 * Unlike update() (which replaces instructions and regenerates from scratch),
	 * adjust() shows the LLM the current state so it can evolve incrementally.
	 * The directive is natural language: "also track X", "stop tracking Y", "be stricter", etc.
	 *
	 * Does NOT touch persisted data (observations, understandings, evolution records).
	 */
	async adjust(directive: string): Promise<AdjustResult> {
		await this.ensureInit()

		// 1. Classify what the directive touches
		const { output: classification } = await generate({
			llm: this.llm,
			model: this.state.models.blueprint,
			prompt: `You sense what a directive is asking to change about a learning node.

Root question: Does this directive reshape how the node perceives and processes, what the node currently knows, or both?

The node's purpose: "${this.state.instructions}"
The directive: "${directive}"

- adjustConfig → the directive changes perception, focus, criteria, or processing behavior
- adjustUnderstanding → the directive changes, corrects, or removes something in the node's accumulated knowledge
- Both can be true

What does this directive touch?`,
			output: Output.object({ schema: adjustClassificationSchema }),
			repairSchema: adjustClassificationSchema,
			...this.llmRepairOptions,
		})

		const changedFields: string[] = []
		let adjustedConfig = false
		let adjustedUnderstanding = false

		// 2. Config adjustment (existing logic)
		if (classification.adjustConfig) {
			const { output } = await generate({
				llm: this.llm,
				model: this.state.models.blueprint,
				prompt: `You update a neuron's raw developer instruction fields from a directive.

Preserve existing text unless the directive clearly changes it. Do not summarize, invent identity text, or convert instructions into a role description.

Current shared instructions:
"${this.state.instructions}"

Current observe-only instructions:
${this.state.observeInstructions === null ? 'null' : `"${this.state.observeInstructions}"`}

Current understand-only instructions:
${this.state.understandInstructions === null ? 'null' : `"${this.state.understandInstructions}"`}

Current observe focus:
${this.state.focus === null ? 'null' : `"${this.state.focus}"`}

Directive:
"${directive}"

Return the updated raw fields. Use null for a phase-specific field when it should inherit the shared instructions.`,
				output: Output.object({ schema: adjustConfigSchema }),
				repairSchema: adjustConfigSchema,
				...this.llmRepairOptions,
			})

			await this.setState({
				instructions: output.instructions,
				observeInstructions: output.observeInstructions,
				understandInstructions: output.understandInstructions,
				focus: output.focus,
			} as Partial<TState>)

			if (!this.state.skipObservation) {
				const observeResult = initObserve(
					resolveObserveInstructions(this.state),
				)
				await this.setState({
					observe_prompt: observeResult.systemPrompt,
				} as Partial<TState>)
			}

			if (!this.state.skipUnderstand) {
				await this.adjustUnderstandPrompt(
					this.state.models.understand_blueprint,
					directive,
					resolveUnderstandInstructions(this.state),
				)
			}

			const schemas = await this.generateSchemas(
				this.state.models.blueprint,
				this.schemaInstructions(),
			)
			await this.setState({
				observation_schema: schemas.observationSchema,
				understanding_schema: schemas.understandingSchema,
			} as Partial<TState>)

			changedFields.push(
				'instructions',
				'observeInstructions',
				'understandInstructions',
				'focus',
				'observe_prompt',
				'observation_schema',
				'understanding_schema',
			)
			if (!this.state.skipUnderstand) changedFields.push('understand_prompt')
			adjustedConfig = true

			this.emit('neuron:prompts:regenerated', {
				neuronId: this.id,
				observePrompt: this.state.observe_prompt!,
				understandPrompt: this.state.understand_prompt ?? '',
			})

			this.emit('neuron:config:updated', {
				neuronId: this.id,
				changedFields,
				config: { ...this.state },
			})
		}

		// 3. Understanding adjustment (new)
		if (classification.adjustUnderstanding) {
			const result = await this.adjustUnderstanding(
				this.state.models.understand,
				directive,
			)
			adjustedUnderstanding = true

			this.emit('neuron:understanding:adjusted', {
				neuronId: this.id,
				directive,
				evolution: result.evolution,
				significance: result.significance,
			})
		}

		return { changedFields, adjustedConfig, adjustedUnderstanding }
	}

	// ── Accessors ───────────────────────────────────────────────────────────

	async getEvolution(): Promise<EvolutionRecord[]> {
		return this.store.evolution.list()
	}

	getHealth(): NeuronHealth {
		return { ...this.state.health }
	}

	getMetrics(): NeuronMetrics {
		return {
			ingestion: { ...this.state.metrics.ingestion },
			query: {
				...this.state.metrics.query,
				relevanceScores: [...this.state.metrics.query.relevanceScores],
				confidenceScores: [...this.state.metrics.query.confidenceScores],
				gaps: [...this.state.metrics.query.gaps],
			},
		}
	}

	getMetadata(): NeuronMetadata {
		return {
			id: this.id,
			instructions: this.state.instructions,
			origin: this.state.origin,
			health: this.getHealth(),
		}
	}

	/**
	 * Dispose of the neuron and its store
	 */
	async dispose(): Promise<void> {
		await this.store.dispose()
	}

	// ── Shared bookkeeping ──────────────────────────────────────────────────

	protected async handleLearnResult(
		result: LearnOutput,
		bufferState?: { count: number; avgImportance: number },
	): Promise<void> {
		switch (result.status) {
			case 'observed': {
				this.trackIngestion()
				this.emit('neuron:observed', {
					neuronId: this.id,
					output: result.output,
					importance: bufferState?.avgImportance ?? 0,
					bufferCount: bufferState?.count ?? 0,
					usage: result.usage,
				})
				this.checkAndEmitSignals()
				break
			}

			case 'observe:dismissed':
				this.trackIngestion(true)
				this.emit('neuron:observe:dismissed', {
					neuronId: this.id,
					output: result.output,
					gaps: result.gaps,
					usage: result.usage,
				})
				this.checkAndEmitSignals()
				break

			case 'observe:error':
				this.emit('neuron:observe:error', {
					neuronId: this.id,
					error: result.error,
				})
				break

			case 'synthesized': {
				this.trackIngestion()
				this.state.metrics.ingestion.synthesisCount++
				this.state.metrics.ingestion.observationsSinceLastSynthesis = 0
				this.state.stagnation_signal_fired = false

				const previousUnderstanding = await this.getUnderstanding()
				await this.setUnderstanding(result.newUnderstanding as TUnderstanding)

				// Store evolution entry
				await this.store.evolution.add({
					id: `evo_${nanoid()}`,
					summary: result.evolution,
					significance: result.significance,
					reasoning: result.reasoning,
					created_at: new Date().toISOString(),
				})

				this.emit('neuron:synthesized', {
					neuronId: this.id,
					newUnderstanding: result.newUnderstanding,
					previousUnderstanding,
					significance: result.significance,
					evolution: result.evolution,
					usage: result.usage,
				})

				this.updateGovernance(1.0)
				this.checkAndEmitSignals()
				break
			}

			case 'synthesize:dismissed':
				this.trackIngestion()
				this.emit('neuron:synthesize:dismissed', {
					neuronId: this.id,
					output: result.output,
					usage: result.usage,
				})
				this.checkAndEmitSignals()
				break

			case 'synthesize:error':
				this.trackIngestion()
				this.emit('neuron:synthesize:error', {
					neuronId: this.id,
					error: result.error,
				})
				this.checkAndEmitSignals()
				break
		}
	}

	protected trackIngestion(dismissed = false): void {
		this.state.metrics.ingestion.observationCount++
		this.state.metrics.ingestion.observationsSinceLastSynthesis++
		if (dismissed) {
			this.state.metrics.ingestion.dismissalCount++
		}
		this.state.metrics.ingestion.dismissalRate =
			this.state.metrics.ingestion.observationCount > 0
				? this.state.metrics.ingestion.dismissalCount /
					this.state.metrics.ingestion.observationCount
				: 0
	}

	protected trackQueryMetrics(result: {
		relevance: number
		confidence: number
		gaps: string
	}): void {
		const WINDOW_SIZE = 10
		const MAX_GAPS = 50

		this.state.metrics.query.relevanceScores.push(result.relevance)
		if (this.state.metrics.query.relevanceScores.length > WINDOW_SIZE) {
			this.state.metrics.query.relevanceScores.shift()
		}

		this.state.metrics.query.confidenceScores.push(result.confidence)
		if (this.state.metrics.query.confidenceScores.length > WINDOW_SIZE) {
			this.state.metrics.query.confidenceScores.shift()
		}

		if (result.gaps) {
			const gaps = result.gaps.split('\n').filter(Boolean)
			this.state.metrics.query.gaps.push(...gaps)
			if (this.state.metrics.query.gaps.length > MAX_GAPS) {
				this.state.metrics.query.gaps = this.state.metrics.query.gaps.slice(
					-MAX_GAPS,
				)
			}
		}
	}

	protected updateGovernance(relevance: number): void {
		const previousStatus = this.state.health.status

		this.state.health.activation =
			this.state.health.activation * 0.8 + relevance * 0.2

		if (this.state.health.activation >= this.state.health.threshold) {
			this.state.health.status = 'active'
		}

		this.state.health.lastAccessed = new Date()

		this.emit('neuron:health:updated', {
			neuronId: this.id,
			activation: this.state.health.activation,
			status: this.state.health.status,
			previousStatus:
				previousStatus !== this.state.health.status
					? previousStatus
					: undefined,
		})
	}

	protected checkAndEmitSignals(): void {
		const { signalThresholds } = this.state.health
		const { ingestion, query } = this.state.metrics

		if (ingestion.observationCount > 10) {
			if (ingestion.dismissalRate > signalThresholds.maxDismissalRate) {
				if (!this.state.dismissal_signal_fired) {
					this.state.dismissal_signal_fired = true
					this.emit('neuron:signal', {
						neuronId: this.id,
						description: `High dismissal rate: rejecting ${(ingestion.dismissalRate * 100).toFixed(0)}% of observations`,
						timestamp: new Date(),
						metrics: { dismissalRate: ingestion.dismissalRate },
					})
				}
			} else {
				this.state.dismissal_signal_fired = false
			}
		}

		if (query.relevanceScores.length >= 5) {
			const avgRelevance =
				query.relevanceScores.reduce((a, b) => a + b, 0) /
				query.relevanceScores.length
			if (avgRelevance < signalThresholds.minRelevance) {
				this.emit('neuron:signal', {
					neuronId: this.id,
					description: `Low relevance: avg ${avgRelevance.toFixed(2)} over last ${query.relevanceScores.length} queries`,
					timestamp: new Date(),
					metrics: { avgRelevance },
				})
				this.state.metrics.query.relevanceScores = []
			}
		}

		if (query.confidenceScores.length >= 5) {
			const avgConfidence =
				query.confidenceScores.reduce((a, b) => a + b, 0) /
				query.confidenceScores.length
			if (avgConfidence < signalThresholds.minConfidence) {
				this.emit('neuron:signal', {
					neuronId: this.id,
					description: `Low confidence: avg ${avgConfidence.toFixed(2)} over last ${query.confidenceScores.length} queries — has knowledge gaps in its domain`,
					timestamp: new Date(),
					metrics: { avgConfidence },
				})
				this.state.metrics.query.confidenceScores = []
			}
		}

		if (
			!this.state.skipUnderstand &&
			!this.state.stagnation_signal_fired &&
			ingestion.observationsSinceLastSynthesis >
				signalThresholds.maxObservationsWithoutSynthesis
		) {
			this.state.stagnation_signal_fired = true
			this.emit('neuron:signal', {
				neuronId: this.id,
				description: `Stagnation: no synthesis in ${ingestion.observationsSinceLastSynthesis} observations`,
				timestamp: new Date(),
			})
		}
	}
}
