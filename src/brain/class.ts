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
	tool,
} from '../llm'
import {
	type AdjustResult,
	type BaseNeuron,
	type GeneratedNeuronConfig,
	type LearnInput,
	type NeuronHealth,
	type NeuronTypeDescriptor,
	type TokenUsage,
	textNeuronDescriptor,
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
import { Evaluator } from './evaluator/class'
import { EVOLUTION_ACTIONS, type EvolutionDecision } from './evaluator/types'
import { EvolutionOrchestrator } from './evolution/orchestrator'
import type {
	AggregatedEvolutionResult,
	EvolutionActionResult,
} from './evolution/types'
import { type InspectResult, inspect as runInspect } from './inspect'
import {
	getInternalNeuronConfigs,
	INTERNAL_NEURON_IDS,
} from './internal-neurons'
import {
	decomposeBrainPromptTemplate,
	promptContextSchema,
} from './prompts/prompt.decompose-brain-prompt'
import { rootDecompositionPrompt } from './prompts/prompt.template.root-decomposition'
import { brainDecompositionSchema } from './schemas/schema.brain-decomposition'
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
	readonly neurons: Map<string, BaseNeuron<unknown>> = new Map()
	readonly internalNeurons: Map<string, BaseNeuron<unknown>> = new Map()
	readonly neuronTypes: Map<string, NeuronTypeDescriptor>
	private neuronNames: Map<string, string> = new Map()
	private neuronStatus: Map<string, NeuronStatus> = new Map()
	private evaluator?: Evaluator
	private evolutionOrchestrator?: EvolutionOrchestrator

	// Constructor config (not persisted, used during init only)
	private learningConfig?: LearningConfig
	private readonly autoSetup: boolean
	private readonly configNeurons?: GeneratedNeuronConfig[]
	private readonly internalNeuronsConfig: BrainConfig['internalNeurons']
	private readonly dismissedBatchMaxSize: number
	private reinjectTimer: ReturnType<typeof setTimeout> | null = null
	private pendingReinjectNeuronIds: Set<string> = new Set()

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
					gapCountThreshold:
						rawConfig.evolution?.coverageGap?.gapCountThreshold ?? 5,
					windowSize: rawConfig.evolution?.coverageGap?.windowSize ?? 20,
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
		this.dismissedBatchMaxSize =
			rawConfig.dismissedBatchBuffer?.maxSize ??
			BRAIN_DEFAULTS.dismissedBatchBuffer.maxSize

		// Register neuron type descriptors
		this.neuronTypes = new Map([
			[textNeuronDescriptor.type, textNeuronDescriptor],
		])
	}

	// ── Public accessors (read from state) ──────────────────────────────────

	get prompt(): string {
		return this.state.prompt
	}

	get promptContext() {
		return this.state.promptContext
	}

	get evolutionContext(): string | null {
		return this.state.promptContext?.evolutionGuidance ?? null
	}

	/**
	 * Computed view of state in the ResolvedBrainConfig shape.
	 * External readers (evaluator, evolution handlers, evals) use this.
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
	// State persistence (mirrors BaseNeuron pattern)
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

			// Initialize Evaluator and EvolutionOrchestrator if evolution is enabled
			this.initEvolution()

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
	 * Fresh initialization: create explicit neurons + LLM decomposition → persist state
	 *
	 * Flow:
	 * 1. If explicit `neurons` provided → create those first
	 * 2. If `autopilot` is true → also run LLM decomposition for additional neurons
	 * 3. Persist brain state for future restores
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
				await this.createNeuronFromConfig(config)
			}
		}

		// 2. LLM decomposition (when autopilot is on)
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
				await this.createNeuronFromConfig(config)
			}
		}

		// Decompose brain prompt into reusable context (purpose, evolution guidance, synthesis directive)
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
	 * Extracts purpose, evolution guidance, and synthesis directive.
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
	 * Each record is just { id, type }. The neuron's own store has everything
	 * else — init() → loadState() handles the rest.
	 */
	private async restoreNeurons(): Promise<void> {
		const records = await this.store.neurons.list()

		for (const record of records) {
			const descriptor = this.neuronTypes.get(record.type)
			if (!descriptor) {
				throw new Error(`Unknown neuron type: ${record.type}`)
			}

			const neuron = descriptor.factory({
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
			this.neuronNames.set(record.id, neuron.name)
			this.neuronStatus.set(record.id, record.status ?? 'active')
		}
	}

	/**
	 * Restore internal neurons from store.internalNeurons (no LLM call).
	 * Same pattern as restoreNeurons() but writes to this.internalNeurons.
	 * Internal neuron signals are NOT forwarded to the evaluator.
	 */
	private async restoreInternalNeurons(): Promise<void> {
		const records = await this.store.internalNeurons.list()

		for (const record of records) {
			const descriptor = this.neuronTypes.get(record.type)
			if (!descriptor) {
				throw new Error(`Unknown neuron type: ${record.type}`)
			}

			const neuron = descriptor.factory({
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

			// Forward events through Brain but do NOT forward signals to evaluator
			neuron.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})

			// Wire synthesis events to evaluator as "system knowledge updated" signals
			this.wireInternalNeuronSignals(neuron)

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
			const descriptor = this.neuronTypes.get(config.type)
			if (!descriptor) continue

			const neuron = descriptor.factory({
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

			// Forward events but do NOT forward signals to evaluator
			neuron.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})

			// Wire synthesis events to evaluator as "system knowledge updated" signals
			this.wireInternalNeuronSignals(neuron)

			await neuron.init({ expect: 'fresh' })

			this.internalNeurons.set(config.id, neuron)
			await this.store.internalNeurons.add({
				id: config.id,
				type: config.type,
			})
		}
	}

	/**
	 * Initialize evolution system (evaluator + orchestrator)
	 */
	private initEvolution(): void {
		if (!this.state.evolution.enabled) return

		this.evaluator = new Evaluator(
			this,
			this.state.evolution.evaluatorSignalThreshold,
		)

		// Forward all Evaluator events through Brain
		this.evaluator.on((event) => {
			this.emit(event.type as keyof BrainEventMap, event.payload as never)
		})

		// Auto-execute decisions from signal-triggered evaluations
		this.evaluator.on('evaluator:evaluation:completed', async (event) => {
			if (event.source === 'auto' && event.decisions.length > 0) {
				await this.executeEvolutionDecisions(event.decisions)
			}
		})

		// Initialize evolution orchestrator
		this.evolutionOrchestrator = new EvolutionOrchestrator(this)

		// Re-inject dismissed batches when new neurons are added.
		// Debounce with 5s window to collect all new neuron IDs into a single pass,
		// so every batch is tried against all new neurons before delete/update.
		this.on('brain:neuron:added', (event) => {
			this.pendingReinjectNeuronIds.add(event.neuronId)
			if (this.reinjectTimer) clearTimeout(this.reinjectTimer)
			this.reinjectTimer = setTimeout(() => {
				const ids = Array.from(this.pendingReinjectNeuronIds)
				this.pendingReinjectNeuronIds.clear()
				this.reinjectTimer = null
				this.reinjectDismissedBatches(ids).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`[brain] re-injection error:`, msg)
				})
			}, 5000)
		})

		// Feed gap neuron resolution observations after evolution actions
		this.on('evolution:action:executed', (event) => {
			const gapNeuron = this.internalNeurons.get(
				INTERNAL_NEURON_IDS.injectionGaps,
			)
			if (!gapNeuron) return

			const { action, guidance } = event
			let text: string | undefined

			if (action === 'create') {
				text = `A new specialist has been created to cover previously uncovered domains. ${guidance}`
			} else if (action === 'update' && this.guidanceMentionsGaps(guidance)) {
				text = `An existing specialist was updated to cover previously uncovered domains. ${guidance}`
			} else if (action === 'merge' && this.guidanceMentionsGaps(guidance)) {
				text = `Specialists were consolidated to cover previously uncovered domains. ${guidance}`
			}

			if (text) {
				gapNeuron.learn([text]).catch((err) => {
					console.error(
						`[brain] gap resolution feed error:`,
						err?.message ?? err,
					)
				})
			}
		})

		// Restore evolution history from store
		this.restoreEvolutionHistory()
	}

	/**
	 * Restore evolution history from brain store into evaluator
	 */
	private async restoreEvolutionHistory(): Promise<void> {
		if (!this.evaluator) return

		const records = await this.store.evolution.list()
		for (const record of records) {
			const decisions = record.decisions as Array<{
				action: string
				targets: string[]
				reasoning: string
			}>
			this.evaluator.restoreHistoryEntry({
				timestamp: new Date(record.created_at),
				decisions,
			})
		}
	}

	/**
	 * Generate neuron configs from prompt via LLM
	 */
	private async generateNeuronConfigs() {
		return generate({
			llm: this.llm,
			model: this.state.models.init,
			prompt: rootDecompositionPrompt(
				this.prompt,
				Array.from(this.neuronTypes.values()),
			),
			output: Output.object({ schema: brainDecompositionSchema }),
			repairSchema: brainDecompositionSchema,
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
	 * Create a neuron from a generated config (factory — routes by config.type)
	 */
	async createNeuronFromConfig(
		config: GeneratedNeuronConfig & {
			thresholds?: { minImportance?: number; maxObservations?: number }
			health?: Partial<NeuronHealth>
		},
	): Promise<BaseNeuron<unknown>> {
		const learning = this.learningConfig
		const shared = {
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
			health: config.health,
			understand: {
				thresholds: {
					maxObservations:
						BRAIN_DEFAULTS.learning.understand.thresholds.maxObservations,
					maxTokens: BRAIN_DEFAULTS.learning.understand.thresholds.maxTokens,
					minImportance:
						BRAIN_DEFAULTS.learning.understand.thresholds.minImportance,
					...this.learningConfig?.understand?.thresholds,
					...config.thresholds,
				},
			},
		}

		const descriptor = this.neuronTypes.get(config.type)
		if (!descriptor) {
			throw new Error(`Unknown neuron type: ${config.type}`)
		}

		const neuron = descriptor.factory({
			...shared,
			store: this.store.getNeuronStore(config.id),
			governance: this.#governanceFor(config),
		})

		// Forward all neuron events through Brain
		neuron.on((event) => {
			this.emit(event.type as keyof BrainEventMap, event.payload as never)
		})

		// Forward neuron:signal events to Evaluator (when implemented)
		neuron.on('neuron:signal', (event) => {
			// In Stage 2, this will forward to Evaluator
			// For now, just re-emit through Brain
			this.signal({
				source: event.neuronId,
				description: event.description,
			})
		})

		// Feed synthesis events to global injection understanding
		this.wireExternalNeuronSynthesisEvents(neuron)

		// Initialize the neuron (generates observe/synthesize prompts)
		await neuron.init({ expect: 'fresh' })

		this.neurons.set(config.id, neuron)
		this.neuronNames.set(config.id, config.name)
		this.neuronStatus.set(config.id, 'active')

		// Persist neuron ref (neuron's own store has everything else)
		await this.store.neurons.add({
			id: config.id,
			type: config.type,
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
	 * Add a neuron manually
	 */
	async addNeuron(config: GeneratedNeuronConfig): Promise<BaseNeuron<unknown>> {
		return this.createNeuronFromConfig(config)
	}

	/**
	 * Remove a neuron (basic tier — no evolution required)
	 *
	 * Disposes neuron store, removes from map, emits event.
	 */
	async removeNeuron(id: string): Promise<void> {
		const neuron = this.neurons.get(id)
		if (!neuron) {
			throw new Error(`Neuron ${id} not found`)
		}
		await this.__removeNeuron(id)
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
	): Promise<{ neuron: BaseNeuron<unknown>; result: AdjustResult }> {
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
	getNeurons(): BaseNeuron<unknown>[] {
		return Array.from(this.neurons.values())
	}

	/**
	 * Get a specific neuron by ID
	 */
	getNeuron(id: string): BaseNeuron<unknown> | undefined {
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
	getInternalNeuron(id: string): BaseNeuron<unknown> | undefined {
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

				// Check if all neurons dismissed this batch
				await this.handleDismissedBatch(batchId, batch, neuronResults)

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
		).filter((l): l is BaseNeuron<unknown> => l !== null)

		// Pre-select relevant neurons via LLM
		const relevantNeurons = await this.selectRelevantNeurons(
			query,
			neuronsWithKnowledge,
			model,
			generateOptions,
		)

		const neuronQueries = await Promise.all(
			relevantNeurons.map(async (neuron) => {
				const result = await neuron.query(query, {
					mode: 'direct',
					...generateOptions,
				})
				return { id: neuron.id, ...result }
			}),
		)

		const specialistResults = neuronQueries
			.filter((r): r is NonNullable<typeof r> => r?.relevant)
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
				name: this.neuronNames.get(neuron.id) ?? neuron.id,
				description:
					neuron.description || this.neuronNames.get(neuron.id) || neuron.id,
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
		neurons: BaseNeuron<unknown>[],
		model: LanguageModel,
		generateOptions: AdaptGenerateOptions,
	): Promise<BaseNeuron<unknown>[]> {
		if (neurons.length <= 1) return neurons

		const neuronMenu = neurons.map((l) => ({
			id: l.id,
			name: this.neuronNames.get(l.id) ?? l.id,
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
		).filter((l): l is BaseNeuron<unknown> => l !== null)

		// Pre-select relevant neurons via LLM
		const relevantNeurons = await this.selectRelevantNeurons(
			query,
			neuronsWithKnowledge,
			model,
			generateOptions,
		)

		const neuronQueries = await Promise.all(
			relevantNeurons.map(async (neuron) => {
				const result = await neuron.query(query, {
					mode: 'direct',
					...generateOptions,
				})
				return { id: neuron.id, ...result }
			}),
		)

		const specialistResults = neuronQueries
			.filter((r): r is NonNullable<typeof r> => r?.relevant)
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
				name: this.neuronNames.get(neuron.id) ?? neuron.id,
				description:
					neuron.description || this.neuronNames.get(neuron.id) || neuron.id,
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
	 * Send a signal to the evolution system (Living Brain)
	 *
	 * @param signal - Signal with source and description
	 */
	signal(signal: {
		source: string
		description: string
		bypass?: boolean
	}): void {
		const signalEvent = {
			source: signal.source,
			description: signal.description,
			timestamp: new Date(),
			bypass: signal.bypass,
		}

		this.emit('brain:signal:received', signalEvent)

		// Forward to Evaluator
		if (this.evaluator) {
			this.evaluator.signal(signalEvent)
		}
	}

	/**
	 * Trigger evolution directly, bypassing the signal buffer.
	 * Sends the signal as a bypass signal to the evaluator for immediate evaluation.
	 */
	async triggerEvolution(signal: {
		source: string
		description: string
	}): Promise<void> {
		if (!this.evaluator) return

		this.signal({
			source: signal.source,
			description: signal.description,
			bypass: true,
		})
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
	 * Re-inject pending dismissed batches into newly created neurons.
	 * If accepted → remove from buffer. If dismissed again → increment retryCount.
	 */
	private async reinjectDismissedBatches(
		newNeuronIds: string[],
	): Promise<void> {
		const all = await this.store.dismissedBatches.list()
		const unresolved = all.filter(
			(b) => b.status === 'pending' || b.status === 'retried',
		)
		if (unresolved.length === 0) return

		const newNeurons = newNeuronIds
			.map((id) => this.neurons.get(id))
			.filter((l): l is BaseNeuron<unknown> => l !== undefined)
		if (newNeurons.length === 0) return

		const resolvedGaps: string[] = []

		for (const batch of unresolved) {
			const data = batch.data as LearnInput[]

			// Try every new neuron — don't stop at first acceptance
			let anyAccepted = false
			for (const neuron of newNeurons) {
				const result = await neuron.learn(data)
				if (result.status !== 'observe:dismissed') {
					anyAccepted = true
				}
			}

			if (anyAccepted) {
				await this.store.dismissedBatches.delete(batch.id)
				const gaps = batch.gaps as string[] | undefined
				if (gaps?.length) resolvedGaps.push(...gaps)
			} else {
				await this.store.dismissedBatches.update(batch.id, {
					retryCount: batch.retryCount + 1,
					status: 'retried',
				})
			}
		}

		// Notify gap neuron that these gaps are now covered
		if (resolvedGaps.length > 0) {
			const gapNeuron = this.internalNeurons.get(
				INTERNAL_NEURON_IDS.injectionGaps,
			)
			if (gapNeuron) {
				const resolvedText = `Previously dismissed data has now been absorbed by a new specialist. Topics now covered: ${resolvedGaps.join(', ')}.`
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
	 * Check if evolution guidance text references coverage gaps.
	 */
	private guidanceMentionsGaps(guidance: string): boolean {
		const lower = guidance.toLowerCase()
		return (
			lower.includes('gap') ||
			lower.includes('uncovered') ||
			lower.includes('missing') ||
			lower.includes('not covered') ||
			lower.includes('dismissed')
		)
	}

	/**
	 * Notify the evaluator when an internal neuron synthesizes.
	 */
	private wireInternalNeuronSignals(neuron: BaseNeuron<unknown>): void {
		neuron.on('neuron:synthesized', (event) => {
			this.signal({
				source: 'system',
				description: `${neuron.name} updated: ${event.evolution || 'new understanding'}`,
			})
		})
	}

	/**
	 * Wire an external neuron's synthesis events to the global understanding neuron.
	 * Feeds understanding updates so the global neuron can form a unified picture.
	 */
	private wireExternalNeuronSynthesisEvents(neuron: BaseNeuron<unknown>): void {
		neuron.on('neuron:synthesized', (event) => {
			const globalNeuron = this.internalNeurons.get(
				INTERNAL_NEURON_IDS.globalUnderstanding,
			)
			if (!globalNeuron) return

			const feedGlobal = (understanding: string) => {
				globalNeuron
					.learn([
						[
							`Specialist ${event.neuronId} updated its understanding.`,
							`Change: ${event.evolution}`,
							`Understanding:\n${understanding}`,
						].join('\n'),
					])
					.catch((err) => {
						console.error(`[internal-neuron] feed error:`, err?.message ?? err)
					})
			}

			if (typeof event.newUnderstanding === 'string') {
				// Text neuron — understanding is already prose
				feedGlobal(event.newUnderstanding)
			} else {
				// List neuron — query for a prose compilation
				neuron
					.query('Compile everything you know into a comprehensive summary.')
					.then((result) => {
						feedGlobal(result.insight || JSON.stringify(event.newUnderstanding))
					})
					.catch((err) => {
						console.error(
							`[internal-neuron] list summary query error:`,
							err?.message ?? err,
						)
					})
			}
		})
	}

	/**
	 * Handle a batch that was dismissed by all external neurons.
	 * Persists to dismissed batch buffer and feeds the injection gap neuron.
	 */
	private async handleDismissedBatch(
		batchId: string,
		batch: LearnInput[],
		neuronResults: NeuronBatchResult[],
	): Promise<void> {
		const allDismissed = neuronResults.every(
			(r) => r.result.status === 'observe:dismissed',
		)
		if (!allDismissed) return

		// Collect gaps from all dismissals
		const gaps: string[] = []
		for (const r of neuronResults) {
			if (r.result.status === 'observe:dismissed' && r.result.gaps) {
				gaps.push(...r.result.gaps)
			}
		}

		const now = new Date().toISOString()

		// Persist dismissed batch
		await this.store.dismissedBatches.add({
			id: batchId,
			data: batch,
			gaps,
			timestamp: now,
			retryCount: 0,
			status: 'pending',
		})

		// Size-based eviction
		const count = await this.store.dismissedBatches.count()
		if (count > this.dismissedBatchMaxSize) {
			const all = await this.store.dismissedBatches.list()
			all.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
			const toEvict = all.slice(0, count - this.dismissedBatchMaxSize)
			for (const record of toEvict) {
				await this.store.dismissedBatches.delete(record.id)
			}
		}

		// When there are no external neurons, skip the gap neuron (nothing to verify)
		// and signal the evaluator directly with the actual data content
		if (neuronResults.length === 0) {
			const summary = batch
				.map((item) => (typeof item === 'string' ? item : item.text))
				.join('; ')
			this.signal({
				source: 'system',
				description: `No neurons exist to handle incoming data. Items: ${summary}`,
			})
			return
		}

		// Feed injection gap neuron (awaited so observations are stored before we continue)
		const gapNeuron = this.internalNeurons.get(
			INTERNAL_NEURON_IDS.injectionGaps,
		)
		if (gapNeuron) {
			try {
				const items = batch.map((item) =>
					typeof item === 'string' ? item : item.text,
				)
				const gapText = `Data arrived that no specialist could absorb. It has been set aside for now:\n${items.map((item) => `- ${item}`).join('\n')}`
				await gapNeuron.learn([gapText])
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`[internal-neuron] injection gap feed error:`, msg)
			}
		}
	}

	/**
	 * Manually trigger evolution evaluation (Living Brain)
	 *
	 * Evaluates buffered signals and returns evolution decisions.
	 * Decisions are not automatically executed - use evolution action handlers for that.
	 *
	 * @returns Array of evolution decisions (empty if no changes needed)
	 * @throws Error if evolution is not enabled
	 */
	async evaluateEvolution(options?: { dryRun?: boolean }): Promise<{
		decisions: EvolutionDecision[]
		results: AggregatedEvolutionResult
	}> {
		if (!this.evaluator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decisions = await this.evaluator.evaluate('manual')

		// In dryRun mode, return decisions without executing them
		if (options?.dryRun) {
			return {
				decisions,
				results: {
					created: [],
					updated: [],
					deleted: [],
					merged: [],
					split: [],
				},
			}
		}

		// Execute decisions automatically
		const results = await this.executeEvolutionDecisions(decisions)

		return { decisions, results }
	}

	/**
	 * Streaming variant of evaluateEvolution().
	 *
	 * Returns the raw ai-sdk stream so the consumer can iterate fullStream
	 * for evaluator tool events in real time, plus a decisions promise that
	 * resolves after the stream finishes and decisions are optionally executed.
	 */
	async evaluateEvolutionStream(options?: { dryRun?: boolean }): Promise<{
		stream: AdaptStreamResult
		decisions: Promise<{
			decisions: EvolutionDecision[]
			results: AggregatedEvolutionResult
		}>
	}> {
		if (!this.evaluator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const { stream, decisions: rawDecisions } =
			await this.evaluator.evaluateStream('manual')

		const decisions = rawDecisions.then(async (decisions) => {
			if (options?.dryRun || decisions.length === 0) {
				return {
					decisions,
					results: {
						created: [],
						updated: [],
						deleted: [],
						merged: [],
						split: [],
					} as AggregatedEvolutionResult,
				}
			}
			const results = await this.executeEvolutionDecisions(decisions)
			return { decisions, results }
		})

		return { stream, decisions }
	}

	/**
	 * Execute evolution decisions (private helper)
	 */
	private async executeEvolutionDecisions(
		decisions: EvolutionDecision[],
	): Promise<AggregatedEvolutionResult> {
		if (!this.evolutionOrchestrator) {
			throw new Error('Evolution orchestrator not initialized')
		}

		return this.evolutionOrchestrator.executeDecisions(decisions)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Evolution Handler Helpers (internal, used by evolution action handlers)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Internal: Remove neuron (used by evolution handlers)
	 * @internal
	 */
	async __removeNeuron(neuronId: string): Promise<void> {
		const neuron = this.neurons.get(neuronId)
		if (neuron) {
			await neuron.dispose()
		}
		this.neurons.delete(neuronId)
		this.neuronNames.delete(neuronId)
		this.neuronStatus.delete(neuronId)
		await this.store.neurons.delete(neuronId)
		this.emit('brain:neuron:removed', { neuronId })
	}

	/**
	 * Internal: Emit evolution event (used by evolution handlers)
	 * @internal
	 */
	__emitEvolutionEvent<K extends keyof BrainEventMap>(
		eventName: K,
		payload: BrainEventMap[K],
	): void {
		this.emit(eventName, payload)
	}

	/**
	 * Internal: Update neuron name in Brain's name map (used by evolution handlers)
	 * @internal
	 */
	__updateNeuronName(neuronId: string, newName: string): void {
		this.neuronNames.set(neuronId, newName)
	}

	private getNeuronOrThrow(neuronId: string): BaseNeuron<unknown> {
		const neuron = this.neurons.get(neuronId)
		if (!neuron) {
			throw new Error(`Neuron not found after evolution action: ${neuronId}`)
		}
		return neuron
	}

	private getNewNeuronIdsOrThrow(result: EvolutionActionResult): string[] {
		if (!('newNeuronIds' in result)) {
			throw new Error('Evolution action did not create a neuron')
		}
		return result.newNeuronIds
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Manual Evolution API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Create a new neuron based on natural language guidance
	 *
	 * @param guidance - Natural language description of the neuron to create
	 * @returns The newly created neuron
	 * @throws If evolution is not enabled
	 *
	 * @example
	 * ```ts
	 * const neuron = await brain.createNeuron('Track API design patterns and best practices')
	 * ```
	 */
	async createNeuron(guidance: string): Promise<BaseNeuron<unknown>> {
		if (!this.evolutionOrchestrator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decision: EvolutionDecision = {
			action: EVOLUTION_ACTIONS.create,
			reasoning: 'Manual creation',
			guidance,
			targets: [],
		}

		const result =
			await this.evolutionOrchestrator.executeSingleDecision(decision)
		const neuronId = this.getNewNeuronIdsOrThrow(result)[0]
		return this.getNeuronOrThrow(neuronId)
	}

	/**
	 * Merge multiple neurons into a single unified neuron
	 *
	 * @param neuronIds - IDs of neurons to merge (minimum 2)
	 * @param guidance - Natural language description of how to merge
	 * @returns The newly created merged neuron
	 * @throws If evolution is not enabled or neuron IDs invalid
	 *
	 * @example
	 * ```ts
	 * const merged = await brain.mergeNeurons(
	 *   ['neuron1', 'neuron2'],
	 *   'Combine into unified testing practices neuron'
	 * )
	 * ```
	 */
	async mergeNeurons(
		neuronIds: string[],
		guidance: string,
	): Promise<BaseNeuron<unknown>> {
		if (!this.evolutionOrchestrator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decision: EvolutionDecision = {
			action: EVOLUTION_ACTIONS.merge,
			reasoning: 'Manual merge',
			guidance,
			targets: neuronIds,
		}

		const result =
			await this.evolutionOrchestrator.executeSingleDecision(decision)
		const neuronId = this.getNewNeuronIdsOrThrow(result)[0]
		return this.getNeuronOrThrow(neuronId)
	}

	/**
	 * Split a neuron into multiple focused neurons
	 *
	 * @param neuronId - ID of neuron to split
	 * @param guidance - Natural language description of how to split
	 * @returns Array of newly created split neurons
	 * @throws If evolution is not enabled or neuron ID invalid
	 *
	 * @example
	 * ```ts
	 * const neurons = await brain.splitNeuron(
	 *   'neuron3',
	 *   'Split into frontend-focused and backend-focused neurons'
	 * )
	 * ```
	 */
	async splitNeuron(
		neuronId: string,
		guidance: string,
	): Promise<BaseNeuron<unknown>[]> {
		if (!this.evolutionOrchestrator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decision: EvolutionDecision = {
			action: EVOLUTION_ACTIONS.split,
			reasoning: 'Manual split',
			guidance,
			targets: [neuronId],
		}

		const result =
			await this.evolutionOrchestrator.executeSingleDecision(decision)
		return this.getNewNeuronIdsOrThrow(result).map((id: string) =>
			this.getNeuronOrThrow(id),
		)
	}

	/**
	 * Update a neuron's configuration
	 *
	 * @param neuronId - ID of neuron to update
	 * @param guidance - Natural language description of updates needed
	 * @returns The updated neuron
	 * @throws If evolution is not enabled or neuron ID invalid
	 *
	 * @example
	 * ```ts
	 * const neuron = await brain.updateNeuron(
	 *   'neuron4',
	 *   'Narrow scope to focus only on React hooks, increase importance threshold'
	 * )
	 * ```
	 */
	async updateNeuron(
		neuronId: string,
		guidance: string,
	): Promise<BaseNeuron<unknown>> {
		if (!this.evolutionOrchestrator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decision: EvolutionDecision = {
			action: EVOLUTION_ACTIONS.update,
			reasoning: 'Manual update',
			guidance,
			targets: [neuronId],
		}

		await this.evolutionOrchestrator.executeSingleDecision(decision)
		return this.getNeuronOrThrow(neuronId)
	}

	/**
	 * Delete a neuron from the Brain
	 *
	 * @param neuronId - ID of neuron to delete
	 * @throws If evolution is not enabled or neuron ID invalid
	 *
	 * @example
	 * ```ts
	 * await brain.deleteNeuron('neuron5')
	 * ```
	 */
	async deleteNeuron(neuronId: string): Promise<void> {
		if (!this.evolutionOrchestrator) {
			throw new Error(
				'Evolution is not enabled. Set config.evolution.enabled = true',
			)
		}

		const decision: EvolutionDecision = {
			action: EVOLUTION_ACTIONS.delete,
			reasoning: 'Manual deletion',
			guidance: `Delete neuron ${neuronId}`,
			targets: [neuronId],
		}

		await this.evolutionOrchestrator.executeSingleDecision(decision)
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
	 * 3. **Signal-driven** — semantic changes routed through the evaluator
	 *
	 * @param updates - Partial configuration updates (same shape as BrainConfig)
	 * @returns Result with changed fields, neuron results, and evolution results
	 */
	async update(updates: Partial<BrainConfig>): Promise<BrainUpdateResult> {
		const changedFields: string[] = []
		const neuronResults: BrainUpdateResult['neuronResults'] = []
		let evolutionResults: BrainUpdateResult['evolutionResults'] | undefined
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
				`Brain purpose has been updated by the user.\n` +
					`Previous purpose: ${oldPrompt}\n` +
					`New purpose: ${updates.prompt}\n\n` +
					`IMPORTANT: This update does NOT necessarily mean all existing neurons should be deleted and recreated. ` +
					`Consider the relationship between the old and new purpose:\n` +
					`- If the new purpose is a REFINEMENT or NARROWING of the old one, ADJUST existing neurons to match.\n` +
					`- If the new purpose OVERLAPS with the old one, keep neurons whose knowledge is still relevant (check "What it has learned so far"), adjust their instructions, and only create new ones for gaps.\n` +
					`- If the new purpose ADDS a new dimension, create new neurons for the new area while keeping existing ones.\n` +
					`- Only DELETE a neuron if its accumulated knowledge is genuinely irrelevant to the new purpose.\n` +
					`- Prefer ADJUST over DELETE+CREATE — adjusting preserves accumulated understanding, deleting destroys it.`,
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

		if (
			changedFields.includes('evolution.enabled') &&
			this.state.evolution.enabled &&
			!this.evaluator
		) {
			this.initEvolution()
		}

		if (
			changedFields.includes('evolution.evaluatorSignalThreshold') &&
			this.evaluator
		) {
			this.evaluator = new Evaluator(
				this,
				this.state.evolution.evaluatorSignalThreshold,
			)
			this.evaluator.on((event) => {
				this.emit(event.type as keyof BrainEventMap, event.payload as never)
			})
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

		// ── 3. Signal-driven (semantic changes) ──

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

		if (semanticChanges.length > 0) {
			this.signal({
				source: 'brain',
				description: `SYSTEM DIRECTIVE: ${semanticChanges.join('\n\n')}`,
				bypass: true,
			})

			// Await full evaluation + execution
			if (this.evaluator) {
				const { decisions, results } = await this.evaluateEvolution()
				evolutionResults = {
					decisions,
					...results,
				}
			}
		}

		// ── 4. Emit event ──

		if (changedFields.length > 0) {
			this.emit('brain:config:updated', { updates, changedFields })
		}

		return {
			changedFields,
			config: this.config,
			neuronResults,
			evolutionResults,
		}
	}

	/**
	 * Dispose Brain: disposes all neurons and the brain store
	 */
	async dispose(): Promise<void> {
		for (const neuron of this.neurons.values()) {
			await neuron.dispose()
		}
		for (const neuron of this.internalNeurons.values()) {
			await neuron.dispose()
		}
		this.neurons.clear()
		this.internalNeurons.clear()
		this.neuronNames.clear()
		this.neuronStatus.clear()
		await this.store.dispose()
	}
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
