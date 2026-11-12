import { isDeepStrictEqual } from 'node:util'

import type { TextLearningConfig } from '../../learning/text-procedures'
import type { TextInput, TextProfileSnapshot } from '../../learning/text-state'
import type { AdaptLLMPlugin, LanguageModel } from '../../llm'
import { resolveRuntimeLLM } from '../../llm'
import type { NeuronStore } from '../../stores'
import type { ParentModels } from '../../types/config'
import type {
	AdjustResult,
	LearnOptions,
	LearnOutput,
	UnderstandCallResult,
} from '../base/class'
import { BaseNeuron } from '../base/class'
import { resolveUnderstandInstructions } from '../base/instructions'
import type { QueryMethod } from '../base/query'
import { DirectMethod, ToolBasedMethod } from '../base/query'
import type { Significance } from '../types'
import {
	type AdaptiveTextFlushOutput,
	type AdaptiveTextLearningConfig,
	type AdaptiveTextLearningRuntime,
	type AdaptiveTextLearningState,
	type AdaptiveTextLearnOutput,
	AdaptiveTextRuntime,
} from './adaptive-runtime'
import { resolveTextNeuronConfig } from './config.resolver'
import {
	buildTextQueryPrompt,
	createReadUnderstandingTool,
} from './query-tools'
import { applyStrategy } from './strategies'
import type { TextNeuronConfig, TextNeuronState } from './types'
import {
	adjustUnderstand,
	adjustUnderstandingContent,
	initUnderstand,
	understand,
} from './understand'
import { understandSystemPromptTemplate } from './understand/prompts/system'

const RESTORE_PLACEHOLDER_MODEL =
	'unknown:placeholder' as unknown as LanguageModel

/**
 * TextNeuron - A learning agent that maintains understanding as narrative text
 *
 * Strategy application is handled in postProcessUnderstanding.
 * Store is injected — caller must provide it.
 */
export class TextNeuron extends BaseNeuron<string, TextNeuronState> {
	readonly #adaptive?: AdaptiveTextRuntime
	readonly #adaptiveConfig?: AdaptiveTextLearningConfig

	get type(): string {
		return 'text'
	}

	constructor(
		rawConfig: TextNeuronConfig & { llm?: AdaptLLMPlugin },
		parentModels?: ParentModels,
	) {
		const learning = rawConfig.learning
		const preparedConfig =
			learning === undefined
				? rawConfig
				: prepareAdaptiveConfig(rawConfig, learning)
		const config = resolveTextNeuronConfig(preparedConfig, parentModels)
		const maxObsForStagnation =
			3 * (config.understand.thresholds.maxObservations ?? 10)
		const llm = resolveRuntimeLLM({
			llm: rawConfig.llm,
			models: [
				config.model,
				config.blueprintModel,
				config.observer.model,
				config.observer.blueprintModel,
				config.understand.model,
				config.understand.blueprintModel,
				config.query.model,
			],
		})

		const initialState: TextNeuronState = {
			instructions: config.instructions,
			observeInstructions: config.observeInstructions,
			understandInstructions: config.understandInstructions,
			name: rawConfig.name || config.id,
			description: rawConfig.description ?? '',
			focus: rawConfig.focus ?? null,
			origin: config.origin,
			models: {
				default: config.model,
				blueprint: config.blueprintModel,
				observer: config.observer.model,
				observer_blueprint: config.observer.blueprintModel,
				understand: config.understand.model,
				understand_blueprint: config.understand.blueprintModel,
				query: config.query.model,
			},
			observe_prompt: null,
			understand_prompt: null,
			understand_identity: null,
			observation_schema: rawConfig.observationSchema ?? null,
			understanding_schema: rawConfig.understandingSchema ?? null,
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
					maxObservationsWithoutSynthesis: maxObsForStagnation,
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
			stagnation_signal_fired: false,
			dismissal_signal_fired: false,
			governance: config.governance,
			skipObservation:
				learning === undefined ? (rawConfig.skipObservation ?? false) : true,
			skipUnderstand:
				learning === undefined ? (rawConfig.skipUnderstand ?? false) : true,
		}

		super(config.id, llm, rawConfig.store, initialState, {
			repairWithFeedback: rawConfig.repairWithFeedback,
			maxRepairAttempts: rawConfig.maxRepairAttempts,
		})
		if (learning !== undefined) {
			this.#adaptiveConfig = learning
			this.#adaptive = new AdaptiveTextRuntime(
				rawConfig.store,
				learning.runtime,
			)
		}
	}

	override async init(opts?: { expect?: 'fresh' | 'restore' }): Promise<{
		observeSystemPrompt: string
		understandSystemPrompt: string
	}> {
		const initialized = await super.init(opts)
		if (this.#adaptive !== undefined && this.#adaptiveConfig !== undefined) {
			await this.#adaptive.initialize(this.#adaptiveConfig.initialProfile)
		}
		return initialized
	}

	// ── Abstract implementations ───────────────────────────────────────────────

	async getUnderstanding(): Promise<string> {
		const record = await this.store.understanding.get('current')
		return record ? (record.data as string) : ''
	}

	async setUnderstanding(understanding: string): Promise<void> {
		if (this.#adaptive !== undefined) {
			throw new Error(
				'adaptive text understanding is changed only by the learning coordinator',
			)
		}
		const existing = await this.store.understanding.get('current')
		if (existing) {
			await this.store.understanding.update('current', {
				data: understanding,
				metadata_updated_at: new Date().toISOString(),
			})
		} else {
			await this.store.understanding.add({
				id: 'current',
				data: understanding,
				metadata_confidence: 1.0,
				metadata_created_at: new Date().toISOString(),
				metadata_updated_at: new Date().toISOString(),
			})
		}

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

	protected async regenUnderstandPrompt(
		model: LanguageModel,
		instructions: string,
	): Promise<void> {
		const result = await initUnderstand(
			this.llm,
			model,
			instructions,
			this.state.governance.strategy,
			this.llmRepairOptions,
		)
		await this.setState({
			understand_identity: result.identity,
			understand_prompt: result.systemPrompt,
		} as Partial<TextNeuronState>)
	}

	protected rebuildUnderstandPromptFromState(instructions: string): string {
		return understandSystemPromptTemplate(
			instructions,
			this.state.understand_identity ?? { skills: [], dynamicsSkills: [] },
			this.state.governance.strategy,
		)
	}

	protected async adjustUnderstandPrompt(
		model: LanguageModel,
		directive: string,
		newInstructions: string,
	): Promise<void> {
		const result = await adjustUnderstand(
			this.llm,
			model,
			directive,
			newInstructions,
			this.state.understand_identity!,
			this.state.governance.strategy,
			this.llmRepairOptions,
		)
		await this.setState({
			understand_identity: result.identity,
			understand_prompt: result.systemPrompt,
		} as Partial<TextNeuronState>)
	}

	protected async adjustUnderstanding(
		model: LanguageModel,
		directive: string,
	): Promise<{ evolution: string; significance: Significance }> {
		const currentUnderstanding = await this.getUnderstanding()
		const result = await adjustUnderstandingContent(
			this.llm,
			model,
			directive,
			currentUnderstanding,
			resolveUnderstandInstructions(this.state),
			this.llmRepairOptions,
		)

		if (result.status === 'synthesized') {
			const processed = await this.postProcessUnderstanding(
				result.newUnderstanding,
			)
			await this.setUnderstanding(processed)
			return { evolution: result.evolution, significance: result.significance }
		}

		return { evolution: result.evolution, significance: 'routine' }
	}

	protected async callUnderstand(
		model: LanguageModel,
		understanding: string,
		observations: string[],
		callbacks?: { onThinking?: (thoughts: string[]) => void },
	): Promise<UnderstandCallResult> {
		const result = await understand(
			this.llm,
			model,
			this.state.understand_prompt!,
			{
				neuronId: this.id,
				instructions: this.state.instructions,
				currentUnderstanding: understanding,
				observations,
			},
			callbacks,
			this.llmRepairOptions,
		)

		if (result.status === 'error') {
			return { status: 'error', error: result.error }
		}
		if (result.status === 'dismissed') {
			return {
				status: 'dismissed',
				output: result.output,
				usage: result.usage,
			}
		}
		return {
			status: 'synthesized',
			newUnderstanding: result.newUnderstanding,
			significance: result.significance,
			evolution: result.evolution,
			reasoning: result.reasoning,
			usage: result.usage,
		}
	}

	protected async postProcessUnderstanding(raw: string): Promise<string> {
		const result = await applyStrategy({
			understanding: raw,
			llm: this.llm,
			model: this.state.models.default,
			config: this.state.governance,
			...this.llmRepairOptions,
		})
		return result.understanding
	}

	protected createQueryMethod(): QueryMethod {
		if (this.#adaptive !== undefined) return this.createAdaptiveQueryMethod()
		return new ToolBasedMethod(this.llm, this.state.models.query, {
			tools: {
				readUnderstanding: createReadUnderstandingTool(
					() => this.getUnderstanding(),
					() => this.getBufferedObservations(),
				),
			},
			buildPrompt: buildTextQueryPrompt,
		})
	}

	protected createDirectQueryMethod(): QueryMethod {
		if (this.#adaptive !== undefined) return this.createAdaptiveQueryMethod()
		return new DirectMethod(this.llm, this.state.models.query, {
			getUnderstanding: () => this.getUnderstanding(),
			buildPrompt: (ctx, understanding) =>
				`You are a specialist. Your domain:\n"${ctx.instructions}"\n\n# Your Understanding\n${understanding || '(empty — no knowledge yet)'}\n\nAnswer from your understanding. Be specific — cite data points, counts, dates. If you don't have enough, say so. Don't fabricate.`,
		})
	}

	private createAdaptiveQueryMethod(): QueryMethod {
		return new DirectMethod(this.llm, this.state.models.query, {
			getUnderstanding: () => this.getUnderstanding(),
			buildPrompt: (ctx, understanding) => {
				const state = this.#adaptive?.queryStatus()
				const pendingCount = state?.pendingDeliveryIds.length ?? 0
				const capacity = state?.capacity ?? []
				return `You are a specialist. Your domain:\n"${ctx.instructions}"\n\n# Committed Understanding\n${understanding || '(empty — no committed knowledge yet)'}\n\n# Learning Status\nCommitted memory revision: ${state?.memoryRevision ?? 0}\nPending inputs: ${pendingCount}. Pending input contents are unavailable and must not be treated as learned.\nCapacity blocked: ${capacity.length > 0 ? 'yes' : 'no'}${capacity.length > 0 ? ` (${capacity.map(({ reason }) => reason).join('; ')})` : ''}.\n\nAnswer only from the committed understanding. Be specific. If it is insufficient or newer input is pending, state the gap. Do not fabricate.`
			},
		})
	}

	// ── Schema generation (hardcoded for text) ──────────────────────────────────

	protected async generateSchemas() {
		return {
			observationSchema: {
				type: 'string',
				description: 'Single observation. Concise and factual.',
				minLength: 10,
				maxLength: 500,
			},
			understandingSchema: {
				type: 'string',
				description:
					'Comprehensive prose synthesis. Well-structured narrative.',
				minLength: 100,
				maxLength: 5000,
			},
		}
	}

	// ── Text-specific accessors ────────────────────────────────────────────────

	getUnderstandIdentity() {
		return this.state.understand_identity
	}

	getGovernance() {
		return { ...this.state.governance }
	}

	getQueryMethodName(): string {
		return this.#adaptive === undefined ? 'tool-based' : 'direct'
	}

	override async getBufferState(): Promise<{
		count: number
		avgImportance: number
		totalTokens: number
	}> {
		if (this.#adaptive === undefined) return super.getBufferState()
		return {
			count: this.#adaptive.queryStatus()?.pendingDeliveryIds.length ?? 0,
			avgImportance: 0,
			totalTokens: 0,
		}
	}

	override async getBufferedObservations(): Promise<
		Array<{ text: string; importance: number }>
	> {
		return this.#adaptive === undefined ? super.getBufferedObservations() : []
	}

	// ── Type-specific update (only governance) ─────────────────────────────────

	protected applyTypeSpecificUpdates(
		updates: Record<string, unknown>,
		changedFields: string[],
	): Partial<TextNeuronState> {
		const u = updates as Partial<TextNeuronConfig>
		const result: Partial<TextNeuronState> = {}

		if (u.governance) {
			const newGov = { ...this.state.governance }
			if (
				u.governance.strategy !== undefined &&
				u.governance.strategy !== this.state.governance.strategy
			) {
				newGov.strategy = u.governance.strategy
				changedFields.push('governance.strategy')
			}
			if (
				u.governance.maxTokens !== undefined &&
				u.governance.maxTokens !== this.state.governance.maxTokens
			) {
				newGov.maxTokens = u.governance.maxTokens
				changedFields.push('governance.maxTokens')
			}
			result.governance = newGov
		}

		return result
	}

	// ── Typed update wrapper ───────────────────────────────────────────────────

	async update(
		updates: Partial<TextNeuronConfig>,
	): Promise<{ changedFields: string[] }> {
		if (this.#adaptive !== undefined) return this.#updateAdaptive(updates)
		return super.update(updates as Record<string, unknown>)
	}

	/**
	 * In adaptive mode, `adjust` appends the directive verbatim as a developer
	 * instruction and publishes a new profile. Learned memory is not edited:
	 * it changes only through learning.
	 */
	override async adjust(directive: string): Promise<AdjustResult> {
		if (this.#adaptive !== undefined) {
			const text = directive.trim()
			if (text.length === 0)
				throw new Error('adjust directive must not be empty')
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
		return super.adjust(directive)
	}

	/**
	 * Maps the familiar update fields onto the adaptive profile, following the
	 * adaptive convention: `instructions` is the lens purpose, and the phase
	 * fields (`observeInstructions`, `understandInstructions`, `focus`) are
	 * carried as labelled developer instructions. Directives added by `adjust`
	 * are kept. The new
	 * profile is activated first; the neuron's identity fields are then
	 * written so restore sees a consistent pair.
	 */
	async #updateAdaptive(
		updates: Partial<TextNeuronConfig>,
	): Promise<{ changedFields: string[] }> {
		const identityKeys = [
			'instructions',
			'observeInstructions',
			'understandInstructions',
			'focus',
		] as const
		const supported = new Set<string>(identityKeys)
		const unsupported = Object.keys(updates).filter(
			(key) =>
				!supported.has(key) &&
				updates[key as keyof TextNeuronConfig] !== undefined,
		)
		if (unsupported.length > 0) {
			throw new Error(
				`adaptive text update supports instructions, observeInstructions, understandInstructions, and focus; not ${unsupported.join(', ')}`,
			)
		}
		const before = {
			instructions: this.state.instructions,
			observeInstructions: this.state.observeInstructions ?? null,
			understandInstructions: this.state.understandInstructions ?? null,
			focus: this.state.focus ?? null,
		}
		const after = { ...before }
		const changedFields: string[] = []
		for (const key of identityKeys) {
			const value = updates[key]
			if (value === undefined || value === before[key]) continue
			if (key === 'instructions') {
				if (typeof value !== 'string' || value.trim().length === 0)
					throw new Error('adaptive text instructions must not be empty')
				after.instructions = value
			} else {
				after[key] = value
			}
			changedFields.push(key)
		}
		if (changedFields.length === 0) return { changedFields }
		const oldProtected = new Set(protectedDeveloperInstructions(before))
		const newProtected = protectedDeveloperInstructions(after)
		await this.#activateAdaptive(
			(configuration): TextLearningConfig => ({
				...configuration,
				lens: {
					...configuration.lens,
					purpose: after.instructions,
					developerInstructions: [
						...newProtected,
						...configuration.lens.developerInstructions.filter(
							(instruction) => !oldProtected.has(instruction),
						),
					],
				},
			}),
		)
		const identityUpdates: Record<string, unknown> = {}
		for (const key of identityKeys)
			if (after[key] !== before[key]) identityUpdates[key] = after[key]
		if (Object.keys(identityUpdates).length > 0)
			await this.setState(identityUpdates as never)
		return { changedFields }
	}

	async #activateAdaptive(
		change: (configuration: TextLearningConfig) => TextLearningConfig,
	): Promise<void> {
		const adaptive = this.#adaptive
		if (adaptive === undefined)
			throw new Error('adaptive text mode is not active')
		const result = await adaptive.updateConfiguration(change)
		if (result.status !== 'activated') {
			throw new Error(
				`adaptive text profile change was not activated: ${result.status}`,
			)
		}
	}

	override async learn(
		batch: unknown[],
		options?: LearnOptions,
	): Promise<LearnOutput> {
		const adaptive = this.#adaptive
		const adaptiveConfig = this.#adaptiveConfig
		if (adaptive === undefined || adaptiveConfig === undefined) {
			return super.learn(batch, options)
		}
		const inputs = batch.map((item) =>
			normalizeAdaptiveInput(item, adaptiveConfig.runtime),
		)
		const learned = await adaptive.learn(inputs)
		if (!options?.forceSynthesize) return learned
		const flushed = await adaptive.flush()
		const result: AdaptiveTextLearnOutput = {
			...learned,
			runs: flushed.runs,
			state: flushed.state,
		}
		return result
	}

	async flush(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		if (this.#adaptive === undefined)
			throw new Error('flush requires adaptive text mode')
		return this.#adaptive.flush(signal)
	}

	async resume(signal?: AbortSignal): Promise<AdaptiveTextFlushOutput> {
		if (this.#adaptive === undefined)
			throw new Error('resume requires adaptive text mode')
		return this.#adaptive.resume(signal)
	}

	async getLearningState(): Promise<AdaptiveTextLearningState> {
		if (this.#adaptive === undefined)
			throw new Error('getLearningState requires adaptive text mode')
		return this.#adaptive.snapshot()
	}

	/**
	 * Construct a fresh TextNeuron and persist its config to the store.
	 * Throws if the store already contains a neuron — use {@link restore}.
	 */
	static async create(
		config: TextNeuronConfig & { llm?: AdaptLLMPlugin },
		parentModels?: ParentModels,
	): Promise<TextNeuron> {
		const neuron = new TextNeuron(config, parentModels)
		if (config.onEvent) neuron.on(config.onEvent)
		await neuron.init({ expect: 'fresh' })
		return neuron
	}

	/**
	 * Restore a previously-persisted TextNeuron from a store.
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
			repairWithFeedback?: TextNeuronConfig['repairWithFeedback']
			maxRepairAttempts?: number
			onEvent?: TextNeuronConfig['onEvent']
			learning?: {
				mode: 'adaptive'
				runtime: AdaptiveTextLearningRuntime
				expectedProfile?: TextProfileSnapshot<TextLearningConfig>
			}
		},
	): Promise<TextNeuron> {
		const store = await resolveNeuronStore(input)
		const durableProfile = await readDurableAdaptiveProfile(
			store,
			runtime?.learning?.runtime,
		)
		if (durableProfile !== undefined && runtime?.learning === undefined) {
			throw new Error(
				'restoring adaptive text learning requires its matching runtime',
			)
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
		const neuron = new TextNeuron({
			store,
			model: runtime?.model ?? RESTORE_PLACEHOLDER_MODEL,
			llm: runtime?.llm,
			repairWithFeedback: runtime?.repairWithFeedback,
			maxRepairAttempts: runtime?.maxRepairAttempts,
			instructions: adaptiveState?.instructions ?? '',
			observeInstructions: adaptiveState?.observeInstructions,
			understandInstructions: adaptiveState?.understandInstructions,
			focus: adaptiveState?.focus,
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

	override async dispose(): Promise<void> {
		await this.#adaptive?.dispose()
		await super.dispose()
	}
}

async function resolveNeuronStore(
	input: string | NeuronStore,
): Promise<NeuronStore> {
	if (typeof input !== 'string') return input
	const { SQLiteNeuronStore } = await import('../../stores/sqlite/node/neuron')
	return new SQLiteNeuronStore(input)
}

function prepareAdaptiveConfig(
	raw: TextNeuronConfig & { llm?: AdaptLLMPlugin },
	learning: AdaptiveTextLearningConfig,
): TextNeuronConfig & { llm?: AdaptLLMPlugin } {
	if (
		raw.observationSchema !== undefined ||
		raw.understandingSchema !== undefined
	) {
		throw new Error(
			'adaptive text mode does not support custom legacy schemas without a registered transform',
		)
	}
	if (raw.governance !== undefined) {
		throw new Error(
			'adaptive text mode does not map legacy governance without an evaluated maintenance profile',
		)
	}
	if (raw.skipObservation === true || raw.skipUnderstand === true) {
		throw new Error(
			'adaptive text mode does not support legacy skip phase flags',
		)
	}
	if (raw.observer !== undefined || raw.understand !== undefined) {
		throw new Error(
			'adaptive text mode requires model profiles instead of legacy phase model overrides',
		)
	}
	const profile = learning.initialProfile
	const neuronId = raw.id ?? profile.bindings.neuron.id
	if (profile.bindings.neuron.id !== neuronId)
		throw new Error('adaptive profile neuron id does not match TextNeuron id')
	if (profile.configuration.lens.purpose !== raw.instructions)
		throw new Error('adaptive lens purpose must equal TextNeuron instructions')
	const required = protectedDeveloperInstructions(raw)
	if (
		required.some(
			(instruction) =>
				!profile.configuration.lens.developerInstructions.includes(instruction),
		)
	) {
		throw new Error(
			'adaptive profile does not preserve all TextNeuron phase instructions',
		)
	}
	return {
		...raw,
		id: neuronId,
		skipObservation: true,
		skipUnderstand: true,
		observationSchema: { type: 'string' },
		understandingSchema: { type: 'string' },
	}
}

export function protectedDeveloperInstructions(
	config: Pick<
		TextNeuronConfig,
		'observeInstructions' | 'understandInstructions' | 'focus'
	>,
): readonly string[] {
	return [
		...(config.observeInstructions
			? [`Observe phase instructions: ${config.observeInstructions}`]
			: []),
		...(config.understandInstructions
			? [`Understand phase instructions: ${config.understandInstructions}`]
			: []),
		...(config.focus ? [`Observe focus: ${config.focus}`] : []),
	]
}

function normalizeAdaptiveInput(
	item: unknown,
	runtime: AdaptiveTextLearningRuntime,
): TextInput {
	if (typeof item === 'string') {
		return {
			deliveryId: runtime.inputIds.next(),
			text: item,
			observedAt: runtime.clock.now(),
		}
	}
	if (typeof item !== 'object' || item === null)
		throw new Error(
			'adaptive text learn accepts only strings or TextInput values',
		)
	const value = item as Partial<TextInput>
	if (
		typeof value.deliveryId !== 'string' ||
		typeof value.text !== 'string' ||
		typeof value.observedAt !== 'string'
	) {
		throw new Error(
			'adaptive TextInput requires deliveryId, text, and observedAt',
		)
	}
	return {
		deliveryId: value.deliveryId,
		text: value.text,
		observedAt: value.observedAt,
		...(value.eventId === undefined ? {} : { eventId: value.eventId }),
		...(value.urgency === undefined ? {} : { urgency: value.urgency }),
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

async function readAdaptiveIdentityState(store: NeuronStore): Promise<{
	instructions: string
	observeInstructions: string | null
	understandInstructions: string | null
	focus: string | null
}> {
	const [instructions, observe, understand, focus] = await Promise.all([
		store.state.get('instructions'),
		store.state.get('observeInstructions'),
		store.state.get('understandInstructions'),
		store.state.get('focus'),
	])
	if (typeof instructions?.value !== 'string')
		throw new Error('adaptive TextNeuron durable instructions are missing')
	return {
		instructions: instructions.value,
		observeInstructions:
			typeof observe?.value === 'string' ? observe.value : null,
		understandInstructions:
			typeof understand?.value === 'string' ? understand.value : null,
		focus: typeof focus?.value === 'string' ? focus.value : null,
	}
}

function sameProfile(
	left: TextProfileSnapshot<TextLearningConfig>,
	right: TextProfileSnapshot<TextLearningConfig>,
): boolean {
	return isDeepStrictEqual(left, right)
}
