import { describe, expect, it } from 'vitest'
import {
	activateEvolution,
	initializeEvolutionRegistry,
	neuronStoreSnapshotDigest,
	pruneEvolutionStages,
	readNeuronStoreSnapshot,
	validateEvolutionProposal,
	type EvolutionActivationInput,
	type EvolutionCatalogue,
	type EvolutionLensDefinition,
	type EvolutionPolicy,
	type EvolutionProposal,
	type EvolutionRunControl,
	type EvolutionTransformationValidator,
} from '../src/brain/evolution'
import {
	MemoryBrainStore,
	type BrainRegistryLensRecord,
	type NeuronStore,
	type NeuronStoreSnapshot,
} from '../src/stores'

const at = '2026-09-30T12:00:00.000Z'
const later = '2026-09-30T12:01:00.000Z'
const schema = { id: 'memory-schema', version: '1' }
const recipe = { id: 'recipe', version: '1' }
const splitTransformation = { id: 'split-transform', version: '1' }
const constraints = {
	instructions: ['Retain only supplied facts.'],
	local_only: true,
	provider_permissions: [],
}

function lens(id: string): EvolutionLensDefinition {
	return {
		id,
		name: id,
		description: `${id} memory`,
		type: 'text',
		memory_schema: schema,
		recipe,
		recipe_composition: [],
		dependencies: [],
		settings: {},
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
		config: definition,
		dependencies: definition.dependencies,
	}
}

const policy: EvolutionPolicy = {
	available_capabilities: [],
	creation_constraints: constraints,
	setting_bounds: [],
	protected_lens_ids: [],
	required_regression_checks: {
		create: [],
		update: [],
		merge: [],
		split: [],
		delete: [],
	},
	max_evidence: 8,
	max_catalogue_entries: 8,
	max_lenses: 8,
	max_dependencies_per_lens: 4,
	max_recipe_steps: 4,
	max_prompt_chars: 4000,
	max_evidence_chars: 4000,
	max_catalogue_chars: 4000,
	max_constraint_chars: 4000,
	allowed_deletion_modes: ['lens-only', 'lens-and-retained-knowledge'],
}

function catalogue(includeSplit: boolean): EvolutionCatalogue {
	return {
		recipes: [{ ...recipe, memory_types: ['text'], required_capabilities: [] }],
		compositions: [{ id: 'empty', recipes: [], max_steps: 1 }],
		transformations: includeSplit
			? [
					{
						...splitTransformation,
						source_schemas: [schema],
						target_schemas: [schema, schema],
					},
				]
			: [],
		memory_schemas: [schema],
	}
}

async function validatedProposal(
	proposal: EvolutionProposal,
	currentRegistry: EvolutionLensDefinition[],
) {
	const result = await validateEvolutionProposal({
		proposal,
		current_registry: currentRegistry,
		evidence_ids: ['evidence'],
		catalogue: catalogue(proposal.action === 'split'),
		policy,
		checks: [],
	})
	if (result.status !== 'valid') {
		throw new Error(`invalid test proposal: ${JSON.stringify(result.issues)}`)
	}
	return result.value
}

function emptySnapshot(memoryRevision = 0, configRevision = 0): NeuronStoreSnapshot {
	return {
		observations: [],
		understanding: [],
		evolution: [],
		state: [],
		learningHistory: [],
		memoryChanges: [],
		pendingWork: [],
		pendingInputs: [],
		processedInputs: [],
		outbox: [],
		learningAttempts: [],
		learningRevisions: [
			{
				id: 'current',
				memory_revision: memoryRevision,
				config_revision: configRevision,
				updated_at: at,
			},
		],
	}
}

async function writeSnapshot(
	store: NeuronStore,
	snapshot: NeuronStoreSnapshot,
): Promise<void> {
	await store.runAtomic((atomic) => {
		for (const record of snapshot.observations) atomic.observations.add(record)
		for (const record of snapshot.understanding) atomic.understanding.add(record)
		for (const record of snapshot.evolution) atomic.evolution.add(record)
		for (const record of snapshot.state) atomic.state.add(record)
		for (const record of snapshot.learningHistory)
			atomic.learningHistory.add(record)
		for (const record of snapshot.memoryChanges)
			atomic.memoryChanges.add(record)
		for (const record of snapshot.pendingWork) atomic.pendingWork.add(record)
		for (const record of snapshot.pendingInputs)
			atomic.pendingInputs.add(record)
		for (const record of snapshot.processedInputs)
			atomic.processedInputs.add(record)
		for (const record of snapshot.outbox) atomic.outbox.add(record)
		for (const record of snapshot.learningAttempts)
			atomic.learningAttempts.add(record)
		for (const record of snapshot.learningRevisions)
			atomic.learningRevisions.add(record)
	})
}

function deferred(): {
	readonly promise: Promise<void>
	readonly resolve: () => void
} {
	let resolve = () => {}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function runControl(resumes: string[]): EvolutionRunControl {
	return {
		async quiesce() {},
		async waitForIdle() {},
		async resume(_lensIds, registryRevisionId) {
			resumes.push(registryRevisionId)
		},
	}
}

async function createFixture(store: MemoryBrainStore): Promise<{
	readonly input: EvolutionActivationInput
	readonly targetStoreId: string
}> {
	const created = lens('created')
	const targetStoreId = 'physical-created'
	const targetLens = storedLens(created, targetStoreId)
	await initializeEvolutionRegistry(store, {
		head_revision_id: 'registry-base',
		revision: 0,
		lenses: [],
		created_at: at,
	})
	const proposal: EvolutionProposal = {
		id: 'proposal-create',
		action: 'create',
		reasoning: 'Create a supplied test lens.',
		trigger_id: 'trigger',
		evidence_ids: ['evidence'],
		expected_effect: 'One lens is added.',
		target_lens_ids: [],
		resulting_lenses: [created],
		regression_check_ids: [],
		created_at: at,
	}
	const snapshot = emptySnapshot()
	snapshot.understanding.push({
		id: 'created-memory',
		data: 'retained value',
		metadata_confidence: null,
		metadata_confidence_provenance: 'unknown',
		metadata_created_at: at,
		metadata_updated_at: at,
	})
	return {
		targetStoreId,
		input: {
			activation_id: 'activation-create',
			mode: 'evolution',
			validated_proposal: await validatedProposal(proposal, []),
			base_registry_revision_id: 'registry-base',
			target_registry: {
				id: 'registry-target',
				revision: 1,
				parent_id: 'registry-base',
				activation_id: 'activation-create',
				lenses: [targetLens],
				created_at: later,
			},
			transformation: {
				id: 'transformation-create',
				proposal_id: proposal.id,
				source_pins: [],
				targets: [
					{
						stage_id: 'stage-created',
						lens: targetLens,
						snapshot,
					},
				],
				mappings: [],
			},
			staging_policy: {
				max_targets: 2,
				max_snapshot_records: 32,
				max_snapshot_chars: 20_000,
			},
			created_at: at,
			updated_at: later,
		},
	}
}

function sourceSplitSnapshot(): NeuronStoreSnapshot {
	const snapshot = emptySnapshot(2, 3)
	for (const id of ['one', 'two']) {
		snapshot.understanding.push({
			id: `memory-${id}`,
			data: id,
			metadata_confidence: null,
			metadata_confidence_provenance: 'unknown',
			metadata_created_at: at,
			metadata_updated_at: at,
		})
		snapshot.memoryChanges.push({
			id: `change-${id}`,
			attempt_id: `attempt-${id}`,
			memory_revision: id === 'one' ? 1 : 2,
			kind: 'upsert',
			affected_memory_ids: [`memory-${id}`],
			created_at: at,
		})
		snapshot.learningHistory.push({
			id: `history-${id}`,
			attempt_id: `attempt-${id}`,
			outcome: 'change',
			previous_memory_revision: id === 'one' ? 0 : 1,
			memory_revision: id === 'one' ? 1 : 2,
			config_revision: 3,
			input_ids: [`processed-${id}`],
			change_ids: [`change-${id}`],
			created_at: at,
		})
		snapshot.processedInputs.push({
			id: `processed-${id}`,
			attempt_id: `attempt-${id}`,
			outcome: 'change',
			memory_revision: id === 'one' ? 1 : 2,
			processed_at: at,
		})
		snapshot.learningAttempts.push({
			id: `attempt-${id}`,
			pending_work_id: `committed-work-${id}`,
			input_ids: [`processed-${id}`],
			status: 'committed',
			memory_revision: id === 'one' ? 1 : 2,
			config_revision: 3,
			history_id: `history-${id}`,
			intent_digest: `intent-${id}`,
			created_at: at,
		})
		snapshot.outbox.push({
			id: `outbox-${id}`,
			kind: 'memory-change',
			deduplication_key: `outbox-${id}`,
			change_ids: [`change-${id}`],
			status: 'pending',
			attempts: 0,
			available_at: at,
			created_at: at,
			updated_at: at,
		})
	}
	snapshot.pendingWork.push({
		id: 'pending-work',
		attempt_id: 'pending-attempt',
		input_ids: ['pending-input'],
		inputs: [{ id: 'pending-input', text: 'temporary pending text' }],
		status: 'pending',
		retry_count: 0,
		available_at: at,
		created_at: at,
		updated_at: at,
	})
	snapshot.pendingInputs.push({
		id: 'pending-input',
		pending_work_id: 'pending-work',
		attempt_id: 'pending-attempt',
		created_at: at,
	})
	return snapshot
}

function recordsFor(
	source: NeuronStoreSnapshot,
	suffix: 'one' | 'two',
): NeuronStoreSnapshot {
	const target = emptySnapshot(2, 4)
	target.understanding = source.understanding.filter(({ id }) => id.endsWith(suffix))
	target.learningHistory = source.learningHistory.filter(({ id }) =>
		id.endsWith(suffix),
	)
	target.memoryChanges = source.memoryChanges.filter(({ id }) =>
		id.endsWith(suffix),
	)
	target.processedInputs = source.processedInputs.filter(({ id }) =>
		id.endsWith(suffix),
	)
	target.outbox = source.outbox.filter(({ id }) => id.endsWith(suffix))
	target.learningAttempts = source.learningAttempts.filter(({ id }) =>
		id.endsWith(suffix),
	)
	return target
}

async function splitFixture(
	store: MemoryBrainStore,
	broken?: 'pending' | 'attempt' | 'outbox',
): Promise<{
	readonly input: EvolutionActivationInput
	readonly validator: EvolutionTransformationValidator
}> {
	const sourceDefinition = lens('source-lens')
	const firstDefinition = lens('first-lens')
	const secondDefinition = lens('second-lens')
	const sourceStoreId = 'physical-source'
	const sourceRegistryLens = storedLens(sourceDefinition, sourceStoreId)
	await initializeEvolutionRegistry(store, {
		head_revision_id: 'registry-base',
		revision: 0,
		lenses: [sourceRegistryLens],
		created_at: at,
	})
	const source = sourceSplitSnapshot()
	await writeSnapshot(store.getNeuronStore(sourceStoreId), source)
	const first = recordsFor(source, 'one')
	const second = recordsFor(source, 'two')
	first.pendingWork = source.pendingWork
	first.pendingInputs = source.pendingInputs
	if (broken === 'pending') {
		first.pendingInputs = []
		second.pendingInputs = source.pendingInputs
	}
	if (broken === 'attempt') {
		first.learningAttempts = []
		second.learningAttempts = [
			...second.learningAttempts,
			source.learningAttempts[0]!,
		]
	}
	if (broken === 'outbox') {
		first.outbox = []
		second.outbox = [...second.outbox, source.outbox[0]!]
	}
	const firstLens = storedLens(firstDefinition, 'physical-first')
	const secondLens = storedLens(secondDefinition, 'physical-second')
	const proposal: EvolutionProposal = {
		id: 'proposal-split',
		action: 'split',
		reasoning: 'Split the two supplied memories.',
		trigger_id: 'trigger',
		evidence_ids: ['evidence'],
		expected_effect: 'Two lenses replace one lens.',
		target_lens_ids: [sourceDefinition.id],
		resulting_lenses: [firstDefinition, secondDefinition],
		transformation: splitTransformation,
		regression_check_ids: [],
		created_at: at,
	}
	return {
		validator: {
			reference: splitTransformation,
			validate() {},
		},
		input: {
			activation_id: `activation-split-${broken ?? 'coherent'}`,
			mode: 'evolution',
			validated_proposal: await validatedProposal(proposal, [sourceDefinition]),
			base_registry_revision_id: 'registry-base',
			target_registry: {
				id: `registry-split-${broken ?? 'coherent'}`,
				revision: 1,
				parent_id: 'registry-base',
				activation_id: `activation-split-${broken ?? 'coherent'}`,
				lenses: [firstLens, secondLens],
				created_at: later,
			},
			transformation: {
				id: `transformation-split-${broken ?? 'coherent'}`,
				proposal_id: proposal.id,
				source_pins: [
					{
						lens_id: sourceDefinition.id,
						physical_store_id: sourceStoreId,
						memory_revision: 2,
						config_revision: 3,
						state_digest: neuronStoreSnapshotDigest(source),
					},
				],
				targets: [
					{
						stage_id: `stage-first-${broken ?? 'coherent'}`,
						lens: firstLens,
						snapshot: first,
					},
					{
						stage_id: `stage-second-${broken ?? 'coherent'}`,
						lens: secondLens,
						snapshot: second,
					},
				],
				mappings: [
					{
						id: `mapping-one-${broken ?? 'coherent'}`,
						activation_id: `activation-split-${broken ?? 'coherent'}`,
						source_lens_id: sourceDefinition.id,
						source_memory_id: 'memory-one',
						target_lens_id: firstDefinition.id,
						target_memory_id: 'memory-one',
						disposition: 'transferred',
						history: [
							{ source_history_id: 'history-one', target_history_id: 'history-one' },
						],
						created_at: at,
					},
					{
						id: `mapping-two-${broken ?? 'coherent'}`,
						activation_id: `activation-split-${broken ?? 'coherent'}`,
						source_lens_id: sourceDefinition.id,
						source_memory_id: 'memory-two',
						target_lens_id: secondDefinition.id,
						target_memory_id: 'memory-two',
						disposition: 'transferred',
						history: [
							{ source_history_id: 'history-two', target_history_id: 'history-two' },
						],
						created_at: at,
					},
				],
			},
			staging_policy: {
				max_targets: 3,
				max_snapshot_records: 64,
				max_snapshot_chars: 40_000,
			},
			created_at: at,
			updated_at: later,
		},
	}
}

describe('evolution activation regressions', () => {
	it('does not let a same-id reservation loser abandon the owning activation', async () => {
		const store = new MemoryBrainStore()
		const { input } = await createFixture(store)
		const resumes: string[] = []
		const bothReads = deferred()
		const ownerJournaled = deferred()
		const releaseOwner = deferred()
		const originalGet = store.evolutionActivations.get.bind(
			store.evolutionActivations,
		)
		let emptyReads = 0
		store.evolutionActivations.get = async (id) => {
			const current = await originalGet(id)
			if (id === input.activation_id && current === undefined && emptyReads < 2) {
				emptyReads += 1
				if (emptyReads === 2) bothReads.resolve()
				await bothReads.promise
				return undefined
			}
			return current
		}
		const options = {
			async onStage(stage: string) {
				if (stage !== 'journaled') return
				ownerJournaled.resolve()
				await releaseOwner.promise
			},
		}
		const first = activateEvolution(store, input, runControl(resumes), options)
		const second = activateEvolution(store, input, runControl(resumes), options)
		await ownerJournaled.promise
		const loser = await Promise.race([first, second])
		expect(loser).toEqual({
			status: 'conflict',
			reason: 'activation-id-reused',
		})
		expect(await store.evolutionActivations.get(input.activation_id)).toMatchObject({
			status: 'preparing',
		})
		expect(resumes).toEqual([])
		expect(
			(
				await readNeuronStoreSnapshot(store.getNeuronStore('physical-created'))
			).understanding,
		).toEqual([])
		releaseOwner.resolve()
		const results = await Promise.all([first, second])
		expect(results.map(({ status }) => status).sort()).toEqual([
			'activated',
			'conflict',
		])
		expect(resumes).toEqual(['registry-target'])
		expect(await store.registryHeads.get('current')).toMatchObject({
			revision_id: 'registry-target',
		})
	})

	it('keeps an owned activation intact across an invalid caller and a matching concurrent retry', async () => {
		const store = new MemoryBrainStore()
		const { input } = await createFixture(store)
		const resumes: string[] = []
		const ownerJournaled = deferred()
		const releaseOwner = deferred()
		const owner = activateEvolution(store, input, runControl(resumes), {
			async onStage(stage) {
				if (stage !== 'journaled') return
				ownerJournaled.resolve()
				await releaseOwner.promise
			},
		})
		await ownerJournaled.promise
		const invalidInput = {
			...structuredClone(input),
			validated_proposal: null,
		} as unknown as EvolutionActivationInput
		const invalid = await activateEvolution(
			store,
			invalidInput,
			runControl(resumes),
		)
		expect(invalid.status).toBe('failure')
		expect(await store.evolutionActivations.get(input.activation_id)).toMatchObject({
			status: 'preparing',
		})
		expect(resumes).toEqual([])

		const retry = await activateEvolution(store, input, runControl(resumes))
		expect(retry).toMatchObject({
			status: 'recovery-required',
			activation_id: input.activation_id,
			registry_revision_id: 'registry-base',
		})
		expect(await store.evolutionActivations.get(input.activation_id)).toMatchObject({
			status: 'preparing',
		})
		expect(resumes).toEqual([])
		expect(
			(
				await readNeuronStoreSnapshot(store.getNeuronStore('physical-created'))
			).understanding,
		).toEqual([])
		releaseOwner.resolve()
		const original = await owner
		expect(original.status).toBe('activated')
		expect(resumes).toEqual(['registry-target'])
		expect(await readNeuronStoreSnapshot(store.getNeuronStore('physical-created')))
			.toEqual(input.transformation.targets[0]!.snapshot)

		const completedRetry = await activateEvolution(
			store,
			input,
			runControl(resumes),
		)
		expect(completedRetry).toMatchObject({
			status: 'activated',
			registry_revision_id: 'registry-target',
			deduplicated: true,
		})
		expect(resumes).toEqual(['registry-target'])
	})

	it('publishes a coherent split with one owner for each processing record', async () => {
		const store = new MemoryBrainStore()
		const { input, validator } = await splitFixture(store)
		const resumes: string[] = []
		const result = await activateEvolution(store, input, runControl(resumes), {
			transformation_validator: validator,
		})
		expect(result).toMatchObject({
			status: 'activated',
			registry_revision_id: 'registry-split-coherent',
			deduplicated: false,
		})
		expect(resumes).toEqual(['registry-split-coherent'])
		expect(await store.registryHeads.get('current')).toMatchObject({
			revision_id: 'registry-split-coherent',
		})
	})

	it.each(['pending', 'attempt', 'outbox'] as const)(
		'rejects a split with incoherent %s ownership before publishing',
		async (broken) => {
			const store = new MemoryBrainStore()
			const { input, validator } = await splitFixture(store, broken)
			const resumes: string[] = []
			const result = await activateEvolution(store, input, runControl(resumes), {
				transformation_validator: validator,
			})
			expect(result).toMatchObject({
				status: 'failure',
				error:
					broken === 'pending'
						? 'target pending work is separated from its input index'
						: broken === 'attempt'
						? 'target learning attempt is separated from its history'
							: 'target outbox has a cross-target change reference',
			})
			expect(await store.registryHeads.get('current')).toMatchObject({
				revision_id: 'registry-base',
			})
			expect(await store.evolutionActivations.get(input.activation_id)).toMatchObject({
				status: 'abandoned',
			})
			expect(resumes).toEqual(['registry-base'])
			for (const target of input.transformation.targets) {
				const targetSnapshot = await readNeuronStoreSnapshot(
					store.getNeuronStore(target.lens.physical_store_id),
				)
				expect(targetSnapshot.understanding).toEqual([])
			}
		},
	)

	it('clears abandoned physical data before pruning its last stage reference', async () => {
		const store = new MemoryBrainStore()
		const { input, targetStoreId } = await createFixture(store)
		const result = await activateEvolution(store, input, runControl([]), {
			onStage(stage) {
				if (stage === 'targets-written') {
					throw new Error('interrupt after physical stage write')
				}
			},
		})
		expect(result.status).toBe('failure')
		const written = await readNeuronStoreSnapshot(store.getNeuronStore(targetStoreId))
		expect(written.understanding).toHaveLength(1)
		expect(await store.evolutionStages.get('stage-created')).toMatchObject({
			status: 'abandoned',
		})

		const pruned = await pruneEvolutionStages(store, { max_terminal_stages: 0 })
		expect(pruned.deleted_stage_ids).toEqual(['stage-created'])
		expect(await store.evolutionStages.get('stage-created')).toBeUndefined()
		const cleaned = await readNeuronStoreSnapshot(store.getNeuronStore(targetStoreId))
		expect(Object.values(cleaned).every((records) => records.length === 0)).toBe(
			true,
		)
	})
})
