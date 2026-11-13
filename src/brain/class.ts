import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { AdaptStreamResult } from '../llm'
import {
	type AdaptGenerateOptions,
	type AdaptLLMPlugin,
	type AdaptRepairOptions,
	generate,
	type LanguageModel,
	Output,
	resolveRuntimeLLM,
	stepCountIs,
	tool,
} from '../llm'
import {
	type AdjustResult,
	type GeneratedNeuronConfig,
	type LearnInput,
	Neuron,
	type TokenUsage,
} from '../neurons'
import type { BrainStore, NeuronStatus } from '../stores'
import { MemoryBrainStore } from '../stores'
import { TypedEmitter } from '../types/events'
import {
	type SpecialistDef,
	synthesize,
	synthesizeDirect,
	synthesizeDirectStream,
	synthesizeStream,
} from './agent'
import { BRAIN_DEFAULTS } from './config.defaults'
import {
	type EvolutionChange,
	type EvolutionResult,
	type EvolutionSignal,
	evolutionPrompt,
	evolutionSystemPrompt,
	evolutionTools,
	leftoverEntry,
	leftoverIsEmpty,
	leftoverPrompt,
	leftoverSystemPrompt,
	neuronConfigsSchema,
	setupPrompt,
} from './evolution'
import { type InspectResult, inspect as runInspect } from './inspect'
import {
	getInternalNeuronConfigs,
	INTERNAL_NEURON_IDS,
} from './internal-neurons'
import {
	decomposeBrainPromptTemplate,
	promptContextSchema,
} from './prompts/prompt.decompose-brain-prompt'
import {
	type BrainModelSlots,
	type BrainState,
	type BrainStateTransform,
	createInitialBrainState,
	deserializeBrainModelSlots,
	type StoredBrainModelRef,
	serializeBrainModelSlots,
} from './state'
import type {
	BrainAskResult,
	BrainConfig,
	BrainEventMap,
	BrainInjectOptions,
	BrainInjectResult,
	BrainRuntimeOptions,
	BrainUpdateResult,
	ConsultOptions,
	ConsultResult,
	LearningConfig,
	NeuronBatchResult,
	ResolvedBrainConfig,
} from './types'

/**
 * Value for the legacy `type` column of stored neuron records. Brain never
 * reads it; it is still written because SQLite brains saved by 0.1.0 declare
 * the column NOT NULL.
 */
const STORED_NEURON_TYPE = 'text'

/** Most tool-call steps one evolution run may take. */
const MAX_EVOLUTION_STEPS = 12
/** Most recent dismissed batches shown to evolution as gaps. */
const MAX_GAP_BATCHES = 20
/** Past evolution runs shown to evolution. */
const MAX_HISTORY = 5

/**
 * Brain - A learning system that auto-generates and coordinates multiple neurons
 *
 * Brain takes a natural language prompt and decomposes it into specialized neurons.
 * Data injection routes to all neurons, and queries synthesize responses from all neurons.
 *
 * Emits events for all operations and forwards neuron events.
 */
export class Brain extends TypedEmitter<BrainEventMap> {
	// Persisted state — single source of truth (backed by store.state)
	private state: BrainState

	// Persistence layer
	readonly store: BrainStore

	// State transforms (serialize/deserialize for non-serializable fields)
	private readonly stateTransforms: Record<string, BrainStateTransform>

	/**
	 * The LLM plugin this brain uses for runtime LLM calls. Each Brain instance
	 * holds its own plugin — there is no global registry. Set at construction.
	 */
	readonly llm: AdaptLLMPlugin
	private readonly repairWithFeedback?: AdaptRepairOptions['repairWithFeedback']
	private readonly maxRepairAttempts?: number

	// Runtime (rebuilt on init)
	readonly neurons: Map<string, Neuron> = new Map()
	readonly internalNeurons: Map<string, Neuron> = new Map()
	private neuronStatus: Map<string, NeuronStatus> = new Map()
	// Evolution: buffered signals, and a queue so runs never overlap
	#signals: EvolutionSignal[] = []
	#evolutionQueue: Promise<void> = Promise.resolve()
	#pendingEvolutions = 0
	// Batches some neuron took, waiting for one leftover call (not persisted)
	#gapBuffer: Array<{ inputs: LearnInput[]; entry: string }> = []

	// Constructor config (not persisted, used during init only)
	private learningConfig?: LearningConfig
	private readonly autoSetup: boolean
	private readonly configNeurons?: GeneratedNeuronConfig[]
	private readonly internalNeuronsConfig: BrainConfig['internalNeurons']
	private readonly gaps: { maxStored: number; chunkChars: number }

	private constructor(rawConfig: BrainConfig & { llm?: AdaptLLMPlugin }) {
		super()

		const model = rawConfig.model
		const blueprintModel = rawConfig.blueprintModel ?? model

		this.llm = resolveRuntimeLLM({
			llm: rawConfig.llm,
			models: [
				model,
				blueprintModel,
				rawConfig.init?.model,
				rawConfig.query?.model,
				rawConfig.evolution?.model,
				rawConfig.learning?.model,
				rawConfig.learning?.blueprintModel,
				rawConfig.learning?.query?.model,
			],
		})

		this.stateTransforms = {
			models: {
				serialize: (value: unknown) =>
					serializeBrainModelSlots(value as BrainModelSlots, this.llm),
				deserialize: (stored: unknown) =>
					deserializeBrainModelSlots(
						stored as Record<string, StoredBrainModelRef>,
					),
			},
		}

		this.state = createInitialBrainState({
			prompt: rawConfig.prompt,
			model,
			blueprintModel,
			initModel: rawConfig.init?.model ?? blueprintModel,
			queryModel: rawConfig.query?.model ?? model,
			evolutionModel: rawConfig.evolution?.model ?? model,
			batchSize: rawConfig.ingest?.batchSize ?? BRAIN_DEFAULTS.ingest.batchSize,
			evolution: {
				enabled:
					rawConfig.evolution?.enabled ?? BRAIN_DEFAULTS.evolution.enabled,
				evaluatorSignalThreshold:
					rawConfig.evolution?.evaluatorSignalThreshold ??
					BRAIN_DEFAULTS.evolution.evaluatorSignalThreshold,
				autoEvaluate:
					rawConfig.evolution?.autoEvaluate ??
					BRAIN_DEFAULTS.evolution.autoEvaluate,
				coverageGap: {
					relevanceThreshold:
						rawConfig.evolution?.coverageGap?.relevanceThreshold ?? 0.3,
				},
			},
		})
		this.store = rawConfig.store ?? new MemoryBrainStore()
		this.learningConfig = rawConfig.learning
		this.repairWithFeedback = rawConfig.repairWithFeedback
		this.maxRepairAttempts = rawConfig.maxRepairAttempts
		this.autoSetup = rawConfig.autoSetup ?? true
		this.configNeurons = rawConfig.neurons
		this.internalNeuronsConfig = rawConfig.internalNeurons
		this.gaps = {
			maxStored: rawConfig.gaps?.maxStored ?? BRAIN_DEFAULTS.gaps.maxStored,
			chunkChars: rawConfig.gaps?.chunkChars ?? BRAIN_DEFAULTS.gaps.chunkChars,
		}
	}

	// ── Public accessors (read from state) ──────────────────────────────────

	get prompt(): string {
		return this.state.prompt
	}

	get promptContext() {
		return this.state.promptContext
	}

	/**
	 * Computed view of state in the ResolvedBrainConfig shape.
	 * External readers (evals, tests) use this.
	 * Internally, always read from this.state directly.
	 */
	get config(): ResolvedBrainConfig {
		return {
			prompt: this.state.prompt,
			model: this.state.models.default,
			blueprintModel: this.state.models.blueprint,
			init: { model: this.state.models.init },
			query: { model: this.state.models.query },
			ingest: this.state.ingest,
			evolution: {
				...this.state.evolution,
				model: this.state.models.evolution,
			},
		}
	}

	get llmRepairOptions(): AdaptRepairOptions {
		return {
			...(this.repairWithFeedback
				? { repairWithFeedback: this.repairWithFeedback }
				: {}),
			...(this.maxRepairAttempts !== undefined
				? { maxRepairAttempts: this.maxRepairAttempts }
				: {}),
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// State persistence (mirrors Neuron pattern)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Update cache + persist changed keys to store.state.
	 * Each top-level key in updates → one row in store.state.
	 */
	private async setState(updates: Partial<BrainState>): Promise<void> {
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
			const transform = this.stateTransforms[record.id]
			const deserialized = transform
				? transform.deserialize(record.value)
				: record.value
			;(this.state as unknown as Record<string, unknown>)[record.id] =
				deserialized
		}

		return true
	}

	/**
	 * Internal init dispatcher. `expect: 'fresh'` runs LLM decomposition and
	 * persists; `expect: 'restore'` loads state and rebuilds neurons. Throws
	 * if the store contradicts the expected mode.
	 */
	private async initialize(expect: 'fresh' | 'restore'): Promise<void> {
		this.emit('brain:init:started', {})

		try {
			const restored = await this.loadState()

			if (expect === 'fresh' && restored) {
				throw new Error(
					'Brain already exists in this store. Use Brain.restore() to load it, or use a fresh store.',
				)
			}
			if (expect === 'restore' && !restored) {
				throw new Error(
					'No brain found in this store. Use Brain.create() to create one.',
				)
			}

			if (restored) {
				await this.restoreNeurons()
				await this.restoreInternalNeurons()
			} else {
				await this.freshInitialize()
			}

			this.emit('brain:init:completed', {
				neuronIds: Array.from(this.neurons.keys()),
			})
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.emit('brain:init:failed', { error: errorMessage })
			throw error
		}
	}

	/**
	 * Construct a fresh Brain and persist its config to the store.
	 * Throws if the store already contains a brain — use {@link restore}.
	 */
	static async create(
		rawConfig: BrainConfig & { llm?: AdaptLLMPlugin },
	): Promise<Brain> {
		const brain = new Brain(rawConfig)
		if (rawConfig.onEvent) brain.on(rawConfig.onEvent)
		await brain.initialize('fresh')
		return brain
	}

	/**
	 * Restore a previously-persisted Brain from a store.
	 * `input` may be a path string (sugar for SQLiteBrainStore) or a BrainStore.
	 * `runtime` supplies the LLM context the brain needs after restore. Pass
	 * `model` (a live AI SDK model — covers 90% of cases), or `llm` (a full
	 * plugin instance — for BYO custom runtimes), or both. Throws if the store
	 * is empty — use {@link create}.
	 */
	static async restore(
		input: string | BrainStore,
		runtime?: BrainRuntimeOptions,
	): Promise<Brain> {
		const store = await resolveBrainStore(input)
		const brain = new Brain({
			store,
			prompt: '',
			model:
				runtime?.model ?? ('unknown:placeholder' as unknown as LanguageModel),
			blueprintModel: runtime?.blueprintModel,
			...(runtime?.init ? { init: runtime.init } : {}),
			...(runtime?.query ? { query: runtime.query } : {}),
			...(runtime?.evolution ? { evolution: runtime.evolution } : {}),
			...(runtime?.learning ? { learning: runtime.learning } : {}),
			repairWithFeedback: runtime?.repairWithFeedback,
			maxRepairAttempts: runtime?.maxRepairAttempts,
			llm: runtime?.llm,
		})
		if (runtime?.onEvent) brain.on(runtime.onEvent)
		await brain.initialize('restore')
		return brain
	}

	/**
	 * Fresh initialization: create explicit neurons, then (with `autoSetup`)
	 * the neurons the model generates from the prompt, then persist state.
	 */
	private async freshInitialize(): Promise<void> {
		// Heal orphans from a previous crashed init.
		// We're here because loadState() returned false, so any rows in
		// store.neurons / store.internalNeurons are leftovers from a prior
		// freshInitialize() that threw before reaching the final setState().
		// Without this, the next add() hits UNIQUE constraint on the same id
		// and the store stays poisoned for every retry. See issue #6.
		const orphanNeurons = await this.store.neurons.list()
		for (const record of orphanNeurons) {
			await this.clearNeuronStore(record.id)
			await this.store.neurons.delete(record.id)
		}
		const orphanInternal = await this.store.internalNeurons.list()
		for (const record of orphanInternal) {
			await this.clearNeuronStore(record.id)
			await this.store.internalNeurons.delete(record.id)
		}

		// 1. Create explicit neurons if provided
		if (this.configNeurons?.length) {
			for (const config of this.configNeurons) {
				await this.addNeuron(config)
			}
		}

		// 2. Neurons generated from the prompt (autoSetup)
		if (this.autoSetup) {
			this.emit('brain:init:config:generating', {})

			const { output, usage: llmUsage } = await this.generateNeuronConfigs()

			if (!output) {
				const error = 'Failed to generate neuron configurations'
				this.emit('brain:init:failed', { error })
				throw new Error(error)
			}

			const usage: TokenUsage = {
				inputTokens: llmUsage?.inputTokens ?? 0,
				outputTokens: llmUsage?.outputTokens ?? 0,
				totalTokens: llmUsage?.totalTokens ?? 0,
			}

			this.emit('brain:init:config:generated', {
				configs: output.neurons,
				usage,
			})

			for (const config of output.neurons) {
				// Skip if a neuron with this ID was already created from explicit config
				if (this.neurons.has(config.id)) continue
				await this.addNeuron(config)
			}
		}

		// Decompose brain prompt into reusable context (purpose, synthesis directive)
		await this.decomposeBrainPrompt()

		// Create internal neurons
		await this.createInternalNeurons()

		// Persist brain state for future restores
		await this.setState({ ...this.state })
	}

	private async clearNeuronStore(neuronId: string): Promise<void> {
		const store = this.store.getNeuronStore(neuronId)
		await Promise.all([
			store.observations.clear(),
			store.understanding.clear(),
			store.evolution.clear(),
			store.state.clear(),
		])
	}

	/**
	 * Decompose brain prompt into reusable context via LLM.
	 * Extracts purpose and synthesis directive.
	 * Result stored in state — skipped on restore.
	 */
	private async decomposeBrainPrompt(): Promise<void> {
		const prompt = decomposeBrainPromptTemplate(this.state.prompt)

		const { output } = await generate({
			llm: this.llm,
			model: this.state.models.blueprint,
			prompt,
			output: Output.object({ schema: promptContextSchema }),
			repairSchema: promptContextSchema,
			...this.llmRepairOptions,
		})

		this.state.promptContext = output
	}

	/**
	 * Restore neurons from store.neurons list (no LLM call).
	 * Each record is just an id. The neuron's own store has everything
	 * else — init() → loadState() handles the rest.
	 */
	private async restoreNeurons(): Promise<void> {
		const records = await this.store.neurons.list()

		for (const record of records) {
			const neuron = new Neuron({
				id: record.id,
				model: this.state.models.default,
				blueprintModel: this.state.models.blueprint,
				llm: this.llm,
				...this.llmRepairOptions,
				// Placeholder values — init() → loadState() overwrites from neuron's own store
				instructions: '',
				name: '',
				description: '',
				origin: 'prompt' as const,
				store: this.store.getNeuronStore(record.id),
			})

			// Forward all neuron events through Brain
			neuron.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})

			neuron.on('neuron:signal', (event) => {
				this.signal({
					source: event.neuronId,
					description: event.description,
				})
			})

			// Feed synthesis events to global injection understanding
			this.wireExternalNeuronSynthesisEvents(neuron)

			// init({ expect: 'restore' }) → loadState() must succeed
			await neuron.init({ expect: 'restore' })

			this.neurons.set(record.id, neuron)
			this.neuronStatus.set(record.id, record.status ?? 'active')
		}
	}

	/**
	 * Restore internal neurons from store.internalNeurons (no LLM call).
	 * Same pattern as restoreNeurons() but writes to this.internalNeurons.
	 * Internal neuron signals are NOT forwarded to evolution.
	 */
	private async restoreInternalNeurons(): Promise<void> {
		const records = await this.store.internalNeurons.list()

		for (const record of records) {
			const neuron = new Neuron({
				id: record.id,
				model: this.state.models.default,
				blueprintModel: this.state.models.blueprint,
				llm: this.llm,
				...this.llmRepairOptions,
				instructions: '',
				name: '',
				description: '',
				origin: 'prompt' as const,
				store: this.store.getNeuronStore(record.id),
			})

			// Forward events through Brain but do NOT forward signals to evolution
			neuron.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})

			await neuron.init({ expect: 'restore' })

			this.internalNeurons.set(record.id, neuron)
		}
	}

	/**
	 * Create internal neurons from definitions during fresh init.
	 * Uses the same factory as external neurons but stores in the internal map/store.
	 */
	private async createInternalNeurons(): Promise<void> {
		const configs = getInternalNeuronConfigs(this.internalNeuronsConfig)

		for (const config of configs) {
			const neuron = new Neuron({
				id: config.id,
				model: this.state.models.default,
				blueprintModel: this.state.models.blueprint,
				llm: this.llm,
				...this.llmRepairOptions,
				instructions: config.instructions,
				origin: 'prompt' as const,
				name: config.name,
				description: config.description,
				store: this.store.getNeuronStore(config.id),
				governance: this.#governanceFor(config),
				understand: {
					thresholds: {
						maxObservations: 3,
						maxTokens: BRAIN_DEFAULTS.learning.understand.thresholds.maxTokens,
						minImportance: 0.1,
					},
				},
			})

			// Forward events but do NOT forward signals to evolution
			neuron.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})

			await neuron.init({ expect: 'fresh' })

			this.internalNeurons.set(config.id, neuron)
			await this.store.internalNeurons.add({
				id: config.id,
				type: STORED_NEURON_TYPE,
			})
		}
	}

	/**
	 * Generate neuron configs from the brain prompt (one call)
	 */
	private async generateNeuronConfigs() {
		return generate({
			llm: this.llm,
			model: this.state.models.init,
			prompt: setupPrompt(this.prompt),
			output: Output.object({ schema: neuronConfigsSchema }),
			repairSchema: neuronConfigsSchema,
			...this.llmRepairOptions,
		})
	}

	/** Brain defaults, then `learning.governance`, then the neuron's own governance. */
	#governanceFor(config: GeneratedNeuronConfig) {
		return {
			strategy: BRAIN_DEFAULTS.learning.governance.strategy,
			maxTokens: BRAIN_DEFAULTS.learning.governance.maxTokens,
			...definedOnly(this.learningConfig?.governance),
			...definedOnly(config.governance),
		}
	}

	/**
	 * Add a neuron. Used for explicit neurons, setup, evolution and by users.
	 */
	async addNeuron(config: GeneratedNeuronConfig): Promise<Neuron> {
		if (this.neurons.has(config.id) || this.internalNeurons.has(config.id)) {
			throw new Error(`Neuron ${config.id} already exists`)
		}
		const learning = this.learningConfig
		const neuron = new Neuron({
			id: config.id,
			model: learning?.model ?? this.state.models.default,
			blueprintModel: learning?.blueprintModel ?? this.state.models.blueprint,
			...(learning?.query ? { query: learning.query } : {}),
			llm: this.llm,
			...this.llmRepairOptions,
			instructions: config.instructions,
			origin: 'prompt' as const,
			name: config.name,
			description: config.description,
			understand: {
				thresholds: {
					maxObservations:
						BRAIN_DEFAULTS.learning.understand.thresholds.maxObservations,
					maxTokens: BRAIN_DEFAULTS.learning.understand.thresholds.maxTokens,
					minImportance:
						BRAIN_DEFAULTS.learning.understand.thresholds.minImportance,
					...learning?.understand?.thresholds,
				},
			},
			store: this.store.getNeuronStore(config.id),
			governance: this.#governanceFor(config),
		})

		// Forward all neuron events through Brain
		neuron.on((event) => {
			this.emit(event.type as keyof BrainEventMap, event.payload as never)
		})

		// Neuron health signals feed evolution
		neuron.on('neuron:signal', (event) => {
			this.signal({
				source: event.neuronId,
				description: event.description,
			})
		})

		// Feed synthesis events to global injection understanding
		this.wireExternalNeuronSynthesisEvents(neuron)

		await neuron.init({ expect: 'fresh' })

		this.neurons.set(config.id, neuron)
		this.neuronStatus.set(config.id, 'active')

		// Persist neuron ref (neuron's own store has everything else)
		await this.store.neurons.add({
			id: config.id,
			type: STORED_NEURON_TYPE,
			status: 'active',
		})

		this.emit('brain:neuron:added', {
			neuronId: config.id,
			name: config.name,
			instructions: config.instructions,
		})

		return neuron
	}

	/**
	 * Change a neuron's name, description or instructions. Its memory is kept.
	 */
	async updateNeuron(
		id: string,
		changes: Partial<
			Pick<GeneratedNeuronConfig, 'name' | 'description' | 'instructions'>
		>,
	): Promise<Neuron> {
		const neuron = this.#neuronOrThrow(id)
		await neuron.update(changes)
		return neuron
	}

	/**
	 * Replace two or more neurons with one new neuron. The new neuron starts
	 * with their memories joined; the old neurons are removed.
	 */
	async mergeNeurons(
		ids: string[],
		config: GeneratedNeuronConfig,
	): Promise<Neuron> {
		const sources = [...new Set(ids)].map((id) => this.#neuronOrThrow(id))
		if (sources.length < 2) {
			throw new Error('Merge needs two or more different neurons')
		}
		const memories = await Promise.all(
			sources.map((neuron) => neuron.getUnderstanding()),
		)
		const merged = await this.addNeuron(config)
		const memory = memories.filter((m) => m.length > 0).join('\n\n')
		if (memory) await merged.setUnderstanding(memory)
		for (const neuron of sources) await this.removeNeuron(neuron.id)
		return merged
	}

	/**
	 * Remove a neuron and its memory.
	 */
	async removeNeuron(id: string): Promise<void> {
		const neuron = this.#neuronOrThrow(id)
		await neuron.dispose()
		this.neurons.delete(id)
		this.neuronStatus.delete(id)
		await this.store.neurons.delete(id)
		this.emit('brain:neuron:removed', { neuronId: id })
	}

	#neuronOrThrow(id: string): Neuron {
		const neuron = this.neurons.get(id)
		if (!neuron) throw new Error(`Neuron ${id} not found`)
		return neuron
	}

	/**
	 * Adjust a neuron's behavior and/or understanding (basic tier — no evolution required)
	 *
	 * Pass-through to neuron.adjust(directive). A classification step determines
	 * whether to adjust config, understanding content, or both.
	 */
	async adjustNeuron(
		id: string,
		directive: string,
	): Promise<{ neuron: Neuron; result: AdjustResult }> {
		const neuron = this.neurons.get(id)
		if (!neuron) {
			throw new Error(`Neuron ${id} not found`)
		}
		const result = await neuron.adjust(directive)
		return { neuron, result }
	}

	/**
	 * Get all neurons
	 */
	getNeurons(): Neuron[] {
		return Array.from(this.neurons.values())
	}

	/**
	 * Get a specific neuron by ID
	 */
	getNeuron(id: string): Neuron | undefined {
		return this.neurons.get(id)
	}

	/**
	 * Get the lifecycle status of a neuron. Defaults to 'active' for any
	 * record that predates the status field.
	 */
	getNeuronStatus(id: string): NeuronStatus | undefined {
		if (!this.neurons.has(id)) return undefined
		return this.neuronStatus.get(id) ?? 'active'
	}

	/**
	 * Pause a neuron. Inject fan-out skips paused neurons; ask/query still
	 * hits them (their knowledge stays consultable). Survives restarts via
	 * the BrainNeuronRecord.status field.
	 */
	async pauseNeuron(id: string): Promise<void> {
		await this.setNeuronStatus(id, 'inactive')
	}

	/**
	 * Resume a previously paused neuron.
	 */
	async resumeNeuron(id: string): Promise<void> {
		await this.setNeuronStatus(id, 'active')
	}

	private async setNeuronStatus(
		id: string,
		newStatus: NeuronStatus,
	): Promise<void> {
		if (!this.neurons.has(id)) {
			throw new Error(`Unknown neuron: ${id}`)
		}
		const previousStatus = this.neuronStatus.get(id) ?? 'active'
		if (previousStatus === newStatus) return

		this.neuronStatus.set(id, newStatus)
		await this.store.neurons.update(id, { status: newStatus })

		this.emit('brain:neuron:status:changed', {
			neuronId: id,
			previousStatus,
			newStatus,
		})
	}

	/**
	 * Get a specific internal neuron by ID
	 */
	getInternalNeuron(id: string): Neuron | undefined {
		return this.internalNeurons.get(id)
	}

	/**
	 * Inject data into all neurons
	 *
	 * Data is batched by batchSize and sent to ALL neurons.
	 * Each neuron processes independently and may further chunk by token limit.
	 */
	async inject(
		data: LearnInput | readonly LearnInput[],
		options?: BrainInjectOptions,
	): Promise<BrainInjectResult> {
		const injectId = options?.id ?? `inject_${nanoid()}`
		const items: readonly LearnInput[] =
			typeof data === 'string' || !Array.isArray(data)
				? [data as LearnInput]
				: data
		// Skip inactive neurons — pause is brain-level fan-out gating, not
		// per-neuron concern. Query path (ask) is unaffected; their knowledge
		// stays consultable.
		const neuronArray = this.getNeurons().filter(
			(n) => (this.neuronStatus.get(n.id) ?? 'active') === 'active',
		)

		// Split items into batches by batchSize
		const batchSize = this.state.ingest.batchSize
		const batches: LearnInput[][] = []
		for (let i = 0; i < items.length; i += batchSize) {
			batches.push(items.slice(i, i + batchSize))
		}

		this.emit('brain:inject:started', {
			injectId,
			itemCount: items.length,
			batchCount: batches.length,
		})

		try {
			// Process batches sequentially
			const batchResults: BrainInjectResult['batches'] = []
			for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
				const batch = batches[batchIndex]
				const batchId = `batch_${nanoid()}`

				this.emit('brain:inject:batch:started', {
					injectId,
					batchId,
					batchIndex,
					itemCount: batch.length,
				})

				// Send batch to all neurons in parallel
				const neuronResults = await Promise.all(
					neuronArray.map(async (neuron) => {
						const result = await neuron.learn(batch)
						return {
							neuronId: neuron.id,
							result,
						}
					}),
				)

				this.emit('brain:inject:batch:completed', {
					injectId,
					batchId,
					batchIndex,
					results: neuronResults,
				})

				await this.handleGaps(batchId, batch, neuronResults)

				batchResults.push({
					id: batchId,
					index: batchIndex,
					results: neuronResults,
				})
			}

			this.emit('brain:inject:completed', {
				injectId,
				batches: batchResults,
			})

			return { id: injectId, batches: batchResults }
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.emit('brain:inject:failed', { injectId, error: errorMessage })
			throw error
		}
	}

	/**
	 * Ask all neurons and synthesize a unified response
	 *
	 * @param query - The question to ask
	 * @param options.mode - 'direct' (default, fast: 2 LLM calls) or 'deep' (agentic)
	 */
	async ask(
		query: string,
		options?: AdaptGenerateOptions & {
			model?: LanguageModel
			mode?: 'direct' | 'deep'
		},
	): Promise<BrainAskResult> {
		const mode = options?.mode ?? 'direct'
		const queryId = `query_${nanoid()}`
		this.emit('brain:ask:started', { queryId, query })

		try {
			const {
				model: modelOverride,
				mode: _mode,
				...rawGenerateOptions
			} = options ?? {}
			const generateOptions = {
				...this.llmRepairOptions,
				...rawGenerateOptions,
			}
			const synthesisModel = modelOverride ?? this.state.models.query

			const result =
				mode === 'direct'
					? await this.askDirect(query, synthesisModel, generateOptions)
					: await this.askDeep(query, synthesisModel, generateOptions)

			this.feedAskToInternalNeurons(
				query,
				result.sources.map((s) => ({
					neuronId: s.neuronId,
					relevance: s.relevance,
					gaps: [],
				})),
			)

			this.emit('brain:ask:completed', {
				queryId,
				insight: result.insight,
				sources: result.sources,
				gaps: result.gaps,
				usage: result.usage,
			})

			return {
				insight: result.insight,
				sources: result.sources,
				gaps: result.gaps,
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			this.emit('brain:ask:failed', { queryId, error: errorMessage })
			throw error
		}
	}

	/**
	 * Stream an answer from the Brain — returns raw ai-sdk StreamTextResult.
	 *
	 * Direct mode: queries neurons non-streaming, then streams synthesis.
	 * Deep mode: streams agentic synthesis (neuron queries visible as tool events in fullStream).
	 */
	async askStream(
		query: string,
		options?: AdaptGenerateOptions & {
			model?: LanguageModel
			mode?: 'direct' | 'deep'
		},
	): Promise<AdaptStreamResult> {
		const mode = options?.mode ?? 'direct'
		const queryId = `query_${nanoid()}`
		this.emit('brain:ask:started', { queryId, query })

		const {
			model: modelOverride,
			mode: _mode,
			...rawGenerateOptions
		} = options ?? {}
		const generateOptions = {
			...this.llmRepairOptions,
			...rawGenerateOptions,
		}
		const synthesisModel = modelOverride ?? this.state.models.query

		if (mode === 'direct') {
			return this.askDirectStream(query, synthesisModel, generateOptions)
		}
		return this.askDeepStream(query, synthesisModel, generateOptions)
	}

	/**
	 * Direct ask stream — query all neurons in parallel, then stream synthesis
	 */
	private async askDirectStream(
		query: string,
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	): Promise<AdaptStreamResult> {
		const allNeurons = this.getNeurons()

		// Filter to neurons that have knowledge
		const neuronsWithKnowledge = (
			await Promise.all(
				allNeurons.map(async (neuron) => {
					const [understanding, buffer] = await Promise.all([
						neuron.getUnderstanding(),
						neuron.getBufferState(),
					])
					return understanding || buffer.count > 0 ? neuron : null
				}),
			)
		).filter((l): l is Neuron => l !== null)

		// Pre-select relevant neurons via LLM
		const relevantNeurons = await this.selectRelevantNeurons(
			query,
			neuronsWithKnowledge,
			model,
			generateOptions,
		)

		// One neuron's failed query (e.g. a malformed reply) is skipped, not
		// fatal: the neuron already emits neuron:query:failed.
		const neuronQueries = await Promise.all(
			relevantNeurons.map(async (neuron) => {
				try {
					const result = await neuron.query(query, generateOptions)
					return { id: neuron.id, ...result }
				} catch {
					return null
				}
			}),
		)

		const specialistResults = neuronQueries
			.filter((r): r is NonNullable<typeof r> => r?.relevant === true)
			.map((r) => ({
				id: r.id,
				relevance: r.relevance,
				confidence: r.confidence,
				insight: r.insight,
				gaps: r.gaps,
			}))

		const globalNeuron = this.internalNeurons.get(
			'__internal_global_understanding',
		)
		const globalUnderstanding = globalNeuron
			? ((await globalNeuron.getUnderstanding()) as string)
			: undefined

		return synthesizeDirectStream(this.llm, model, {
			synthesisDirective:
				this.state.promptContext?.synthesisDirective ?? undefined,
			query,
			specialistResults,
			globalUnderstanding: globalUnderstanding || undefined,
			...generateOptions,
		})
	}

	/**
	 * Deep ask stream — stream agentic synthesis, neuron queries happen as tool calls
	 */
	private async askDeepStream(
		query: string,
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	): Promise<AdaptStreamResult> {
		const neuronArray = this.getNeurons()

		const specialists: SpecialistDef[] = []
		for (const neuron of neuronArray) {
			const [understanding, buffer] = await Promise.all([
				neuron.getUnderstanding(),
				neuron.getBufferState(),
			])
			if (!understanding && buffer.count === 0) continue
			specialists.push({
				id: neuron.id,
				name: neuron.name,
				description: neuron.description || neuron.name,
				query: (question, queryOptions) =>
					neuron.query(question, { ...generateOptions, ...queryOptions }),
			})
		}

		const consultTools = await this.buildConsultTools()
		return synthesizeStream(this.llm, model, {
			synthesisDirective:
				this.state.promptContext?.synthesisDirective ?? undefined,
			query,
			specialists,
			consultTools,
			...generateOptions,
		})
	}

	/**
	 * Pre-filter neurons by relevance to a query using a fast LLM call.
	 * Returns only the neurons the LLM considers relevant based on name and description.
	 */
	private async selectRelevantNeurons(
		query: string,
		neurons: Neuron[],
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	): Promise<Neuron[]> {
		if (neurons.length <= 1) return neurons

		const neuronMenu = neurons.map((l) => ({
			id: l.id,
			name: l.name,
			description: l.description || '',
		}))

		const selectionSchema = z.object({
			ids: z.array(z.string()).describe('IDs of neurons relevant to the query'),
		})

		const result = await generate({
			llm: this.llm,
			model,
			system: `You select which specialist neurons are relevant to a user query.

Given a list of specialists (each with an id, name, and description), return the ids of those whose domain is relevant to answering the query. Be inclusive — if a specialist might have useful context, include it. Only exclude specialists that are clearly unrelated.`,
			prompt: `Query: ${query}

Specialists:
${neuronMenu.map((l) => `- ${l.id}: ${l.name} — ${l.description}`).join('\n')}`,
			output: Output.object({ schema: selectionSchema }),
			repairSchema: selectionSchema,
			...generateOptions,
		})

		const selectedIds = new Set(
			(result.output as z.infer<typeof selectionSchema>).ids,
		)
		const selected = neurons.filter((l) => selectedIds.has(l.id))

		// Fallback: if LLM selected nothing, query all (don't silently drop everything)
		return selected.length > 0 ? selected : neurons
	}

	/**
	 * Direct ask — select relevant neurons, query in parallel, then one synthesis call
	 */
	private async askDirect(
		query: string,
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	) {
		const allNeurons = this.getNeurons()

		// Filter to neurons that have knowledge
		const neuronsWithKnowledge = (
			await Promise.all(
				allNeurons.map(async (neuron) => {
					const [understanding, buffer] = await Promise.all([
						neuron.getUnderstanding(),
						neuron.getBufferState(),
					])
					return understanding || buffer.count > 0 ? neuron : null
				}),
			)
		).filter((l): l is Neuron => l !== null)

		// Pre-select relevant neurons via LLM
		const relevantNeurons = await this.selectRelevantNeurons(
			query,
			neuronsWithKnowledge,
			model,
			generateOptions,
		)

		// One neuron's failed query (e.g. a malformed reply) is skipped, not
		// fatal: the neuron already emits neuron:query:failed.
		const neuronQueries = await Promise.all(
			relevantNeurons.map(async (neuron) => {
				try {
					const result = await neuron.query(query, generateOptions)
					return { id: neuron.id, ...result }
				} catch {
					return null
				}
			}),
		)

		const specialistResults = neuronQueries
			.filter((r): r is NonNullable<typeof r> => r?.relevant === true)
			.map((r) => ({
				id: r.id,
				relevance: r.relevance,
				confidence: r.confidence,
				insight: r.insight,
				gaps: r.gaps,
			}))

		const globalNeuron = this.internalNeurons.get(
			'__internal_global_understanding',
		)
		const globalUnderstanding = globalNeuron
			? ((await globalNeuron.getUnderstanding()) as string)
			: undefined

		return synthesizeDirect(this.llm, model, {
			synthesisDirective:
				this.state.promptContext?.synthesisDirective ?? undefined,
			query,
			specialistResults,
			globalUnderstanding: globalUnderstanding || undefined,
			...generateOptions,
		})
	}

	/**
	 * Deep ask — agentic synthesis, LLM decides which specialists to consult
	 */
	private async askDeep(
		query: string,
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	) {
		const neuronArray = this.getNeurons()

		const specialists: SpecialistDef[] = []
		for (const neuron of neuronArray) {
			const [understanding, buffer] = await Promise.all([
				neuron.getUnderstanding(),
				neuron.getBufferState(),
			])
			if (!understanding && buffer.count === 0) continue
			specialists.push({
				id: neuron.id,
				name: neuron.name,
				description: neuron.description || neuron.name,
				query: (question, queryOptions) =>
					neuron.query(question, { ...generateOptions, ...queryOptions }),
			})
		}

		this.emit('brain:ask:synthesis:started', {
			queryId: `query_${nanoid()}`,
			specialists: specialists.map((s) => s.id),
		})

		const consultTools = await this.buildConsultTools()
		return synthesize(this.llm, model, {
			synthesisDirective:
				this.state.promptContext?.synthesisDirective ?? undefined,
			query,
			specialists,
			consultTools,
			...generateOptions,
		})
	}

	/**
	 * Query internal neurons for Brain's self-knowledge.
	 *
	 * @param query - Question to ask internal neurons
	 * @param options - Optional: target a specific internal neuron by ID
	 */
	async consult(
		query: string,
		options?: ConsultOptions,
	): Promise<ConsultResult> {
		// Target a specific internal neuron
		if (options?.neuron) {
			const neuron = this.internalNeurons.get(options.neuron)
			if (!neuron) {
				throw new Error(`Internal neuron ${options.neuron} not found`)
			}
			const result = await neuron.query(query, this.llmRepairOptions)
			return {
				insight: result.insight,
				sources: [
					{
						neuronId: neuron.id,
						relevance: result.relevance,
						confidence: result.confidence,
						insight: result.insight,
					},
				],
				gaps: result.gaps ? result.gaps.split('\n').filter(Boolean) : [],
			}
		}

		// Query all internal neurons
		const neuronArray = Array.from(this.internalNeurons.values())
		if (neuronArray.length === 0) {
			return { insight: '', sources: [], gaps: [] }
		}

		// Check which neurons have knowledge
		const queryable = await Promise.all(
			neuronArray.map(async (l) => ({
				neuron: l,
				hasKnowledge: await l.hasKnowledge(),
			})),
		)
		const withKnowledge = queryable
			.filter((q) => q.hasKnowledge)
			.map((q) => q.neuron)

		if (withKnowledge.length === 0) {
			return { insight: '', sources: [], gaps: [] }
		}

		// Build specialists from internal neurons
		const specialists: SpecialistDef[] = withKnowledge.map((neuron) => ({
			id: neuron.id,
			name: neuron.name,
			description: neuron.description || neuron.name,
			query: (question: string) =>
				neuron.query(question, this.llmRepairOptions),
		}))

		const result = await synthesize(this.llm, this.state.models.query, {
			synthesisDirective:
				this.state.promptContext?.synthesisDirective ?? undefined,
			query,
			specialists,
			...this.llmRepairOptions,
		})

		return {
			insight: result.insight,
			sources: result.sources,
			gaps: result.gaps,
		}
	}

	/**
	 * Inspect the brain — agentic read-only introspection.
	 *
	 * An LLM agent browses neuron metadata, reads understanding summaries,
	 * and consults internal neurons to answer questions about what the brain
	 * is set up to track and what it currently knows.
	 */
	async inspect(
		query: string,
		options?: AdaptGenerateOptions & { model?: LanguageModel },
	): Promise<InspectResult> {
		const { model: modelOverride, ...rawGenerateOptions } = options ?? {}
		const generateOptions = {
			...this.llmRepairOptions,
			...rawGenerateOptions,
		}
		const model = modelOverride ?? this.state.models.query
		return runInspect(this.llm, model, this, query, generateOptions)
	}

	/**
	 * Send a signal to evolution. Signals are buffered; with `autoEvaluate`,
	 * reaching `evaluatorSignalThreshold` starts an evolution run.
	 */
	signal(signal: { source: string; description: string }): void {
		const received: EvolutionSignal = { ...signal, timestamp: new Date() }
		this.emit('brain:signal:received', received)
		if (!this.state.evolution.enabled) return
		this.#signals.push(received)
		this.#maybeEvolve()
	}

	#maybeEvolve(): void {
		const { enabled, autoEvaluate, evaluatorSignalThreshold } =
			this.state.evolution
		if (!enabled || !autoEvaluate || this.#pendingEvolutions > 0) return
		if (this.#signals.length < evaluatorSignalThreshold) return
		// A failed run already emitted evolution:failed and kept its signals;
		// the next signal retries.
		this.#queueEvolution('auto').then(
			() => this.#maybeEvolve(),
			() => undefined,
		)
	}

	/**
	 * Build consult tools for ask() synthesis — one tool per internal neuron with knowledge.
	 */
	private async buildConsultTools(): Promise<
		Record<string, import('ai').Tool> | undefined
	> {
		if (this.internalNeurons.size === 0) return undefined

		const consultInputSchema = z.object({
			question: z
				.string()
				.describe('The question to ask this knowledge source'),
		})

		const toolDefs: Array<{ id: string; name: string; description: string }> = [
			{
				id: INTERNAL_NEURON_IDS.globalUnderstanding,
				name: 'consultGlobalUnderstanding',
				description:
					"The system's cross-cutting narrative — causal connections, meta-patterns, and temporal arcs that no single knowledge section captures alone. Useful when the question asks about root causes, overall trajectory, or how different areas interact.",
			},
			{
				id: INTERNAL_NEURON_IDS.injectionGaps,
				name: 'consultCoverageGaps',
				description:
					"What the system has been unable to absorb — topics and data that fell outside all specialists' scope.",
			},
			{
				id: INTERNAL_NEURON_IDS.queryGaps,
				name: 'consultAnswerGaps',
				description:
					'Questions the system has struggled to answer well in the past.',
			},
		]

		const tools: Record<string, import('ai').Tool> = {}

		// Only include tools for internal neurons that have knowledge
		for (const def of toolDefs) {
			const neuron = this.internalNeurons.get(def.id)
			if (!neuron) continue

			if (!(await neuron.hasKnowledge())) continue

			tools[def.name] = tool({
				description: def.description,
				inputSchema: consultInputSchema,
				execute: async ({ question }: { question: string }) => {
					const result = await neuron.query(question, this.llmRepairOptions)
					return {
						relevant: result.relevant,
						insight: result.insight,
						gaps: result.gaps,
					}
				},
			})
		}

		return Object.keys(tools).length > 0 ? tools : undefined
	}

	/**
	 * Retry stored gaps on neurons an evolution run just changed. A batch no
	 * neuron took goes to every created, updated or merged neuron. A leftover
	 * gap (from batches some neuron took) goes only to neurons created or
	 * merged after it was stored, so neurons that took it never see it again.
	 * If accepted → remove the record. If dismissed again → increment retryCount.
	 */
	private async reinjectDismissedBatches(
		changedIds: string[],
		createdIds: string[],
		runStartedAt: string,
	): Promise<void> {
		const all = await this.store.dismissedBatches.list()
		const unresolved = all.filter(
			(b) => b.status === 'pending' || b.status === 'retried',
		)
		if (unresolved.length === 0) return

		const neuronsOf = (ids: string[]) =>
			ids
				.map((id) => this.neurons.get(id))
				.filter((l): l is Neuron => l !== undefined)
		const changed = neuronsOf(changedIds)
		const created = neuronsOf(createdIds)
		const tried = new Set<Neuron>()

		let absorbed = 0

		for (const batch of unresolved) {
			const data = batch.data as LearnInput[]
			const targets =
				leftoverOf(batch.gaps) === undefined
					? changed
					: batch.timestamp <= runStartedAt
						? created
						: []
			if (targets.length === 0) continue

			// Try every target — don't stop at first acceptance
			let anyAccepted = false
			for (const neuron of targets) {
				tried.add(neuron)
				const result = await neuron.learn(data)
				if (result.status !== 'observe:dismissed') {
					anyAccepted = true
				}
			}

			if (anyAccepted) {
				await this.store.dismissedBatches.delete(batch.id)
				absorbed++
			} else {
				await this.store.dismissedBatches.update(batch.id, {
					retryCount: batch.retryCount + 1,
					status: 'retried',
				})
			}
		}

		// Tell the gap neuron that set-aside data is now covered
		if (absorbed > 0) {
			const gapNeuron = this.internalNeurons.get(
				INTERNAL_NEURON_IDS.injectionGaps,
			)
			if (gapNeuron) {
				const names = [...tried].map((n) => n.name).join(', ')
				const resolvedText = `${absorbed} previously set-aside batch${absorbed === 1 ? ' was' : 'es were'} absorbed after evolution by: ${names}.`
				gapNeuron.learn([resolvedText]).catch((err) => {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`[internal-neuron] gap resolution feed error:`, msg)
				})
			}
		}
	}

	/**
	 * Feed ask() data to internal neurons.
	 * - Global query understanding always receives query data
	 * - Query gap neuron receives when all responses have low relevance
	 */
	private async feedAskToInternalNeurons(
		query: string,
		neuronResults: Array<{
			neuronId: string
			relevance: number
			gaps: string[]
		}>,
	): Promise<void> {
		const now = new Date().toISOString()
		const { relevanceThreshold } = this.state.evolution.coverageGap

		// Feed global query understanding (every ask)
		const queryNeuron = this.internalNeurons.get(
			INTERNAL_NEURON_IDS.globalQueryUnderstanding,
		)
		if (queryNeuron) {
			const relevantNeurons = neuronResults
				.filter((r) => r.relevance >= relevanceThreshold)
				.map((r) => r.neuronId)
			const allGaps = neuronResults.flatMap((r) => r.gaps)

			try {
				await queryNeuron.learn([
					[
						`Question: ${query}`,
						`Relevant neurons: ${relevantNeurons.join(', ') || 'none'}`,
						`Gaps: ${allGaps.join('; ') || 'none'}`,
						`Asked at: ${now}`,
					].join('\n'),
				])
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`[internal-neuron] query feed error:`, msg)
			}
		}

		// Feed query gap neuron (only when all neurons have low relevance)
		const allLowRelevance = neuronResults.every(
			(r) => r.relevance < relevanceThreshold,
		)
		if (allLowRelevance) {
			this.signal({
				source: 'brain',
				description: `No neuron could answer: ${query}`,
			})
			const gapNeuron = this.internalNeurons.get(INTERNAL_NEURON_IDS.queryGaps)
			if (gapNeuron) {
				const allGaps = neuronResults.flatMap((r) => r.gaps)
				try {
					await gapNeuron.learn([
						[
							`Question: ${query}`,
							`Gaps: ${allGaps.join('; ')}`,
							`Asked at: ${now}`,
						].join('\n'),
					])
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`[internal-neuron] query gap feed error:`, msg)
				}
			}
		}
	}

	/**
	 * Wire an external neuron's synthesis events to the global understanding neuron.
	 * Feeds understanding updates so the global neuron can form a unified picture.
	 */
	private wireExternalNeuronSynthesisEvents(neuron: Neuron): void {
		neuron.on('neuron:synthesized', (event) => {
			const globalNeuron = this.internalNeurons.get(
				INTERNAL_NEURON_IDS.globalUnderstanding,
			)
			if (!globalNeuron) return

			globalNeuron
				.learn([
					[
						`Specialist ${event.neuronId} updated its understanding.`,
						`Change: ${event.evolution}`,
						`Understanding:\n${event.newUnderstanding}`,
					].join('\n'),
				])
				.catch((err) => {
					console.error(`[internal-neuron] feed error:`, err?.message ?? err)
				})
		})
	}

	/**
	 * Find gaps in a batch after every neuron saw it.
	 * - No neuron took it: the whole batch is a gap. Brain stores it for
	 *   evolution, sends a signal, and feeds the injection gap neuron.
	 * - Some neuron took it: the batch and the notes the neurons kept go to
	 *   the gap buffer, which finds what no neuron kept (see #flushGapBuffer).
	 */
	private async handleGaps(
		batchId: string,
		batch: LearnInput[],
		neuronResults: NeuronBatchResult[],
	): Promise<void> {
		const takers = neuronResults.filter(
			(r) => r.result.status !== 'observe:dismissed',
		)
		if (takers.length > 0) {
			const notes = takers.flatMap((r) =>
				'notes' in r.result && r.result.notes ? [r.result.notes] : [],
			)
			// Without notes (a taker deferred or failed) there is nothing to compare
			if (notes.length === 0) return
			this.#gapBuffer.push({
				inputs: batch,
				entry: leftoverEntry(batch.map(inputText), notes),
			})
			const chars = this.#gapBuffer.reduce((n, e) => n + e.entry.length, 0)
			if (chars >= this.gaps.chunkChars) await this.#flushGapBuffer()
			return
		}

		await this.#storeGap(batchId, batch, [])

		this.signal({
			source: 'brain',
			description: `${batch.length} input${batch.length === 1 ? '' : 's'} taken by no neuron`,
		})

		// With no neurons yet, the gap neuron has nothing to learn from
		if (neuronResults.length === 0) return

		// Feed injection gap neuron (awaited so observations are stored before we continue)
		const gapNeuron = this.internalNeurons.get(
			INTERNAL_NEURON_IDS.injectionGaps,
		)
		if (gapNeuron) {
			try {
				const items = batch.map(inputText)
				const gapText = `Data arrived that no specialist could absorb. It has been set aside for now:\n${items.map((item) => `- ${item}`).join('\n')}`
				await gapNeuron.learn([gapText])
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`[internal-neuron] injection gap feed error:`, msg)
			}
		}
	}

	/**
	 * One leftover call over the buffered batches finds what no neuron kept.
	 * When something is left, Brain stores the batches with the leftover text
	 * and sends the leftover text to evolution as one signal.
	 */
	async #flushGapBuffer(): Promise<void> {
		const entries = this.#gapBuffer.splice(0)
		if (entries.length === 0) return
		let leftover: string
		try {
			const result = await generate({
				llm: this.llm,
				model: this.state.models.default,
				system: leftoverSystemPrompt,
				prompt: leftoverPrompt(entries.map((e) => e.entry)),
				...this.llmRepairOptions,
			})
			leftover = result.text.trim()
		} catch (err) {
			// Keep the batches; the next flush tries again
			this.#gapBuffer.unshift(...entries)
			const msg = err instanceof Error ? err.message : String(err)
			console.error('[brain] leftover call error:', msg)
			return
		}
		if (leftoverIsEmpty(leftover, entries.length)) return

		await this.#storeGap(
			`leftover_${nanoid()}`,
			entries.flatMap((e) => e.inputs),
			[leftover],
		)
		this.signal({ source: 'brain', description: leftover })
	}

	/** Store a gap record for evolution, evicting the oldest past `maxStored`. */
	async #storeGap(
		id: string,
		data: LearnInput[],
		gaps: string[],
	): Promise<void> {
		await this.store.dismissedBatches.add({
			id,
			data,
			gaps,
			timestamp: new Date().toISOString(),
			retryCount: 0,
			status: 'pending',
		})
		const count = await this.store.dismissedBatches.count()
		if (count <= this.gaps.maxStored) return
		const all = await this.store.dismissedBatches.list()
		all.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
		for (const record of all.slice(0, count - this.gaps.maxStored)) {
			await this.store.dismissedBatches.delete(record.id)
		}
	}

	/**
	 * Run evolution now. An agent looks at the neurons, their memories, the
	 * inputs no neuron took and the buffered signals, and creates, updates,
	 * merges or removes neurons. Runs are queued, never parallel. Batches
	 * waiting in the gap buffer are checked for leftovers first.
	 *
	 * @throws if evolution is not enabled
	 */
	async evolve(): Promise<EvolutionResult> {
		if (!this.state.evolution.enabled) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}
		return this.#queueEvolution('manual')
	}

	async #queueEvolution(source: 'auto' | 'manual'): Promise<EvolutionResult> {
		this.#pendingEvolutions++
		const run = this.#evolutionQueue.then(() => this.#runEvolution(source))
		this.#evolutionQueue = run.then(
			() => undefined,
			() => undefined,
		)
		try {
			return await run
		} finally {
			this.#pendingEvolutions--
		}
	}

	async #runEvolution(source: 'auto' | 'manual'): Promise<EvolutionResult> {
		if (source === 'manual') await this.#flushGapBuffer()
		const startedAt = new Date().toISOString()
		const signals = this.#signals.splice(0)
		this.emit('evolution:started', { signalCount: signals.length })
		try {
			const neurons = await Promise.all(
				this.getNeurons()
					.filter((n) => this.neuronStatus.get(n.id) === 'active')
					.map(async (n) => ({
						id: n.id,
						name: n.name,
						description: n.description,
						instructions: n.instructions,
						memoryLength: (await n.getUnderstanding()).length,
					})),
			)
			const prompt = evolutionPrompt({
				brainPrompt: this.state.prompt,
				neurons,
				gaps: await this.#gapTexts(),
				signals,
				history: await this.#evolutionHistory(),
			})

			const changes: EvolutionChange[] = []
			const result = await generate({
				llm: this.llm,
				model: this.state.models.evolution,
				system: evolutionSystemPrompt,
				prompt,
				tools: evolutionTools(this, (change) => {
					changes.push(change)
					this.emit('evolution:change', change)
				}),
				toolChoice: 'auto',
				stopWhen: stepCountIs(MAX_EVOLUTION_STEPS),
				...this.llmRepairOptions,
			})
			const reasoning = result.steps
				.map((step) => step.text)
				.filter(Boolean)
				.join('\n')

			await this.store.evolution.add({
				id: `evolution_${nanoid()}`,
				decisions: changes,
				source,
				created_at: new Date().toISOString(),
			})

			// Neurons that now cover new ground get a try at the gaps
			const ids = (actions: EvolutionChange['action'][]) => [
				...new Set(
					changes
						.filter((c) => actions.includes(c.action))
						.map((c) => c.neuronId)
						.filter((id) => this.neurons.has(id)),
				),
			]
			const changed = ids(['create', 'update', 'merge'])
			if (changed.length > 0) {
				await this.reinjectDismissedBatches(
					changed,
					ids(['create', 'merge']),
					startedAt,
				)
			}

			const outcome: EvolutionResult = { changes, reasoning }
			this.emit('evolution:completed', outcome)
			return outcome
		} catch (error) {
			this.#signals.unshift(...signals)
			const message = error instanceof Error ? error.message : String(error)
			this.emit('evolution:failed', { error: message })
			throw error
		}
	}

	/**
	 * Text of the most recent gaps, oldest first: the inputs of a batch no
	 * neuron took, or the leftover text of batches some neuron took.
	 */
	async #gapTexts(): Promise<string[]> {
		const batches = await this.store.dismissedBatches.list()
		return batches
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
			.slice(-MAX_GAP_BATCHES)
			.flatMap((batch): unknown[] => {
				const leftover = leftoverOf(batch.gaps)
				if (leftover !== undefined) return [leftover]
				return Array.isArray(batch.data) ? batch.data : []
			})
			.flatMap((item: unknown) => {
				if (typeof item === 'string') return [item]
				if (
					typeof item === 'object' &&
					item !== null &&
					'text' in item &&
					typeof item.text === 'string'
				)
					return [item.text]
				return []
			})
	}

	/** The last few evolution runs, oldest first. */
	async #evolutionHistory(): Promise<string[]> {
		const records = await this.store.evolution.list()
		return records
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
			.slice(-MAX_HISTORY)
			.map((r) => `${r.created_at}: ${JSON.stringify(r.decisions)}`)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Brain Configuration Update
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Update Brain configuration
	 *
	 * Accepts a partial of the constructor config. Each field is categorized by
	 * its downstream effect:
	 *
	 * 1. **Brain-only** — persisted to state, no downstream propagation
	 * 2. **Mechanical cascade** — forwarded to all neurons via neuron.update()
	 * 3. **Semantic** — prompt and `learning` name/description/instructions
	 *    changes become a signal and run evolution (when enabled)
	 *
	 * @param updates - Partial configuration updates (same shape as BrainConfig)
	 * @returns Result with changed fields, neuron results, and evolution results
	 */
	async update(updates: Partial<BrainConfig>): Promise<BrainUpdateResult> {
		const changedFields: string[] = []
		const neuronResults: BrainUpdateResult['neuronResults'] = []
		let evolution: EvolutionResult | undefined
		const stateChanges: Partial<BrainState> = {}

		// ── 1. Collect brain-only state changes ──

		// Model slot changes
		let modelsChanged = false
		const newModels = { ...this.state.models }

		if (updates.init?.model !== undefined) {
			newModels.init = updates.init.model
			modelsChanged = true
			changedFields.push('init.model')
		}
		if (updates.query?.model !== undefined) {
			newModels.query = updates.query.model
			modelsChanged = true
			changedFields.push('query.model')
		}
		if (updates.model !== undefined) {
			newModels.default = updates.model
			modelsChanged = true
			changedFields.push('model')
		}
		if (updates.blueprintModel !== undefined) {
			newModels.blueprint = updates.blueprintModel
			modelsChanged = true
			changedFields.push('blueprintModel')
		}
		if (updates.evolution?.model !== undefined) {
			newModels.evolution = updates.evolution.model
			modelsChanged = true
			changedFields.push('evolution.model')
		}
		if (modelsChanged) {
			stateChanges.models = newModels
		}

		if (updates.ingest?.batchSize !== undefined) {
			stateChanges.ingest = { batchSize: updates.ingest.batchSize }
			changedFields.push('ingest.batchSize')
		}

		// Evolution config
		if (updates.evolution) {
			const evo = { ...this.state.evolution }
			let evoChanged = false

			if (
				updates.evolution.enabled !== undefined &&
				updates.evolution.enabled !== this.state.evolution.enabled
			) {
				evo.enabled = updates.evolution.enabled
				evoChanged = true
				changedFields.push('evolution.enabled')
			}

			if (
				updates.evolution.evaluatorSignalThreshold !== undefined &&
				updates.evolution.evaluatorSignalThreshold !==
					this.state.evolution.evaluatorSignalThreshold
			) {
				evo.evaluatorSignalThreshold =
					updates.evolution.evaluatorSignalThreshold
				evoChanged = true
				changedFields.push('evolution.evaluatorSignalThreshold')
			}

			if (
				updates.evolution.autoEvaluate !== undefined &&
				updates.evolution.autoEvaluate !== this.state.evolution.autoEvaluate
			) {
				evo.autoEvaluate = updates.evolution.autoEvaluate
				evoChanged = true
				changedFields.push('evolution.autoEvaluate')
			}

			if (evoChanged) {
				stateChanges.evolution = evo
			}
		}

		// Prompt (capture old value before applying)
		const semanticChanges: string[] = []

		if (updates.prompt !== undefined && updates.prompt !== this.state.prompt) {
			const oldPrompt = this.state.prompt
			stateChanges.prompt = updates.prompt
			changedFields.push('prompt')
			semanticChanges.push(
				`The user changed what the system should track. Previous: ${oldPrompt}. ` +
					'Keep neurons whose memory still serves the new purpose; update them rather than remove and recreate.',
			)
		}

		// ── Apply all state changes ──

		if (Object.keys(stateChanges).length > 0) {
			await this.setState(stateChanges)
		}

		// ── Side effects after state applied ──

		// Re-decompose brain prompt when it changes
		if (changedFields.includes('prompt')) {
			await this.decomposeBrainPrompt()
			await this.setState({ promptContext: this.state.promptContext })
		}

		// ── 2. Mechanical cascade to neurons ──

		const neuronUpdate: Record<string, unknown> = {}

		if (updates.model !== undefined) {
			neuronUpdate.model = updates.model
		}
		if (updates.blueprintModel !== undefined) {
			neuronUpdate.blueprintModel = updates.blueprintModel
		}

		// Map learning.* mechanical fields to neuronUpdate shape
		if (updates.learning?.model) neuronUpdate.model ??= updates.learning.model
		if (updates.learning?.blueprintModel)
			neuronUpdate.blueprintModel ??= updates.learning.blueprintModel
		if (updates.learning?.understand?.thresholds) {
			neuronUpdate.understand = {
				thresholds: updates.learning.understand.thresholds,
			}
		}
		if (updates.learning?.query) {
			neuronUpdate.query = updates.learning.query
		}
		if (updates.learning?.governance) {
			neuronUpdate.governance = updates.learning.governance
		}
		// Neurons created later (evolution, addNeuron) follow the same settings.
		if (updates.learning) {
			const current = this.learningConfig ?? {}
			this.learningConfig = {
				...current,
				...updates.learning,
				governance: { ...current.governance, ...updates.learning.governance },
				understand: {
					thresholds: {
						...current.understand?.thresholds,
						...updates.learning.understand?.thresholds,
					},
				},
			}
		}

		// Forward to all neurons (each ignores fields it doesn't recognize)
		if (Object.keys(neuronUpdate).length > 0) {
			for (const neuron of this.neurons.values()) {
				const result = await neuron.update(neuronUpdate)
				neuronResults.push({
					neuronId: neuron.id,
					changedFields: result.changedFields,
				})
			}
		}

		// ── 3. Semantic changes run evolution ──

		if (updates.learning?.instructions) {
			semanticChanges.push(
				`Neuron instructions update requested: ${updates.learning.instructions}`,
			)
		}
		if (updates.learning?.name) {
			semanticChanges.push(
				`Neuron name update requested: ${updates.learning.name}`,
			)
		}
		if (updates.learning?.description) {
			semanticChanges.push(
				`Neuron description update requested: ${updates.learning.description}`,
			)
		}

		if (semanticChanges.length > 0 && this.state.evolution.enabled) {
			this.signal({
				source: 'user',
				description: semanticChanges.join('\n'),
			})
			evolution = await this.evolve()
		}

		// ── 4. Emit event ──

		if (changedFields.length > 0) {
			this.emit('brain:config:updated', { updates, changedFields })
		}

		return {
			changedFields,
			config: this.config,
			neuronResults,
			evolution,
		}
	}

	/**
	 * Dispose Brain: disposes all neurons and the brain store. Batches still
	 * in the gap buffer are dropped, like buffered signals.
	 */
	async dispose(): Promise<void> {
		this.#gapBuffer = []
		for (const neuron of this.neurons.values()) {
			await neuron.dispose()
		}
		for (const neuron of this.internalNeurons.values()) {
			await neuron.dispose()
		}
		this.neurons.clear()
		this.internalNeurons.clear()
		this.neuronStatus.clear()
		await this.store.dispose()
	}
}

function inputText(item: LearnInput): string {
	return typeof item === 'string' ? item : item.text
}

/** The leftover text of a gap record; undefined for a batch no neuron took. */
function leftoverOf(gaps: unknown): string | undefined {
	if (!Array.isArray(gaps)) return undefined
	const [first]: unknown[] = gaps
	return typeof first === 'string' ? first : undefined
}

async function resolveBrainStore(
	input: string | BrainStore,
): Promise<BrainStore> {
	if (typeof input !== 'string') return input
	const { SQLiteBrainStore } = await import('../stores/sqlite/node/brain')
	return new SQLiteBrainStore(input)
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
	if (!value) return {}
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as Partial<T>
}
