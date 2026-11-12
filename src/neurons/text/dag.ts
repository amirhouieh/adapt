import {
	type BudgetClaim,
	defineOperation,
	defineSchema,
	LEARNING_CLOCK_CAPABILITY,
	LEARNING_ID_CAPABILITY,
	LEARNING_MODEL_CAPABILITY,
	type LearningClockCapability,
	type LearningIdCapability,
	type LearningModelCapability,
	type LearningObservation,
	LearningRegistry,
	type LearningResult,
	learningLensValueSchema,
	learningObservationsValueSchema,
	learningResultSchema,
	type NarrativeRecipeConfig,
	type PlanningLimits,
	planRecipe,
	type Recipe,
	type RecipeExecution,
	registerNarrativeRecipe,
	runRecipe,
	stringArrayValueSchema,
	textMemorySnapshotValueSchema,
} from '../../learning'
import type {
	AdaptLLMPlugin,
	AdaptRepairOptions,
	JsonValue,
	LanguageModel,
} from '../../llm'
import type {
	LearningCommitInput,
	LearningCommitResult,
	LearningRevisionRecord,
	NeuronStore,
	ObservationRecord,
	PendingWorkRecord,
	UnderstandingRecord,
} from '../../stores'
import {
	initObserve,
	type ObserveContext,
	type ObserveOutput,
	observe,
} from '../observer'

const TEXT_DAG_OBSERVER_CAPABILITY = 'adapt.text-dag.observer'

export interface StringJsonSchema {
	readonly [key: string]: unknown
	readonly type: 'string'
	readonly description?: string
	readonly minLength?: number
	readonly maxLength?: number
}

export interface TextDagObserverRequest {
	readonly systemPrompt: string
	readonly context: ObserveContext
	readonly observationSchema: StringJsonSchema
	readonly signal: AbortSignal
}

export interface TextDagObserver {
	observe(request: TextDagObserverRequest): Promise<ObserveOutput>
}

export interface TextDagConfig {
	readonly neuronId: string
	readonly memoryId: string
	readonly registryRevision: string
	readonly instructions: string
	readonly purpose: string
	readonly developerConstraints: string
	readonly identityRules?: string
	readonly observationSchema: StringJsonSchema
	readonly understandingSchema: StringJsonSchema
	readonly observe: {
		readonly recipeId: string
		readonly operationId: string
		readonly version: string
	}
	readonly narrative: NarrativeRecipeConfig
	readonly planningLimits: PlanningLimits
	readonly maxProviderCalls: number
}

export interface TextDagDependencies {
	readonly store: NeuronStore
	readonly model: LearningModelCapability
	readonly observer: TextDagObserver
	readonly clock: LearningClockCapability
	readonly ids: LearningIdCapability
	readonly config: TextDagConfig
}

export interface TextDagLearnInput {
	readonly id: string
	readonly text: string
	readonly eventAt?: string
	readonly signal?: AbortSignal
}

export type TextDagLearnStatus =
	| 'changed'
	| 'no_change'
	| 'dismissed'
	| 'deferred'
	| 'duplicate'
	| 'failure'

export interface TextDagLearnOutput {
	readonly status: TextDagLearnStatus
	readonly observeExecution?: RecipeExecution
	readonly narrativeExecution?: RecipeExecution
	readonly observerCommit?: LearningCommitResult
	readonly narrativeCommit?: LearningCommitResult
	readonly observations: readonly LearningObservation[]
	readonly understanding: string
	readonly revisions: LearningRevisionRecord
	readonly error?: string
}

export interface TextDagLearner {
	learn(input: TextDagLearnInput): Promise<TextDagLearnOutput>
	getUnderstanding(): Promise<string>
}

export interface AdaptObserverConfig {
	readonly llm: AdaptLLMPlugin
	readonly model: LanguageModel
	readonly repairOptions?: AdaptRepairOptions
}

/** Uses the existing observer without changing its prompt, schema, or temperature. */
export function createAdaptTextDagObserver(
	config: AdaptObserverConfig,
): TextDagObserver {
	return {
		observe(request) {
			return observe(
				config.llm,
				config.model,
				request.systemPrompt,
				request.context,
				request.observationSchema,
				undefined,
				config.repairOptions,
			)
		},
	}
}

const rawDeliverySchema = defineSchema<TextDagLearnInput>({
	id: 'adapt.text-dag.raw-delivery',
	version: '1',
	parse(value) {
		if (typeof value !== 'object' || value === null) {
			throw new Error('raw delivery must be an object')
		}
		const input = value as Record<string, unknown>
		if (typeof input.id !== 'string' || input.id.length === 0) {
			throw new Error('raw delivery id is required')
		}
		if (typeof input.text !== 'string') {
			throw new Error('raw delivery text must be a string')
		}
		if (input.eventAt !== undefined && typeof input.eventAt !== 'string') {
			throw new Error('raw delivery eventAt must be a string')
		}
		return {
			id: input.id,
			text: input.text,
			...(input.eventAt === undefined ? {} : { eventAt: input.eventAt }),
		}
	},
})

const observeConfigurationSchema = defineSchema<{
	readonly neuronId: string
	readonly instructions: string
	readonly systemPrompt: string
	readonly observationSchema: StringJsonSchema
}>({
	id: 'adapt.text-dag.observe-configuration',
	version: '1',
	parse(value) {
		if (typeof value !== 'object' || value === null) {
			throw new Error('observe configuration must be an object')
		}
		const config = value as Record<string, unknown>
		if (
			typeof config.neuronId !== 'string' ||
			typeof config.instructions !== 'string' ||
			typeof config.systemPrompt !== 'string'
		) {
			throw new Error(
				'observe configuration requires string identities and prompts',
			)
		}
		assertStringSchema(config.observationSchema, 'observationSchema')
		return config as {
			readonly neuronId: string
			readonly instructions: string
			readonly systemPrompt: string
			readonly observationSchema: StringJsonSchema
		}
	},
})

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive safe integer`)
	}
}

function assertString(value: string, name: string): void {
	if (value.length === 0) throw new Error(`${name} is required`)
}

function assertStringSchema(
	value: unknown,
	name: string,
): asserts value is StringJsonSchema {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		throw new Error(`${name} must be a string JSON schema`)
	}
	if ((value as { type?: unknown }).type !== 'string') {
		throw new Error(`${name} must declare type string`)
	}
}

function validateConfig(config: TextDagConfig): void {
	for (const [name, value] of [
		['neuronId', config.neuronId],
		['memoryId', config.memoryId],
		['registryRevision', config.registryRevision],
		['instructions', config.instructions],
		['purpose', config.purpose],
		['observe.recipeId', config.observe.recipeId],
		['observe.operationId', config.observe.operationId],
		['observe.version', config.observe.version],
	] as const) {
		assertString(value, name)
	}
	assertStringSchema(config.observationSchema, 'observationSchema')
	assertStringSchema(config.understandingSchema, 'understandingSchema')
	assertPositiveInteger(config.maxProviderCalls, 'maxProviderCalls')
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function capabilities(dependencies: TextDagDependencies) {
	const values = new Map<string, unknown>([
		[LEARNING_MODEL_CAPABILITY, dependencies.model],
		[LEARNING_CLOCK_CAPABILITY, dependencies.clock],
		[LEARNING_ID_CAPABILITY, dependencies.ids],
		[TEXT_DAG_OBSERVER_CAPABILITY, dependencies.observer],
	])
	return {
		has: (id: string) => values.has(id),
		get: <T>(id: string) => values.get(id) as T | undefined,
	}
}

function executionBudget(config: TextDagConfig) {
	const claims: BudgetClaim[] = []
	return {
		claim(claim: BudgetClaim) {
			const used = claims
				.filter(({ kind }) => kind === claim.kind)
				.reduce((total, item) => total + item.amount, 0)
			const maximum =
				claim.kind === 'provider_call'
					? config.maxProviderCalls
					: claim.kind === 'collection_item'
						? config.planningLimits.maxCollectionItems
						: config.planningLimits.maxOperations
			if (used + claim.amount > maximum) return false
			claims.push(claim)
			return true
		},
		snapshot: () => ({ claims: [...claims] }),
	}
}

function pendingWork(
	dependencies: TextDagDependencies,
	inputIds: readonly string[],
	now: string,
	inputs?: Array<{ id: string; text: string }>,
): PendingWorkRecord {
	return {
		id: dependencies.ids.next('pending-work'),
		attempt_id: dependencies.ids.next('learning-attempt'),
		input_ids: [...inputIds],
		...(inputs === undefined ? {} : { inputs }),
		status: 'pending',
		retry_count: 0,
		available_at: now,
		created_at: now,
		updated_at: now,
	}
}

function history(
	dependencies: TextDagDependencies,
	work: PendingWorkRecord,
	result: {
		readonly outcome: 'change' | 'no-change'
		readonly previousRevision: number
		readonly nextRevision: number
		readonly configRevision: number
		readonly inputIds: readonly string[]
		readonly explanation?: string
	},
	now: string,
) {
	return {
		id: dependencies.ids.next('learning-history'),
		attempt_id: work.attempt_id,
		outcome: result.outcome,
		previous_memory_revision: result.previousRevision,
		memory_revision: result.nextRevision,
		config_revision: result.configRevision,
		input_ids: [...result.inputIds],
		change_ids: [],
		...(result.explanation === undefined
			? {}
			: { explanation: result.explanation }),
		created_at: now,
	}
}

function observeDiagnostics(result: LearningResult): {
	readonly observer?: ObserveOutput
	readonly observations?: readonly LearningObservation[]
} {
	if (
		!('diagnostics' in result) ||
		typeof result.diagnostics !== 'object' ||
		result.diagnostics === null
	) {
		return {}
	}
	return result.diagnostics as {
		readonly observer?: ObserveOutput
		readonly observations?: readonly LearningObservation[]
	}
}

function registerObserveRecipe(
	registry: LearningRegistry,
	config: TextDagConfig,
): Recipe {
	const operation = {
		id: config.observe.operationId,
		version: config.observe.version,
	}
	registry.registerOperation(
		defineOperation({
			...operation,
			inputSchemas: { delivery: rawDeliverySchema },
			outputSchemas: { result: learningResultSchema },
			configurationSchema: observeConfigurationSchema,
			requiredCapabilities: [
				TEXT_DAG_OBSERVER_CAPABILITY,
				LEARNING_ID_CAPABILITY,
				LEARNING_CLOCK_CAPABILITY,
			],
			memoryTypes: ['text'],
			async run(
				{ delivery },
				context,
			): Promise<{ readonly result: LearningResult }> {
				const settings = context.configuration as {
					readonly neuronId: string
					readonly instructions: string
					readonly systemPrompt: string
					readonly observationSchema: StringJsonSchema
				}
				if (
					!context.budget.claim({
						kind: 'provider_call',
						amount: 1,
						nodeId: operation.id,
					})
				) {
					return {
						result: {
							outcome: 'defer',
							reason: 'observer provider budget is exhausted',
							pendingInputIds: [delivery.id],
						},
					}
				}
				const observer = context.capabilities.get<TextDagObserver>(
					TEXT_DAG_OBSERVER_CAPABILITY,
				)
				const ids = context.capabilities.get<LearningIdCapability>(
					LEARNING_ID_CAPABILITY,
				)
				const clock = context.capabilities.get<LearningClockCapability>(
					LEARNING_CLOCK_CAPABILITY,
				)
				if (
					observer === undefined ||
					ids === undefined ||
					clock === undefined
				) {
					throw new Error('observe runtime capabilities are unavailable')
				}
				const observed = await observer.observe({
					systemPrompt: settings.systemPrompt,
					context: {
						neuronId: settings.neuronId,
						instructions: settings.instructions,
						data: [delivery.text],
					},
					observationSchema: settings.observationSchema,
					signal: context.signal,
				})
				if (observed.status === 'error') {
					return {
						result: {
							outcome: 'failure',
							code: 'observer_failed',
							reason: errorMessage(observed.error),
							retryable: true,
							diagnostics: { observer: observed },
						},
					}
				}
				if (observed.status === 'dismissed') {
					return {
						result: {
							outcome: 'no_change',
							reason: 'observer dismissed the raw delivery',
							consumedInputIds: [delivery.id],
							pendingInputIds: [],
							diagnostics: { observer: observed, observations: [] },
						},
					}
				}
				const observedAt = clock.now()
				const observations = observed.output.map(
					(text): LearningObservation => {
						if (typeof text !== 'string') {
							throw new Error(
								'string observer returned a non-string observation',
							)
						}
						return {
							id: ids.next('observation'),
							text,
							observedAt,
							...(delivery.eventAt === undefined
								? {}
								: { eventAt: delivery.eventAt }),
						}
					},
				)
				return {
					result:
						observations.length === 0
							? {
									outcome: 'no_change' as const,
									reason: 'observer returned no derived observations',
									consumedInputIds: [delivery.id],
									pendingInputIds: [],
									diagnostics: { observer: observed, observations },
								}
							: {
									outcome: 'change' as const,
									patch: { kind: 'derived_observations' },
									expectedMemoryRevision: context.revisions.memory,
									expectedConfigurationRevision:
										context.revisions.configuration,
									consumedInputIds: [delivery.id],
									pendingInputIds: [],
									diagnostics: { observer: observed, observations },
								},
				}
			},
		}),
	)
	const recipe: Recipe = {
		id: config.observe.recipeId,
		version: config.observe.version,
		memoryTypes: ['text'],
		nodes: [
			{
				kind: 'operation',
				id: 'observe',
				operation,
				inputs: { delivery: { source: 'root', root: 'delivery' } },
				configuration: {
					neuronId: config.neuronId,
					instructions: config.instructions,
					systemPrompt: initObserve(config.instructions).systemPrompt,
					observationSchema: config.observationSchema,
				},
			},
		],
		result: { source: 'node', nodeId: 'observe', output: 'result' },
	}
	registry.registerRecipe(recipe)
	return recipe
}

function observationRecord(
	observation: LearningObservation,
	importance: number,
): ObservationRecord {
	return {
		id: observation.id,
		data: observation.text,
		metadata_importance: importance,
		metadata_tokens: Math.ceil(observation.text.length / 4),
		metadata_status: 'pending',
		metadata_created_at: observation.observedAt,
	}
}

async function understandingRecord(
	store: NeuronStore,
	memoryId: string,
	text: string,
	now: string,
): Promise<UnderstandingRecord> {
	const current = await store.understanding.get(memoryId)
	return {
		id: memoryId,
		data: text,
		metadata_confidence: null,
		metadata_confidence_provenance: 'unknown',
		metadata_created_at: current?.metadata_created_at ?? now,
		metadata_updated_at: now,
	}
}

export function createTextDagLearner(
	dependencies: TextDagDependencies,
): TextDagLearner {
	validateConfig(dependencies.config)
	const registry = new LearningRegistry()
	const observeRecipe = registerObserveRecipe(registry, dependencies.config)
	const narrativeRecipe = registerNarrativeRecipe(
		registry,
		dependencies.config.narrative,
	)
	const capabilityResolver = capabilities(dependencies)

	async function getUnderstanding(): Promise<string> {
		const record = await dependencies.store.understanding.get(
			dependencies.config.memoryId,
		)
		if (record === undefined) return ''
		if (typeof record.data !== 'string') {
			throw new Error('stored text understanding is not a string')
		}
		return record.data
	}

	async function output(
		status: TextDagLearnStatus,
		partial: Omit<TextDagLearnOutput, 'status' | 'understanding' | 'revisions'>,
	): Promise<TextDagLearnOutput> {
		return {
			status,
			...partial,
			understanding: await getUnderstanding(),
			revisions: await dependencies.store.learning.getRevisions(),
		}
	}

	async function learn(input: TextDagLearnInput): Promise<TextDagLearnOutput> {
		const delivery = rawDeliverySchema.parse(input)
		const signal = input.signal ?? new AbortController().signal
		const queuedAt = dependencies.clock.now()
		const observerWork = pendingWork(dependencies, [delivery.id], queuedAt, [
			{ id: delivery.id, text: delivery.text },
		])
		const observerEnqueue = await dependencies.store.learning.enqueue({
			work: observerWork,
		})
		if (observerEnqueue.status === 'deduplicated') {
			return output('duplicate', { observations: [] })
		}
		if (observerEnqueue.status !== 'queued') {
			return output('failure', {
				observations: [],
				error:
					observerEnqueue.status === 'failure'
						? observerEnqueue.error
						: observerEnqueue.reason,
			})
		}

		const observeRevisions = await dependencies.store.learning.getRevisions()
		const observePlan = planRecipe(registry, {
			recipe: observeRecipe,
			roots: { delivery: { schema: rawDeliverySchema, value: delivery } },
			memoryType: 'text',
			availableCapabilities: new Set([
				TEXT_DAG_OBSERVER_CAPABILITY,
				LEARNING_ID_CAPABILITY,
				LEARNING_CLOCK_CAPABILITY,
			]),
			revisions: {
				memory: observeRevisions.memory_revision,
				configuration: observeRevisions.config_revision,
				registry: dependencies.config.registryRevision,
			},
			limits: dependencies.config.planningLimits,
		})
		const observeExecution = await runRecipe(observePlan, {
			capabilities: capabilityResolver,
			budget: executionBudget(dependencies.config),
			signal,
		})
		const diagnostics = observeDiagnostics(observeExecution.result)
		const observations = diagnostics.observations ?? []
		if (observeExecution.result.outcome === 'failure') {
			return output('failure', {
				observeExecution,
				observations,
				error: observeExecution.result.reason,
			})
		}
		if (observeExecution.result.outcome === 'defer') {
			return output('deferred', { observeExecution, observations })
		}

		const observed = diagnostics.observer
		const observerChanged = observations.length > 0
		const observerCommittedAt = dependencies.clock.now()
		const observerOutcome = observerChanged ? 'change' : 'no-change'
		const observerCommitInput: LearningCommitInput = {
			logical_attempt_id: observerWork.attempt_id,
			pending_work_id: observerWork.id,
			expected_memory_revision: observeRevisions.memory_revision,
			expected_config_revision: observeRevisions.config_revision,
			input_ids: [delivery.id],
			outcome: observerOutcome,
			...(observerChanged
				? {
						observations: {
							add: observations.map((observation) =>
								observationRecord(
									observation,
									observed?.status === 'observed' ? observed.importance : 0.5,
								),
							),
							mark_processed_ids: [],
						},
					}
				: {}),
			history: history(
				dependencies,
				observerWork,
				{
					outcome: observerOutcome,
					previousRevision: observeRevisions.memory_revision,
					nextRevision:
						observeRevisions.memory_revision + (observerChanged ? 1 : 0),
					configRevision: observeRevisions.config_revision,
					inputIds: [delivery.id],
				},
				observerCommittedAt,
			),
			changes: [],
			outbox: [],
			committed_at: observerCommittedAt,
		}
		const observerCommit =
			await dependencies.store.learning.commit(observerCommitInput)
		if (
			observerCommit.status === 'failure' ||
			observerCommit.status === 'conflict'
		) {
			return output('failure', {
				observeExecution,
				observerCommit,
				observations,
				error:
					observerCommit.status === 'failure'
						? observerCommit.error
						: observerCommit.reason,
			})
		}
		if (!observerChanged) {
			return output('dismissed', {
				observeExecution,
				observerCommit,
				observations,
			})
		}

		const synthesisQueuedAt = dependencies.clock.now()
		const narrativeWork = pendingWork(
			dependencies,
			observations.map(({ id }) => id),
			synthesisQueuedAt,
		)
		const narrativeEnqueue = await dependencies.store.learning.enqueue({
			work: narrativeWork,
		})
		if (narrativeEnqueue.status !== 'queued') {
			return output('failure', {
				observeExecution,
				observerCommit,
				observations,
				error:
					narrativeEnqueue.status === 'failure'
						? narrativeEnqueue.error
						: narrativeEnqueue.status === 'conflict'
							? narrativeEnqueue.reason
							: 'derived observations were already queued',
			})
		}

		const narrativeRevisions = await dependencies.store.learning.getRevisions()
		const currentText = await getUnderstanding()
		const processed = await dependencies.store.processedInputs.list()
		const narrativePlan = planRecipe(registry, {
			recipe: narrativeRecipe,
			roots: {
				lens: {
					schema: learningLensValueSchema,
					value: {
						purpose: dependencies.config.purpose,
						memoryType: 'text',
						schema: dependencies.config.understandingSchema as JsonValue,
						developerConstraints: dependencies.config.developerConstraints,
						...(dependencies.config.identityRules === undefined
							? {}
							: { identityRules: dependencies.config.identityRules }),
					},
				},
				memory: {
					schema: textMemorySnapshotValueSchema,
					value: {
						id: dependencies.config.memoryId,
						revision: narrativeRevisions.memory_revision,
						text: currentText,
						processedInputIds: processed.map(({ id }) => id),
					},
				},
				observations: {
					schema: learningObservationsValueSchema,
					value: observations,
				},
				processedInputIds: {
					schema: stringArrayValueSchema,
					value: processed.map(({ id }) => id),
				},
			},
			memoryType: 'text',
			availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
			revisions: {
				memory: narrativeRevisions.memory_revision,
				configuration: narrativeRevisions.config_revision,
				registry: dependencies.config.registryRevision,
			},
			limits: dependencies.config.planningLimits,
		})
		const narrativeExecution = await runRecipe(narrativePlan, {
			capabilities: capabilityResolver,
			budget: executionBudget(dependencies.config),
			signal,
		})
		if (narrativeExecution.result.outcome === 'failure') {
			return output('failure', {
				observeExecution,
				observerCommit,
				narrativeExecution,
				observations,
				error: narrativeExecution.result.reason,
			})
		}

		const consumed = new Set(narrativeExecution.result.consumedInputIds ?? [])
		const consumedIds = observations
			.map(({ id }) => id)
			.filter((id) => consumed.has(id))
		const remainingIds = observations
			.map(({ id }) => id)
			.filter((id) => !consumed.has(id))
		if (consumedIds.length === 0) {
			return output('deferred', {
				observeExecution,
				observerCommit,
				narrativeExecution,
				observations,
			})
		}

		const narrativeCommittedAt = dependencies.clock.now()
		const patch =
			narrativeExecution.result.outcome === 'change'
				? (narrativeExecution.result.patch as {
						readonly kind: 'replace_text'
						readonly memoryId: string
						readonly text: string
					})
				: undefined
		if (
			patch !== undefined &&
			(patch.kind !== 'replace_text' ||
				patch.memoryId !== dependencies.config.memoryId ||
				typeof patch.text !== 'string')
		) {
			return output('failure', {
				observeExecution,
				observerCommit,
				narrativeExecution,
				observations,
				error: 'narrative recipe returned an invalid text patch',
			})
		}
		const storeOutcome = 'change' as const
		const nextRevision = narrativeRevisions.memory_revision + 1
		const narrativeCommitInput: LearningCommitInput = {
			logical_attempt_id: narrativeWork.attempt_id,
			pending_work_id: narrativeWork.id,
			expected_memory_revision: narrativeRevisions.memory_revision,
			expected_config_revision: narrativeRevisions.config_revision,
			input_ids: consumedIds,
			...(remainingIds.length === 0
				? {}
				: {
						remaining_work: {
							id: dependencies.ids.next('pending-work'),
							attempt_id: dependencies.ids.next('learning-attempt'),
							input_ids: remainingIds,
							status: 'pending' as const,
							retry_count: 0,
							available_at: narrativeCommittedAt,
							created_at: narrativeCommittedAt,
							updated_at: narrativeCommittedAt,
						},
					}),
			outcome: storeOutcome,
			...(patch === undefined
				? {}
				: {
						patch: {
							type: 'replace' as const,
							records: [
								await understandingRecord(
									dependencies.store,
									dependencies.config.memoryId,
									patch.text,
									narrativeCommittedAt,
								),
							],
						},
					}),
			observations: {
				add: [],
				mark_processed_ids: consumedIds,
			},
			history: history(
				dependencies,
				narrativeWork,
				{
					outcome: storeOutcome,
					previousRevision: narrativeRevisions.memory_revision,
					nextRevision,
					configRevision: narrativeRevisions.config_revision,
					inputIds: consumedIds,
					...('explanation' in narrativeExecution.result &&
					typeof narrativeExecution.result.explanation === 'string'
						? { explanation: narrativeExecution.result.explanation }
						: {}),
				},
				narrativeCommittedAt,
			),
			changes: [],
			outbox: [],
			committed_at: narrativeCommittedAt,
		}
		const narrativeCommit =
			await dependencies.store.learning.commit(narrativeCommitInput)
		if (
			narrativeCommit.status === 'failure' ||
			narrativeCommit.status === 'conflict'
		) {
			return output('failure', {
				observeExecution,
				observerCommit,
				narrativeExecution,
				narrativeCommit,
				observations,
				error:
					narrativeCommit.status === 'failure'
						? narrativeCommit.error
						: narrativeCommit.reason,
			})
		}
		return output(
			narrativeExecution.result.outcome === 'change'
				? 'changed'
				: narrativeExecution.result.outcome === 'defer'
					? 'deferred'
					: 'no_change',
			{
				observeExecution,
				observerCommit,
				narrativeExecution,
				narrativeCommit,
				observations,
			},
		)
	}

	return { learn, getUnderstanding }
}
