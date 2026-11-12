/**
 * BaseNeuron — abstract base class for all neuron types
 *
 * Owns state persistence, query dispatch, health/metrics bookkeeping and
 * events. Subclasses own learning (learn, update, adjust) and understanding.
 * Store is injected — neuron has no knowledge of storage backend.
 *
 * All serializable config and runtime data lives in `this.state`,
 * cached in memory and backed by `store.state`.
 * Understanding is NOT cached — it lives in `store.understanding`.
 */

import { nanoid } from 'nanoid'
import type { TextInput } from '../../learning/text-state'
import type {
	AdaptLLMPlugin,
	AdaptRepairOptions,
	AdaptStreamResult,
	LanguageModel,
} from '../../llm'
import type { EvolutionRecord, NeuronStore } from '../../stores'
import { TypedEmitter } from '../../types/events'
import type {
	QueryCallbacks,
	QueryMethod,
	QueryOptions,
	QueryResult,
} from '../base/query'
import type {
	Neuron,
	NeuronHealth,
	NeuronMetadata,
	NeuronMetrics,
	NeuronOrigin,
	Significance,
} from '../types'
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

/** What a neuron learns from: plain text, or a TextInput with caller-owned ids and times. */
export type LearnInput = string | TextInput

/**
 * Options for learn() call
 */
export interface LearnOptions {
	/** Ignored. Learning is always the two-step extract/update flow. */
	forceSynthesize?: boolean
}

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
	private initPromise: Promise<void> | null = null

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

	/** Pending-input metrics for health/evolution; owned by the subclass. */
	abstract getBufferState(): Promise<{
		count: number
		avgImportance: number
		totalTokens: number
	}>
	/** Learn from a batch: plain text, or TextInput when the caller controls ids and times. */
	abstract learn(
		batch: readonly LearnInput[],
		options?: LearnOptions,
	): Promise<LearnOutput>
	abstract update(
		updates: BaseNeuronUpdateInput & Record<string, unknown>,
	): Promise<{ changedFields: string[] }>
	abstract adjust(directive: string): Promise<AdjustResult>

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
			if (record.id === 'understand_identity') continue
			const transform = this.stateTransforms[record.id]
			;(this.state as Record<string, unknown>)[record.id] = transform
				? transform.deserialize(record.value)
				: record.value
		}
		return true
	}

	// ── Init ────────────────────────────────────────────────────────────────

	async init(opts?: { expect?: 'fresh' | 'restore' }): Promise<void> {
		if (this.isInitialized()) return

		this.emit('neuron:init:started', { neuronId: this.id })

		try {
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

			// Persist the entire state — every field that lives in BaseNeuronState
			// is data and must round-trip through the store.
			if (!restored) await this.setState({ ...this.state } as Partial<TState>)

			this.queryMethod = this.createQueryMethod()
			this.directQueryMethod = this.createDirectQueryMethod()
			this.initialized = true

			this.emit('neuron:init:completed', {
				neuronId: this.id,
				systemPrompt: '',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			})
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.emit('neuron:init:failed', {
				neuronId: this.id,
				error: error.message,
			})
			throw error
		}
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
		return this.initialized
	}

	private async ensureInit(): Promise<void> {
		if (this.isInitialized()) return
		if (!this.initPromise) {
			this.initPromise = this.init()
		}
		await this.initPromise
	}

	getUnderstandThresholds() {
		return { ...this.state.thresholds }
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

	/**
	 * Apply the non-learning settings: metadata, model slots, thresholds and
	 * health config. Persists them and returns the changed field names.
	 * Learning-lens fields (instructions, focus) are the subclass's concern.
	 */
	protected async updateSettings(
		updates: BaseNeuronUpdateInput & Record<string, unknown>,
	): Promise<string[]> {
		const changedFields: string[] = []
		const stateUpdates: Record<string, unknown> = {}

		if (updates.id !== undefined && updates.id !== this.id) {
			throw new Error(
				'Cannot update immutable field "id". Neuron identity cannot be changed.',
			)
		}

		if (updates.name !== undefined && updates.name !== this.state.name) {
			stateUpdates.name = updates.name
			changedFields.push('name')
		}
		if (
			updates.description !== undefined &&
			updates.description !== this.state.description
		) {
			stateUpdates.description = updates.description
			changedFields.push('description')
		}
		if (updates.origin !== undefined && updates.origin !== this.state.origin) {
			stateUpdates.origin = updates.origin
			changedFields.push('origin')
		}

		const newModels = { ...this.state.models }
		const modelUpdates: Array<[string, keyof typeof newModels, unknown]> = [
			['model', 'default', updates.model],
			['blueprintModel', 'blueprint', updates.blueprintModel],
			['observer.model', 'observer', updates.observer?.model],
			[
				'observer.blueprintModel',
				'observer_blueprint',
				updates.observer?.blueprintModel,
			],
			['understand.model', 'understand', updates.understand?.model],
			[
				'understand.blueprintModel',
				'understand_blueprint',
				updates.understand?.blueprintModel,
			],
			['query.model', 'query', updates.query?.model],
		]
		let modelsChanged = false
		for (const [field, slot, value] of modelUpdates) {
			if (value === undefined) continue
			newModels[slot] = value as LanguageModel
			changedFields.push(field)
			modelsChanged = true
		}
		if (modelsChanged) {
			stateUpdates.models = newModels
			if (updates.query?.model !== undefined) {
				this.queryMethod.update({ model: updates.query.model })
				this.directQueryMethod?.update({ model: updates.query.model })
			}
		}

		if (updates.understand?.thresholds) {
			stateUpdates.thresholds = {
				...this.state.thresholds,
				...updates.understand.thresholds,
			}
			changedFields.push('understand.thresholds')
		}

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
			stateUpdates.health = newHealth
		}

		if (Object.keys(stateUpdates).length > 0) {
			await this.setState(stateUpdates as Partial<TState>)
		}
		return changedFields
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
		/** Set when the new understanding was already committed; holds the one it replaced. */
		committedOver?: { previousUnderstanding: TUnderstanding },
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

				const previousUnderstanding =
					committedOver?.previousUnderstanding ??
					(await this.getUnderstanding())
				if (committedOver === undefined)
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
	}
}
