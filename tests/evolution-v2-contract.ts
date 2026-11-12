import type {
	BrainMemoryMappingRecord,
	BrainRegistryLensRecord,
	BrainStore,
	NeuronStore,
	NeuronStoreSnapshot,
} from '../src/stores'
import {
	activateEvolution,
	EvolutionActivationInterruption,
	initializeEvolutionRegistry,
	neuronStoreSnapshotDigest,
	pinEvolutionRegistry,
	pruneEvolutionStages,
	readNeuronStoreSnapshot,
	recoverEvolutionActivation,
} from '../src/brain/evolution/activation'
import type {
	EvolutionActivationInput,
	EvolutionLensDefinition,
	EvolutionPolicy,
	EvolutionProposal,
	EvolutionRunControl,
	ValidatedEvolutionProposal,
} from '../src/brain/evolution/contracts'
import { validateEvolutionProposal } from '../src/brain/evolution/validation'

interface TestApi {
	describe: (name: string, fn: () => void) => void
	it: (name: string, fn: () => Promise<void> | void) => void
	expect: any
}

export interface EvolutionStoreScenario {
	create(): BrainStore
	restart(store: BrainStore): Promise<BrainStore>
	cleanup(): void
}

const fixture = {
	time: {
		created: '2026-09-30T10:00:00.000Z',
		updated: '2026-09-30T10:01:00.000Z',
		later: '2026-09-30T10:02:00.000Z',
	},
	ids: {
		baseRegistry: 'registry-0',
		targetRegistry: 'registry-1',
		sourceLens: 'journal',
		unaffectedLens: 'archive',
		sourceStore: 'journal-store-0',
		targetStore: 'journal-store-1',
		unaffectedStore: 'archive-store-0',
		activation: 'activation-1',
		proposal: 'proposal-1',
		stage: 'stage-1',
		mapping: 'mapping-1',
	},
	text: {
		memory: 'The user requires an auditable approval trail.',
		observation: 'Require an auditable approval trail.',
		pending: 'Clarify which approvals require two reviewers.',
	},
} as const

const schema = { id: 'narrative-memory', version: '1' }
const recipe = { id: 'narrative-recipe', version: '1' }
const updatedRecipe = { id: 'narrative-recipe', version: '2' }
const constraints = {
	instructions: ['Retain source attribution.'],
	local_only: true,
	provider_permissions: ['local-model'],
}

function lens(
	id: string,
	recipeRef = recipe,
): EvolutionLensDefinition {
	return {
		id,
		name: id,
		description: `Memory lens ${id}`,
		type: 'text',
		memory_schema: schema,
		recipe: recipeRef,
		recipe_composition: [recipeRef],
		dependencies: [],
		settings: { max_items: 20 },
		developer_constraints: constraints,
	}
}

function storedLens(
	definition: EvolutionLensDefinition,
	physicalStoreId: string,
): BrainRegistryLensRecord {
	return {
		id: definition.id,
		physical_store_id: physicalStoreId,
		type: definition.type,
		config: structuredClone(definition),
		dependencies: [...definition.dependencies],
	}
}

const policy: EvolutionPolicy = {
	available_capabilities: ['local-model'],
	creation_constraints: constraints,
	setting_bounds: [
		{ key: 'max_items', kind: 'integer', minimum: 1, maximum: 100 },
	],
	protected_lens_ids: [],
	required_regression_checks: {
		create: ['mechanical'],
		update: ['mechanical'],
		merge: ['mechanical'],
		split: ['mechanical'],
		delete: ['mechanical'],
	},
	max_evidence: 10,
	max_catalogue_entries: 20,
	max_lenses: 10,
	max_dependencies_per_lens: 5,
	max_recipe_steps: 5,
	max_prompt_chars: 20_000,
	max_evidence_chars: 5_000,
	max_catalogue_chars: 10_000,
	max_constraint_chars: 2_000,
	allowed_deletion_modes: ['lens-only', 'lens-and-retained-knowledge'],
}

const catalogue = {
	recipes: [
		{ ...recipe, memory_types: ['text'], required_capabilities: [] },
		{ ...updatedRecipe, memory_types: ['text'], required_capabilities: [] },
	],
	compositions: [
		{ id: 'composition-v1', recipes: [recipe], max_steps: 1 },
		{ id: 'composition-v2', recipes: [updatedRecipe], max_steps: 1 },
	],
	transformations: [],
	memory_schemas: [schema],
}

function sourceSnapshot(): NeuronStoreSnapshot {
	return {
		observations: [
			{
				id: 'input-1',
				data: fixture.text.observation,
				metadata_importance: 1,
				metadata_tokens: 7,
				metadata_status: 'processed',
				metadata_created_at: fixture.time.created,
			},
		],
		understanding: [
			{
				id: 'memory-1',
				data: fixture.text.memory,
				metadata_confidence: null,
				metadata_confidence_provenance: 'unknown',
				metadata_created_at: fixture.time.created,
				metadata_updated_at: fixture.time.updated,
			},
		],
		evolution: [
			{
				id: 'evolution-1',
				summary: 'Initial retained memory.',
				significance: 'minor',
				created_at: fixture.time.created,
			},
		],
		state: [
			{ id: 'recipe', value: recipe, updated_at: fixture.time.created },
		],
		learningHistory: [
			{
				id: 'history-1',
				attempt_id: 'attempt-1',
				outcome: 'change',
				previous_memory_revision: 0,
				memory_revision: 1,
				config_revision: 0,
				input_ids: ['input-1'],
				change_ids: ['change-1'],
				explanation: 'Created memory from direct evidence.',
				created_at: fixture.time.created,
			},
		],
		memoryChanges: [
			{
				id: 'change-1',
				attempt_id: 'attempt-1',
				memory_revision: 1,
				kind: 'narrative-revision',
				affected_memory_ids: ['memory-1'],
				summary: 'Created initial memory.',
				created_at: fixture.time.created,
			},
		],
		pendingWork: [
			{
				id: 'work-2',
				attempt_id: 'attempt-2',
				input_ids: ['input-2'],
				inputs: [{ id: 'input-2', text: fixture.text.pending }],
				status: 'pending',
				retry_count: 0,
				available_at: fixture.time.updated,
				created_at: fixture.time.updated,
				updated_at: fixture.time.updated,
			},
		],
		pendingInputs: [
			{
				id: 'input-2',
				pending_work_id: 'work-2',
				attempt_id: 'attempt-2',
				created_at: fixture.time.updated,
			},
		],
		processedInputs: [
			{
				id: 'input-1',
				attempt_id: 'attempt-1',
				outcome: 'change',
				memory_revision: 1,
				processed_at: fixture.time.created,
			},
		],
		outbox: [
			{
				id: 'outbox-1',
				kind: 'memory-change',
				deduplication_key: 'change-1',
				change_ids: ['change-1'],
				status: 'pending',
				attempts: 0,
				available_at: fixture.time.created,
				created_at: fixture.time.created,
				updated_at: fixture.time.created,
			},
		],
		learningAttempts: [
			{
				id: 'attempt-1',
				pending_work_id: 'work-1',
				input_ids: ['input-1'],
				status: 'committed',
				memory_revision: 1,
				config_revision: 0,
				history_id: 'history-1',
				intent_digest: 'fixture-attempt-1',
				created_at: fixture.time.created,
			},
		],
		learningRevisions: [
			{
				id: 'current',
				memory_revision: 1,
				config_revision: 0,
				updated_at: fixture.time.created,
			},
		],
	}
}

async function writeSnapshot(store: NeuronStore, snapshot: NeuronStoreSnapshot): Promise<void> {
	await store.runAtomic((atomic) => {
		for (const [name, records] of Object.entries(snapshot) as Array<
			[keyof NeuronStoreSnapshot, Array<{ id: string }>]
		>) {
			const collection = atomic[name] as {
				clear(): void
				add(record: { id: string }): void
			}
			collection.clear()
			for (const record of records) collection.add(record)
		}
	})
}

async function validatedUpdate(
	source: EvolutionLensDefinition,
	target: EvolutionLensDefinition,
	proposalId = fixture.ids.proposal,
): Promise<ValidatedEvolutionProposal> {
	const proposal: EvolutionProposal = {
		id: proposalId,
		action: 'update',
		reasoning: 'Use the approved updated recipe.',
		trigger_id: 'trigger-1',
		evidence_ids: ['evidence-1'],
		expected_effect: 'Preserve memory while changing the recipe.',
		target_lens_ids: [source.id],
		resulting_lenses: [target],
		regression_check_ids: ['mechanical'],
		created_at: fixture.time.created,
	}
	const result = await validateEvolutionProposal({
		proposal,
		current_registry: [source, lens(fixture.ids.unaffectedLens)],
		evidence_ids: ['evidence-1'],
		catalogue,
		policy,
		checks: [{ id: 'mechanical', run: async () => ({ id: 'mechanical', passed: true }) }],
	})
	if (result.status !== 'valid') throw new Error('fixture proposal must validate')
	return result.value
}

function mapping(activationId: string): BrainMemoryMappingRecord {
	return {
		id: fixture.ids.mapping,
		activation_id: activationId,
		source_lens_id: fixture.ids.sourceLens,
		source_memory_id: 'memory-1',
		target_lens_id: fixture.ids.sourceLens,
		target_memory_id: 'memory-1',
		disposition: 'transferred',
		history: [{ source_history_id: 'history-1', target_history_id: 'history-1' }],
		created_at: fixture.time.updated,
	}
}

async function setupUpdate(store: BrainStore): Promise<EvolutionActivationInput> {
	const source = lens(fixture.ids.sourceLens)
	const unaffected = lens(fixture.ids.unaffectedLens)
	const target = lens(fixture.ids.sourceLens, updatedRecipe)
	const sourceRecord = storedLens(source, fixture.ids.sourceStore)
	const unaffectedRecord = storedLens(unaffected, fixture.ids.unaffectedStore)
	await initializeEvolutionRegistry(store, {
		head_revision_id: fixture.ids.baseRegistry,
		revision: 0,
		lenses: [sourceRecord, unaffectedRecord],
		created_at: fixture.time.created,
	})
	const original = sourceSnapshot()
	await writeSnapshot(store.getNeuronStore(fixture.ids.sourceStore), original)
	const targetSnapshot = structuredClone(original)
	targetSnapshot.learningRevisions[0] = {
		id: 'current',
		memory_revision: 1,
		config_revision: 1,
		updated_at: fixture.time.updated,
	}
	const targetRecord = storedLens(target, fixture.ids.targetStore)
	const validated = await validatedUpdate(source, target)
	return {
		activation_id: fixture.ids.activation,
		mode: 'evolution',
		validated_proposal: validated,
		base_registry_revision_id: fixture.ids.baseRegistry,
		target_registry: {
			id: fixture.ids.targetRegistry,
			revision: 1,
			parent_id: fixture.ids.baseRegistry,
			activation_id: fixture.ids.activation,
			lenses: [targetRecord, unaffectedRecord],
			created_at: fixture.time.updated,
		},
		transformation: {
			id: 'transform-run-1',
			proposal_id: fixture.ids.proposal,
			source_pins: [
				{
					lens_id: fixture.ids.sourceLens,
					physical_store_id: fixture.ids.sourceStore,
					memory_revision: 1,
					config_revision: 0,
					state_digest: neuronStoreSnapshotDigest(original),
				},
			],
			targets: [
				{
					stage_id: fixture.ids.stage,
					lens: targetRecord,
					snapshot: targetSnapshot,
				},
			],
			mappings: [mapping(fixture.ids.activation)],
		},
		staging_policy: {
			max_targets: 3,
			max_snapshot_records: 100,
			max_snapshot_chars: 20_000,
		},
		created_at: fixture.time.created,
		updated_at: fixture.time.updated,
	}
}

class TestRunControl implements EvolutionRunControl {
	readonly events: string[] = []
	private blocked = new Set<string>()
	private waiters: Array<() => void> = []

	async quiesce(lensIds: readonly string[]): Promise<void> {
		for (const id of lensIds) this.blocked.add(id)
		this.events.push('quiesce')
	}

	async waitForIdle(): Promise<void> {
		this.events.push('idle')
	}

	async resume(_lensIds: readonly string[], registryRevisionId: string): Promise<void> {
		this.blocked.clear()
		this.events.push(`resume:${registryRevisionId}`)
		for (const resolve of this.waiters.splice(0)) resolve()
	}

	async mutate(lensId: string, operation: () => Promise<void>): Promise<void> {
		if (this.blocked.has(lensId)) {
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		}
		await operation()
	}
}

export function registerEvolutionStoreContract(
	api: TestApi,
	adapterName: string,
	createScenario: () => EvolutionStoreScenario,
): void {
	const { describe, expect, it } = api

	describe(`${adapterName} evolution activation`, () => {
		it('digests every own JSON key, including __proto__', () => {
			const left = sourceSnapshot()
			const right = sourceSnapshot()
			const leftData = Object.create(null) as Record<string, unknown>
			const rightData = Object.create(null) as Record<string, unknown>
			Object.defineProperty(leftData, '__proto__', {
				value: 'left',
				enumerable: true,
			})
			Object.defineProperty(rightData, '__proto__', {
				value: 'right',
				enumerable: true,
			})
			left.understanding[0]!.data = leftData
			right.understanding[0]!.data = rightData
			expect(neuronStoreSnapshotDigest(left)).not.toBe(
				neuronStoreSnapshotDigest(right),
			)
		})

		it('rejects an unapproved transformation even when the schema is unchanged', async () => {
			const source = lens(fixture.ids.sourceLens)
			const target = lens(fixture.ids.sourceLens, updatedRecipe)
			const result = await validateEvolutionProposal({
				proposal: {
					id: 'proposal-unapproved-transform',
					action: 'update',
					reasoning: 'Attempt an unapproved memory rewrite.',
					trigger_id: 'trigger-1',
					evidence_ids: ['evidence-1'],
					expected_effect: 'Rewrite memory.',
					target_lens_ids: [source.id],
					resulting_lenses: [target],
					transformation: { id: 'unapproved', version: '1' },
					regression_check_ids: ['mechanical'],
					created_at: fixture.time.created,
				},
				current_registry: [source, lens(fixture.ids.unaffectedLens)],
				evidence_ids: ['evidence-1'],
				catalogue,
				policy,
				checks: [
					{ id: 'mechanical', run: async () => ({ id: 'mechanical', passed: true }) },
				],
			})
			expect(result.status).toBe('invalid')
			if (result.status === 'invalid') {
				expect(result.issues.map((issue) => issue.code)).toContain(
					'incompatible-schema',
				)
			}
		})

		it('publishes one authoritative revision and conserves pending and delivery state', async () => {
			const scenario = createScenario()
			let store = scenario.create()
			const input = await setupUpdate(store)
			const control = new TestRunControl()
			let affectedMutationFinished = false
			let unaffectedMutationFinished = false
			let affectedMutation: Promise<void> | undefined
			const result = await activateEvolution(store, input, control, {
				onStage(stage) {
					if (stage === 'quiesced') {
						affectedMutation = control.mutate(fixture.ids.sourceLens, async () => {
							affectedMutationFinished = true
						})
						void control.mutate(fixture.ids.unaffectedLens, async () => {
							unaffectedMutationFinished = true
						})
					}
					if (stage === 'before-registry-cas') {
						expect(affectedMutationFinished).toBe(false)
						expect(unaffectedMutationFinished).toBe(true)
					}
				},
			})
			await affectedMutation
			if (result.status === 'failure') throw new Error(result.error)
			expect(result).toMatchObject({ status: 'activated', deduplicated: false })
			const pinned = await pinEvolutionRegistry(store)
			expect(pinned.revision.id).toBe(fixture.ids.targetRegistry)
			expect(pinned.getLens(fixture.ids.sourceLens)?.physical_store_id).toBe(
				fixture.ids.targetStore,
			)
			const target = store.getNeuronStore(fixture.ids.targetStore)
			expect(await target.pendingWork.get('work-2')).toMatchObject({
				inputs: [{ id: 'input-2', text: fixture.text.pending }],
			})
			expect(await target.pendingInputs.get('input-2')).toBeDefined()
			expect(await target.outbox.get('outbox-1')).toBeDefined()
			expect(await target.processedInputs.get('input-1')).toBeDefined()
			expect(
				(await store.getNeuronStore(fixture.ids.sourceStore).pendingWork.get('work-2'))
					?.inputs,
			).toBeUndefined()
			const duplicate = await activateEvolution(store, input, control)
			expect(duplicate).toMatchObject({ status: 'activated', deduplicated: true })
			const changed: EvolutionActivationInput = {
				...input,
				target_registry: structuredClone(input.target_registry),
				transformation: structuredClone(input.transformation),
				staging_policy: structuredClone(input.staging_policy),
			}
			changed.transformation.targets[0]!.snapshot.understanding[0]!.data = 'forged'
			expect(await activateEvolution(store, changed, control)).toEqual({
				status: 'conflict',
				reason: 'activation-id-reused',
			})
			store = await scenario.restart(store)
			expect((await pinEvolutionRegistry(store)).revision.id).toBe(
				fixture.ids.targetRegistry,
			)
			await store.dispose()
			scenario.cleanup()
		})

		it('recovers the old head before CAS and the new head after CAS', async () => {
			for (const interruptionStage of ['before-registry-cas', 'after-registry-cas'] as const) {
				const scenario = createScenario()
				let store = scenario.create()
				const input = await setupUpdate(store)
				const interrupted = await activateEvolution(
					store,
					input,
					new TestRunControl(),
					{
						onStage(stage) {
							if (stage === interruptionStage) {
								throw new EvolutionActivationInterruption(interruptionStage)
							}
						},
					},
				)
				expect(interrupted.status).toBe('recovery-required')
				const beforeRestart = await pinEvolutionRegistry(store)
				expect(beforeRestart.revision.id).toBe(
					interruptionStage === 'before-registry-cas'
						? fixture.ids.baseRegistry
						: fixture.ids.targetRegistry,
				)
				store = await scenario.restart(store)
				const recovered = await recoverEvolutionActivation(
					store,
					fixture.ids.activation,
					'abandon',
					new TestRunControl(),
				)
				if (interruptionStage === 'before-registry-cas') {
					expect(recovered.status).toBe('failure')
					expect((await pinEvolutionRegistry(store)).revision.id).toBe(
						fixture.ids.baseRegistry,
					)
					expect(
						(await store.getNeuronStore(fixture.ids.sourceStore).pendingWork.get('work-2'))
							?.inputs,
					).toEqual([{ id: 'input-2', text: fixture.text.pending }])
				} else {
					expect(recovered.status).toBe('activated')
					expect((await pinEvolutionRegistry(store)).revision.id).toBe(
						fixture.ids.targetRegistry,
					)
					expect(
						(await store.getNeuronStore(fixture.ids.sourceStore).pendingWork.get('work-2'))
							?.inputs,
					).toBeUndefined()
				}
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('rejects stale memory, changed unaffected storage, and split processing ownership', async () => {
			const variants: Array<(input: EvolutionActivationInput) => void> = [
				(input) => {
					input.target_registry.lenses[1]!.physical_store_id = 'forged-unaffected-store'
				},
				(input) => {
					input.transformation.targets[0]!.snapshot.understanding[0]!.data = 'stale memory'
				},
				(input) => {
					const target = input.transformation.targets[0]!.snapshot
					target.pendingInputs = []
				},
			]
			for (const mutate of variants) {
				const scenario = createScenario()
				const store = scenario.create()
				const input = await setupUpdate(store)
				mutate(input)
				const result = await activateEvolution(store, input, new TestRunControl())
				expect(result.status).toBe('failure')
				expect((await pinEvolutionRegistry(store)).revision.id).toBe(
					fixture.ids.baseRegistry,
				)
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('does not abandon an existing activation after an untrusted same-id call', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			const input = await setupUpdate(store)
			const interrupted = await activateEvolution(
				store,
				input,
				new TestRunControl(),
				{
					onStage(stage) {
						if (stage === 'journaled') {
							throw new EvolutionActivationInterruption('journaled')
						}
					},
				},
			)
			expect(interrupted.status).toBe('recovery-required')
			const forged = structuredClone(input)
			const forgedResult = await activateEvolution(store, forged, new TestRunControl())
			expect(forgedResult.status).toBe('failure')
			expect((await store.evolutionActivations.get(fixture.ids.activation))?.status).toBe(
				'preparing',
			)
			await store.dispose()
			scenario.cleanup()
		})

		it('cleans an abandoned unpublished store before pruning its durable stage name', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			const input = await setupUpdate(store)
			const interrupted = await activateEvolution(
				store,
				input,
				new TestRunControl(),
				{
					onStage(stage) {
						if (stage === 'before-registry-cas') {
							throw new EvolutionActivationInterruption('before CAS')
						}
					},
				},
			)
			expect(interrupted.status).toBe('recovery-required')
			await recoverEvolutionActivation(
				store,
				fixture.ids.activation,
				'abandon',
				new TestRunControl(),
			)
			expect(
				(await readNeuronStoreSnapshot(store.getNeuronStore(fixture.ids.targetStore)))
					.understanding.length,
			).toBe(1)
			const pruned = await pruneEvolutionStages(store, { max_terminal_stages: 0 })
			expect(pruned.deleted_stage_ids).toEqual([fixture.ids.stage])
			expect(
				(await readNeuronStoreSnapshot(store.getNeuronStore(fixture.ids.targetStore)))
					.understanding.length,
			).toBe(0)
			await store.dispose()
			scenario.cleanup()
		})

		it('rolls configuration forward without erasing learning committed after activation', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			const first = await setupUpdate(store)
			expect(
				(await activateEvolution(store, first, new TestRunControl())).status,
			).toBe('activated')
			const activeStore = store.getNeuronStore(fixture.ids.targetStore)
			const learnedText = 'The user requires two reviewers for financial approvals.'
			const learned = await activeStore.learning.commit({
				logical_attempt_id: 'attempt-2',
				pending_work_id: 'work-2',
				expected_memory_revision: 1,
				expected_config_revision: 1,
				input_ids: ['input-2'],
				outcome: 'change',
				patch: {
					type: 'operations',
					upsert: [
						{
							id: 'memory-1',
							data: learnedText,
							metadata_confidence: null,
							metadata_confidence_provenance: 'unknown',
							metadata_created_at: fixture.time.created,
							metadata_updated_at: fixture.time.later,
						},
					],
					delete_ids: [],
				},
				history: {
					id: 'history-2',
					attempt_id: 'attempt-2',
					outcome: 'change',
					previous_memory_revision: 1,
					memory_revision: 2,
					config_revision: 1,
					input_ids: ['input-2'],
					change_ids: ['change-2'],
					created_at: fixture.time.later,
				},
				changes: [
					{
						id: 'change-2',
						attempt_id: 'attempt-2',
						memory_revision: 2,
						kind: 'narrative-revision',
						affected_memory_ids: ['memory-1'],
						created_at: fixture.time.later,
					},
				],
				outbox: [
					{
						id: 'outbox-2',
						kind: 'memory-change',
						deduplication_key: 'change-2',
						change_ids: ['change-2'],
						status: 'pending',
						attempts: 0,
						available_at: fixture.time.later,
						created_at: fixture.time.later,
						updated_at: fixture.time.later,
					},
				],
				committed_at: fixture.time.later,
			})
			expect(learned.status).toBe('committed')

			const current = await readNeuronStoreSnapshot(activeStore)
			const updated = lens(fixture.ids.sourceLens, updatedRecipe)
			const original = lens(fixture.ids.sourceLens)
			const validated = await validatedUpdate(
				updated,
				original,
				'proposal-rollback',
			)
			const rollbackSnapshot = structuredClone(current)
			rollbackSnapshot.learningRevisions[0] = {
				id: 'current',
				memory_revision: 2,
				config_revision: 2,
				updated_at: fixture.time.later,
			}
			const rollbackLens = storedLens(original, 'journal-store-2')
			const rollback: EvolutionActivationInput = {
				activation_id: 'activation-rollback',
				mode: 'rollback',
				validated_proposal: validated,
				base_registry_revision_id: fixture.ids.targetRegistry,
				target_registry: {
					id: 'registry-2',
					revision: 2,
					parent_id: fixture.ids.targetRegistry,
					activation_id: 'activation-rollback',
					lenses: [
						rollbackLens,
						storedLens(lens(fixture.ids.unaffectedLens), fixture.ids.unaffectedStore),
					],
					created_at: fixture.time.later,
				},
				transformation: {
					id: 'transform-rollback',
					proposal_id: 'proposal-rollback',
					source_pins: [
						{
							lens_id: fixture.ids.sourceLens,
							physical_store_id: fixture.ids.targetStore,
							memory_revision: 2,
							config_revision: 1,
							state_digest: neuronStoreSnapshotDigest(current),
						},
					],
					targets: [
						{ stage_id: 'stage-rollback', lens: rollbackLens, snapshot: rollbackSnapshot },
					],
					mappings: [
						{
							id: 'mapping-rollback',
							activation_id: 'activation-rollback',
							source_lens_id: fixture.ids.sourceLens,
							source_memory_id: 'memory-1',
							target_lens_id: fixture.ids.sourceLens,
							target_memory_id: 'memory-1',
							disposition: 'transferred',
							history: [
								{ source_history_id: 'history-1', target_history_id: 'history-1' },
								{ source_history_id: 'history-2', target_history_id: 'history-2' },
							],
							created_at: fixture.time.later,
						},
					],
				},
				staging_policy: first.staging_policy,
				created_at: fixture.time.later,
				updated_at: fixture.time.later,
			}
			expect(
				(await activateEvolution(store, rollback, new TestRunControl())).status,
			).toBe('activated')
			const pinned = await pinEvolutionRegistry(store)
			expect(pinned.revision.id).toBe('registry-2')
			const visible = store.getNeuronStore(
				pinned.getLens(fixture.ids.sourceLens)!.physical_store_id,
			)
			expect((await visible.understanding.get('memory-1'))?.data).toBe(learnedText)
			await store.dispose()
			scenario.cleanup()
		})

	})
}
