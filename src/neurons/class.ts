/**
 * Neuron — a learning agent that maintains understanding as plain text.
 *
 * Learns in two steps (extract, then update). Owns state persistence, query,
 * health/metrics bookkeeping and events. Store is injected — the neuron has
 * no knowledge of the storage backend.
 *
 * All serializable config and runtime data lives in `this.state`,
 * cached in memory and backed by `store.state`.
 * Understanding is NOT cached — it lives in `store.understanding`.
 */

import { isDeepStrictEqual } from 'node:util'
import { nanoid } from 'nanoid'

import type { TextLearningConfig } from '../learning/text-procedures'
import type { TextInput, TextProfileSnapshot } from '../learning/text-state'
import type {
	AdaptLLMPlugin,
	AdaptRepairOptions,
	AdaptStreamResult,
	LanguageModel,
} from '../llm'
import { resolveRuntimeLLM } from '../llm'
import type { EvolutionRecord, NeuronStore } from '../stores'
import type { ParentModels } from '../types/config'
import { TypedEmitter } from '../types/events'
import {
	type AdaptiveTextFlushOutput,
	type AdaptiveTextLearningConfig,
	type AdaptiveTextLearningRuntime,
	type AdaptiveTextLearningState,
	AdaptiveTextRuntime,
} from './adaptive-runtime'
import { resolveNeuronConfig } from './config.resolver'
import type { QueryOptions, QueryResult } from './query'
import { DirectMethod } from './query'
import type { NeuronState, StateTransform, StoredModelRef } from './state'
import { deserializeModelSlots, serializeModelSlots } from './state'
import {
	applyStrategy,
	DEFAULT_GOVERNANCE,
	type GovernanceConfig,
} from './strategies'
import {
	defaultTwoStepLearning,
	defaultTwoStepRuntime,
} from './two-step-defaults'
import type {
	AdjustResult,
	LearnInput,
	LearnOptions,
	LearnOutput,
	NeuronConfig,
	NeuronEventMap,
	NeuronHealth,
	NeuronMetadata,
	NeuronMetrics,
	NeuronOrigin,
} from './types'

const RESTORE_PLACEHOLDER_MODEL =
	'unknown:placeholder' as unknown as LanguageModel

export class Neuron extends TypedEmitter<NeuronEventMap> {
	readonly id: string
	private readonly store: NeuronStore
	private readonly state: NeuronState
	private queryMethod!: DirectMethod
	private initialized = false

	// Lazy init promise (for ensureInit)
	private initPromise: Promise<void> | null = null

	/**
	 * Transform registry for store ↔ cache boundary.
	 * Keys not in the registry pass through as-is (identity transform).
	 */
	private readonly stateTransforms: Record<string, StateTransform>

	/**
	 * The LLM plugin this neuron uses for runtime LLM calls. Each instance
	 * holds its own plugin — there is no global registry. Set at construction.
	 */
	private readonly llm: AdaptLLMPlugin
	private readonly repairWithFeedback?: AdaptRepairOptions['repairWithFeedback']
	private readonly maxRepairAttempts?: number

	readonly #adaptive: AdaptiveTextRuntime
	readonly #adaptiveConfig: AdaptiveTextLearningConfig
	/** In-flight learn() calls; dispose waits for them before closing the store. */
	readonly #learning = new Set<Promise<unknown>>()
	/** True when the two-step setup was built from plain options, not supplied. */
	readonly #defaultLearning: boolean

	constructor(
		rawConfig: NeuronConfig & { llm?: AdaptLLMPlugin },
		parentModels?: ParentModels,
	) {
		super()
		const suppliedLearning = rawConfig.learning
		const preparedConfig =
			suppliedLearning === undefined
				? rawConfig
				: prepareAdaptiveConfig(rawConfig, suppliedLearning)
		const config = resolveNeuronConfig(preparedConfig, parentModels)
		const llm = resolveRuntimeLLM({
			llm: rawConfig.llm,
			models: [config.model, config.blueprintModel, config.query.model],
		})
		const learning =
			suppliedLearning ??
			defaultTwoStepLearning({
				neuronId: config.id,
				instructions: config.instructions,
				developerInstructions: [],
				llm,
				model: config.model,
			})

		this.id = config.id
		this.llm = llm
		this.repairWithFeedback = rawConfig.repairWithFeedback
		this.maxRepairAttempts = rawConfig.maxRepairAttempts
		this.store = rawConfig.store
		this.state = {
			instructions: config.instructions,
			name: rawConfig.name || config.id,
			description: rawConfig.description ?? '',
			origin: config.origin,
			models: {
				default: config.model,
				blueprint: config.blueprintModel,
				query: config.query.model,
			},
			thresholds: {
				maxObservations: config.understand.thresholds.maxObservations,
				maxTokens: config.understand.thresholds.maxTokens,
				minImportance: config.understand.thresholds.minImportance,
			},
			health: {
				activation: 0,
				threshold: 0.3,
				status: 'dormant',
				lastAccessed: new Date(),
				signalThresholds: {
					maxDismissalRate: 0.8,
					minRelevance: 0.3,
					minConfidence: 0.3,
					maxObservationsWithoutSynthesis:
						3 * config.understand.thresholds.maxObservations,
					...rawConfig.health?.signalThresholds,
				},
			},
			metrics: {
				ingestion: {
					observationCount: 0,
					dismissalCount: 0,
					dismissalRate: 0,
					synthesisCount: 0,
					observationsSinceLastSynthesis: 0,
				},
				query: {
					count: 0,
					relevanceScores: [],
					confidenceScores: [],
					gaps: [],
				},
			},
			dismissal_signal_fired: false,
			governance: {
				...DEFAULT_GOVERNANCE,
				...definedOnly(rawConfig.governance),
			},
		}
		this.stateTransforms = {
			models: {
				serialize: (v) =>
					serializeModelSlots(v as NeuronState['models'], this.llm),
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

		this.#defaultLearning = suppliedLearning === undefined
		this.#adaptiveConfig = learning
		this.#adaptive = new AdaptiveTextRuntime(
			rawConfig.store,
			learning.runtime,
			(memory, { maxCharacters, maxOutputTokens, topic, rules, signal }) =>
				applyStrategy({
					memory,
					topic,
					rules,
					governance: this.state.governance,
					maxCharacters,
					maxOutputTokens,
					llm: this.llm,
					model: this.state.models.default,
					abortSignal: signal,
					...this.llmRepairOptions,
				}),
		)
	}

	private get llmRepairOptions(): AdaptRepairOptions {
		return {
			...(this.repairWithFeedback
				? { repairWithFeedback: this.repairWithFeedback }
				: {}),
			...(this.maxRepairAttempts !== undefined
				? { maxRepairAttempts: this.maxRepairAttempts }
				: {}),
		}
	}

	// ── State persistence ────────────────────────────────────────────────────

	/**
	 * Update cache + persist changed keys to store.state.
	 * Each top-level key in updates → one row in store.state.
	 */
	private async setState(updates: Partial<NeuronState>): Promise<void> {
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
	private async loadState(): Promise<boolean> {
		const records = await this.store.state.list()
		if (records.length === 0) return false
		for (const record of records) {
			if (record.id === 'observe_identity') continue
			if (record.id === 'understand_identity') continue
			const transform = this.stateTransforms[record.id]
			Object.assign(this.state, {
				[record.id]: transform
					? transform.deserialize(record.value)
					: record.value,
			})
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

			// Persist the entire state — every field in NeuronState is data and
			// must round-trip through the store.
			if (!restored) await this.setState({ ...this.state })

			const saved = this.#defaultLearning
				? await readDurableAdaptiveProfile(
						this.store,
						this.#adaptiveConfig.runtime,
					)
				: undefined
			await this.#adaptive.initialize(
				saved ?? this.#adaptiveConfig.initialProfile,
			)

			this.queryMethod = this.createQueryMethod()
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

	get name(): string {
		return this.state.name
	}

	get description(): string {
		return this.state.description
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

	// ── Understanding ─────────────────────────────────────────────────────────

	async getUnderstanding(): Promise<string> {
		const record = await this.store.understanding.get('current')
		return record ? (record.data as string) : ''
	}

	async setUnderstanding(understanding: string): Promise<void> {
		const state = await this.#adaptive.snapshot()
		if (
			state.memoryRevision > 0 ||
			(await this.store.understanding.get('current')) !== undefined
		) {
			throw new Error(
				'adaptive text understanding is changed only by the learning coordinator; a starting memory can be set only on an empty neuron',
			)
		}
		await this.store.understanding.add({
			id: 'current',
			data: understanding,
			metadata_confidence: 1.0,
			metadata_created_at: new Date().toISOString(),
			metadata_updated_at: new Date().toISOString(),
		})

		this.emit('neuron:understanding:set', {
			neuronId: this.id,
			understanding,
		})
	}

	async getSummary(): Promise<string> {
		const understanding = await this.getUnderstanding()
		return understanding || '(no understanding yet)'
	}

	async hasKnowledge(): Promise<boolean> {
		const record = await this.store.understanding.get('current')
		return !!record?.data
	}

	// ── Query ───────────────────────────────────────────────────────────────

	private createQueryMethod(): DirectMethod {
		return new DirectMethod(this.llm, this.state.models.query, {
			getUnderstanding: () => this.getUnderstanding(),
			buildPrompt: (ctx, understanding) => {
				const state = this.#adaptive.queryStatus()
				const pendingCount = state?.pendingDeliveryIds.length ?? 0
				const capacity = state?.capacity ?? []
				return `You are a specialist. Your domain:\n"${ctx.instructions}"\n\n# Committed Understanding\n${understanding || '(empty — no committed knowledge yet)'}\n\n# Learning Status\nCommitted memory revision: ${state?.memoryRevision ?? 0}\nPending inputs: ${pendingCount}. Pending input contents are unavailable and must not be treated as learned.\nCapacity blocked: ${capacity.length > 0 ? 'yes' : 'no'}${capacity.length > 0 ? ` (${capacity.map(({ reason }) => reason).join('; ')})` : ''}.\n\nAnswer only from the committed understanding. Be specific. If it is insufficient or newer input is pending, state the gap. Do not fabricate.`
			},
		})
	}

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
			const result = await this.queryMethod.query(
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

		return this.queryMethod.queryStream(
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

	// ── Accessors ───────────────────────────────────────────────────────────

	getQueryMethodName(): string {
		return 'direct'
	}

	getGovernance(): Required<GovernanceConfig> {
		return { ...this.state.governance }
	}

	/** Pending-input metrics for health/evolution. */
	async getBufferState(): Promise<{
		count: number
		avgImportance: number
		totalTokens: number
	}> {
		return {
			count: this.#adaptive.queryStatus()?.pendingDeliveryIds.length ?? 0,
			avgImportance: 0,
			totalTokens: 0,
		}
	}

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

	// ── Update ───────────────────────────────────────────────────────────────

	async update(
		updates: Partial<NeuronConfig>,
	): Promise<{ changedFields: string[] }> {
		if (updates.id !== undefined && updates.id !== this.id) {
			throw new Error(
				'Cannot update immutable field "id". Neuron identity cannot be changed.',
			)
		}
		const changedFields = [
			...(await this.#updateIdentity(updates)),
			...(await this.#updateGovernance(updates.governance)),
			...(await this.#updateSettings(updates)),
		]
		if (changedFields.length > 0) {
			this.emit('neuron:config:updated', {
				neuronId: this.id,
				changedFields,
				config: { ...this.state },
			})
		}
		return { changedFields }
	}

	/**
	 * `instructions` is the lens purpose. Directives added by `adjust` are
	 * kept. The new profile is activated first; the instructions are then
	 * written so restore sees a consistent pair.
	 */
	async #updateIdentity(updates: Partial<NeuronConfig>): Promise<string[]> {
		const instructions = updates.instructions
		if (instructions === undefined || instructions === this.state.instructions)
			return []
		if (instructions.trim().length === 0)
			throw new Error('adaptive text instructions must not be empty')
		await this.#activateAdaptive(
			(configuration): TextLearningConfig => ({
				...configuration,
				lens: { ...configuration.lens, purpose: instructions },
			}),
		)
		await this.setState({ instructions })
		return ['instructions']
	}

	async #updateGovernance(
		update: Partial<GovernanceConfig> | undefined,
	): Promise<string[]> {
		if (update === undefined) return []
		const current = this.state.governance
		const changed = (['strategy', 'maxTokens'] as const).filter(
			(key) => update[key] !== undefined && update[key] !== current[key],
		)
		if (changed.length === 0) return []
		await this.setState({
			governance: { ...current, ...definedOnly(update) },
		})
		return changed.map((key) => `governance.${key}`)
	}

	/**
	 * Apply the non-learning settings: metadata, model slots, thresholds and
	 * health config. Persists them and returns the changed field names.
	 */
	async #updateSettings(updates: Partial<NeuronConfig>): Promise<string[]> {
		const changedFields: string[] = []
		const stateUpdates: Partial<NeuronState> = {}

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
		const modelUpdates: Array<
			[string, keyof typeof newModels, LanguageModel | undefined]
		> = [
			['model', 'default', updates.model],
			['blueprintModel', 'blueprint', updates.blueprintModel],
			['query.model', 'query', updates.query?.model],
		]
		let modelsChanged = false
		for (const [field, slot, value] of modelUpdates) {
			if (value === undefined) continue
			newModels[slot] = value
			changedFields.push(field)
			modelsChanged = true
		}
		if (modelsChanged) {
			stateUpdates.models = newModels
			if (updates.query?.model !== undefined) {
				this.queryMethod.update({ model: updates.query.model })
			}
		}

		if (updates.understand?.thresholds) {
			stateUpdates.thresholds = {
				...this.state.thresholds,
				...definedOnly(updates.understand.thresholds),
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
			await this.setState(stateUpdates)
		}
		return changedFields
	}

	/**
	 * `adjust` appends the directive verbatim as a developer instruction and
	 * publishes a new profile. Learned memory is not edited: it changes only
	 * through learning.
	 */
	async adjust(directive: string): Promise<AdjustResult> {
		const text = directive.trim()
		if (text.length === 0) throw new Error('adjust directive must not be empty')
		await this.#activateAdaptive((configuration) => ({
			...configuration,
			lens: {
				...configuration.lens,
				developerInstructions: [
					...configuration.lens.developerInstructions,
					text,
				],
			},
		}))
		return {
			changedFields: ['lens.developerInstructions'],
			adjustedConfig: true,
			adjustedUnderstanding: false,
		}
	}

	async #activateAdaptive(
		change: (configuration: TextLearningConfig) => TextLearningConfig,
	): Promise<void> {
		const result = await this.#adaptive.updateConfiguration(change)
		if (result.status !== 'activated') {
			throw new Error(
				`adaptive text profile change was not activated: ${result.status}`,
			)
		}
	}

	// ── Learn ───────────────────────────────────────────────────────────────

	/** Learn from a batch: plain text, or TextInput when the caller controls ids and times. */
	async learn(
		batch: readonly LearnInput[],
		_options?: LearnOptions,
	): Promise<LearnOutput> {
		const run = this.#learn(batch)
		this.#learning.add(run)
		try {
			return await run
		} finally {
			this.#learning.delete(run)
		}
	}

	async #learn(batch: readonly LearnInput[]): Promise<LearnOutput> {
		const adaptiveConfig = this.#adaptiveConfig
		const inputs = batch.map((item) =>
			normalizeAdaptiveInput(item, adaptiveConfig.runtime),
		)
		const previousUnderstanding = await this.getUnderstanding()
		const learned = await this.#adaptive.learnNow(inputs)
		const understanding = await this.getUnderstanding()
		const notes = learned.notes ? { notes: learned.notes } : {}
		let result: LearnOutput
		if (learned.nothingRelevant) {
			result = { status: 'observe:dismissed', output: [...batch], gaps: [] }
		} else if (understanding !== previousUnderstanding) {
			result = {
				status: 'synthesized',
				newUnderstanding: understanding,
				significance: 'routine',
				evolution: `Learned from ${inputs.length} input${inputs.length === 1 ? '' : 's'}.`,
				...notes,
			}
		} else if (learned.runs?.some((run) => run.status === 'settled')) {
			result = {
				status: 'synthesize:dismissed',
				output: 'No changes needed',
				...notes,
			}
		} else {
			return learned
		}
		await this.handleLearnResult(result, previousUnderstanding)
		return result
	}

	async flush(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#adaptive.flush(signal)
	}

	async resume(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		return this.#adaptive.resume(signal)
	}

	async getLearningState(): Promise<AdaptiveTextLearningState> {
		return this.#adaptive.snapshot()
	}

	// ── Bookkeeping ─────────────────────────────────────────────────────────

	/** Record a learn outcome. The new understanding is already committed. */
	private async handleLearnResult(
		result: LearnOutput,
		previousUnderstanding: string,
	): Promise<void> {
		switch (result.status) {
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

			case 'synthesized': {
				this.trackIngestion()
				this.state.metrics.ingestion.synthesisCount++
				this.state.metrics.ingestion.observationsSinceLastSynthesis = 0

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

				this.updateHealth(1.0)
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
		}
	}

	private trackIngestion(dismissed = false): void {
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

	private trackQueryMetrics(result: {
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

	private updateHealth(relevance: number): void {
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

	private checkAndEmitSignals(): void {
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

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Construct a fresh Neuron and persist its config to the store.
	 * Throws if the store already contains a neuron — use {@link restore}.
	 */
	static async create(
		config: NeuronConfig & { llm?: AdaptLLMPlugin },
		parentModels?: ParentModels,
	): Promise<Neuron> {
		const neuron = new Neuron(config, parentModels)
		if (config.onEvent) neuron.on(config.onEvent)
		await neuron.init({ expect: 'fresh' })
		return neuron
	}

	/**
	 * Restore a previously-persisted Neuron from a store.
	 * `input` may be a path string (sugar for SQLiteNeuronStore) or a NeuronStore.
	 * Throws if the store is empty — use {@link create}.
	 *
	 * `runtime` supplies the LLM context the brain needs after restore.
	 *  - `model`: a live AI SDK model (e.g. `openai('gpt-4o')`); covers the common case.
	 *  - `llm`: a full plugin instance — for BYO custom runtimes.
	 *  Both optional. Pass nothing if the same process already cached the live
	 *  model from a prior `create` call (in-memory restore).
	 */
	static async restore(
		input: string | NeuronStore,
		runtime?: {
			id?: string
			model?: LanguageModel
			llm?: AdaptLLMPlugin
			repairWithFeedback?: NeuronConfig['repairWithFeedback']
			maxRepairAttempts?: number
			onEvent?: NeuronConfig['onEvent']
			learning?: {
				mode: 'adaptive'
				runtime: AdaptiveTextLearningRuntime
				expectedProfile?: TextProfileSnapshot<TextLearningConfig>
			}
		},
	): Promise<Neuron> {
		const store = await resolveNeuronStore(input)
		const durableProfile = await readDurableAdaptiveProfile(
			store,
			runtime?.learning?.runtime,
		)
		if (durableProfile !== undefined && runtime?.learning === undefined) {
			const savedModels = (await store.state.get('models'))?.value as
				| { default?: LanguageModel }
				| undefined
			const model = runtime?.model ?? savedModels?.default
			if (model === undefined)
				throw new Error('restoring a neuron requires a live model')
			const llm = resolveRuntimeLLM({ llm: runtime?.llm, models: [model] })
			runtime = {
				...runtime,
				model,
				learning: {
					mode: 'adaptive',
					runtime: defaultTwoStepRuntime(llm, model),
				},
			}
		}
		if (runtime?.learning !== undefined && durableProfile === undefined) {
			throw new Error('adaptive text profile is missing from the store')
		}
		if (
			runtime?.learning?.expectedProfile !== undefined &&
			(durableProfile === undefined ||
				!sameProfile(runtime.learning.expectedProfile, durableProfile))
		) {
			throw new Error(
				'durable adaptive text profile does not match the expected profile',
			)
		}
		if (runtime?.learning !== undefined && runtime.model === undefined) {
			throw new Error(
				'restoring adaptive text learning requires a live query model',
			)
		}
		const adaptiveState =
			durableProfile === undefined
				? undefined
				: await readAdaptiveIdentityState(store)
		const neuron = new Neuron({
			store,
			model: runtime?.model ?? RESTORE_PLACEHOLDER_MODEL,
			llm: runtime?.llm,
			repairWithFeedback: runtime?.repairWithFeedback,
			maxRepairAttempts: runtime?.maxRepairAttempts,
			instructions: adaptiveState?.instructions ?? '',
			id: durableProfile?.bindings.neuron.id ?? runtime?.id,
			...(durableProfile && runtime?.learning
				? {
						learning: {
							mode: 'adaptive' as const,
							initialProfile: durableProfile,
							runtime: runtime.learning.runtime,
						},
					}
				: {}),
		})
		if (runtime?.onEvent) neuron.on(runtime.onEvent)
		await neuron.init({ expect: 'restore' })
		if (durableProfile !== undefined) await neuron.resume()
		return neuron
	}

	/**
	 * Clear everything this neuron stored and stop it, so the id can be created
	 * again. The store stays open: its owner (the brain store) closes it.
	 * Waits for in-flight learning first.
	 */
	async erase(): Promise<void> {
		await Promise.allSettled([...this.#learning])
		const s = this.store
		for (const collection of [
			s.observations,
			s.understanding,
			s.evolution,
			s.state,
			s.learningHistory,
			s.memoryChanges,
			s.pendingWork,
			s.pendingInputs,
			s.processedInputs,
			s.outbox,
			s.learningAttempts,
			s.learningRevisions,
		])
			await collection.clear()
		await this.#adaptive.dispose()
	}

	/**
	 * Dispose of the neuron and its store. Waits for in-flight learning first.
	 */
	async dispose(): Promise<void> {
		await Promise.allSettled([...this.#learning])
		await this.#adaptive.dispose()
		await this.store.dispose()
	}
}

async function resolveNeuronStore(
	input: string | NeuronStore,
): Promise<NeuronStore> {
	if (typeof input !== 'string') return input
	const { SQLiteNeuronStore } = await import('../stores/sqlite/node/neuron')
	return new SQLiteNeuronStore(input)
}

function prepareAdaptiveConfig(
	raw: NeuronConfig & { llm?: AdaptLLMPlugin },
	learning: AdaptiveTextLearningConfig,
): NeuronConfig & { llm?: AdaptLLMPlugin } {
	const profile = learning.initialProfile
	const neuronId = raw.id ?? profile.bindings.neuron.id
	if (profile.bindings.neuron.id !== neuronId)
		throw new Error('adaptive profile neuron id does not match Neuron id')
	if (profile.configuration.lens.purpose !== raw.instructions)
		throw new Error('adaptive lens purpose must equal Neuron instructions')
	return {
		...raw,
		id: neuronId,
	}
}

function normalizeAdaptiveInput(
	item: LearnInput,
	runtime: AdaptiveTextLearningRuntime,
): TextInput {
	if (typeof item !== 'string') return item
	return {
		deliveryId: runtime.inputIds.next(),
		text: item,
		observedAt: runtime.clock.now(),
	}
}

async function readDurableAdaptiveProfile(
	store: NeuronStore,
	runtime?: AdaptiveTextLearningRuntime,
): Promise<TextProfileSnapshot<TextLearningConfig> | undefined> {
	const records =
		runtime === undefined
			? await store.state.list()
			: [await store.state.get(runtime.policy.headStateId)].filter(
					(value): value is NonNullable<typeof value> => value !== undefined,
				)
	for (const record of records) {
		if (typeof record.value !== 'object' || record.value === null) continue
		const value = record.value as {
			kind?: unknown
			record?: unknown
			profile?: unknown
		}
		if (
			value.record !== 'head' ||
			typeof value.profile !== 'object' ||
			value.profile === null
		)
			continue
		if (runtime !== undefined && value.kind !== runtime.policy.stateKind)
			continue
		const profile = value.profile as TextProfileSnapshot<TextLearningConfig>
		if (profile.configuration?.lens?.incomingTextRole === 'data-only')
			return profile
	}
	return undefined
}

async function readAdaptiveIdentityState(
	store: NeuronStore,
): Promise<{ instructions: string }> {
	const instructions = await store.state.get('instructions')
	if (typeof instructions?.value !== 'string')
		throw new Error('adaptive Neuron durable instructions are missing')
	return { instructions: instructions.value }
}

function sameProfile(
	left: TextProfileSnapshot<TextLearningConfig>,
	right: TextProfileSnapshot<TextLearningConfig>,
): boolean {
	return isDeepStrictEqual(left, right)
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
	return Object.fromEntries(
		Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
	) as Partial<T>
}
