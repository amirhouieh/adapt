/**
 * Mechanical evolution activation/recovery eval.
 *
 * This unit records exact supplied data, constructed production inputs, return
 * values, failures, and actual SQLite state. It performs no assertions or
 * automated quality judgment and uses no model because proposal semantics are
 * a separate eval gate.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import {
	activateEvolution,
	EvolutionActivationInterruption,
	initializeEvolutionRegistry,
	neuronStoreSnapshotDigest,
	pinEvolutionRegistry,
	readNeuronStoreSnapshot,
	recoverEvolutionActivation,
} from '../../src/brain/evolution/activation'
import type {
	EvolutionActivationInput,
	EvolutionActivationStage,
	EvolutionCatalogue,
	EvolutionLensDefinition,
	EvolutionPolicy,
	EvolutionProposal,
	EvolutionRunControl,
} from '../../src/brain/evolution/contracts'
import { validateEvolutionProposal } from '../../src/brain/evolution/validation'
import type {
	BrainMemoryMappingRecord,
	BrainRegistryRevisionRecord,
	NeuronStore,
	NeuronStoreSnapshot,
} from '../../src/stores'
import { SQLiteBrainStore } from '../../src/sqlite'

interface EvalConfig {
	artifactDirectory: string
	runId: string
	databaseFileName: string
	datasetPath: string
	failureStage: EvolutionActivationStage
	failureMessage: string
	initialRegistry: {
		head_revision_id: string
		revision: number
		created_at: string
		lenses: BrainRegistryRevisionRecord['lenses']
	}
	validation: {
		proposal: EvolutionProposal
		evidence_ids: string[]
		catalogue: EvolutionCatalogue
		policy: EvolutionPolicy
	}
	activation: {
		activation_id: string
		mode: 'evolution' | 'rollback'
		base_registry_revision_id: string
		target_registry: BrainRegistryRevisionRecord
		transformation_id: string
		stage_id: string
		mapping_id: string
		source_lens_id: string
		source_store_id: string
		target_store_id: string
		created_at: string
		updated_at: string
		staging_policy: EvolutionActivationInput['staging_policy']
	}
}

interface EvalDataset {
	sourceSnapshot: NeuronStoreSnapshot
	targetSnapshot: NeuronStoreSnapshot
	mapping: BrainMemoryMappingRecord
}

class RecordingRunControl implements EvolutionRunControl {
	readonly events: Array<{ operation: string; lens_ids: readonly string[]; registry_revision_id?: string }> = []

	async quiesce(lensIds: readonly string[]): Promise<void> {
		this.events.push({ operation: 'quiesce', lens_ids: [...lensIds] })
	}

	async waitForIdle(lensIds: readonly string[]): Promise<void> {
		this.events.push({ operation: 'waitForIdle', lens_ids: [...lensIds] })
	}

	async resume(lensIds: readonly string[], registryRevisionId: string): Promise<void> {
		this.events.push({
			operation: 'resume',
			lens_ids: [...lensIds],
			registry_revision_id: registryRevisionId,
		})
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
		for (const record of snapshot.learningHistory) atomic.learningHistory.add(record)
		for (const record of snapshot.memoryChanges) atomic.memoryChanges.add(record)
		for (const record of snapshot.pendingWork) atomic.pendingWork.add(record)
		for (const record of snapshot.pendingInputs) atomic.pendingInputs.add(record)
		for (const record of snapshot.processedInputs) atomic.processedInputs.add(record)
		for (const record of snapshot.outbox) atomic.outbox.add(record)
		for (const record of snapshot.learningAttempts) atomic.learningAttempts.add(record)
		for (const record of snapshot.learningRevisions) atomic.learningRevisions.add(record)
	})
}

async function main(): Promise<void> {
	const suppliedPath = process.env.EVOLUTION_V2_EVAL_CONFIG
	if (!suppliedPath) throw new Error('EVOLUTION_V2_EVAL_CONFIG is required')
	const configPath = resolve(suppliedPath)
	const suppliedRaw = readFileSync(configPath, 'utf8')
	const config = JSON.parse(suppliedRaw) as EvalConfig
	const datasetPath = resolve(config.datasetPath)
	const suppliedDatasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = JSON.parse(suppliedDatasetRaw) as EvalDataset
	const artifactRoot = resolve(config.artifactDirectory, config.runId)
	const databasePath = resolve(artifactRoot, config.databaseFileName)
	if (existsSync(artifactRoot) || existsSync(databasePath)) {
		throw new Error('eval artifact or database path already exists')
	}
	mkdirSync(artifactRoot, { recursive: true })
	writeFileSync(resolve(artifactRoot, 'supplied-input.raw.json'), suppliedRaw)
	writeFileSync(
		resolve(artifactRoot, 'supplied-dataset.raw.json'),
		suppliedDatasetRaw,
	)

	let store = new SQLiteBrainStore(databasePath)
	await initializeEvolutionRegistry(store, config.initialRegistry)
	await writeSnapshot(
		store.getNeuronStore(config.activation.source_store_id),
		dataset.sourceSnapshot,
	)
	const sourceRegistry = config.initialRegistry.lenses.map(
		(lens) => structuredClone(lens.config) as EvolutionLensDefinition,
	)
	const validation = await validateEvolutionProposal({
		proposal: config.validation.proposal,
		current_registry: sourceRegistry,
		evidence_ids: config.validation.evidence_ids,
		catalogue: config.validation.catalogue,
		policy: config.validation.policy,
		checks: [],
	})
	if (validation.status !== 'valid') {
		writeFileSync(
			resolve(artifactRoot, 'output.raw.json'),
			JSON.stringify({ validation }, null, 2),
		)
		await store.dispose()
		return
	}
	const activationInput: EvolutionActivationInput = {
		activation_id: config.activation.activation_id,
		mode: config.activation.mode,
		validated_proposal: validation.value,
		base_registry_revision_id: config.activation.base_registry_revision_id,
		target_registry: config.activation.target_registry,
		transformation: {
			id: config.activation.transformation_id,
			proposal_id: config.validation.proposal.id,
			source_pins: [
				{
					lens_id: config.activation.source_lens_id,
					physical_store_id: config.activation.source_store_id,
					memory_revision:
						dataset.sourceSnapshot.learningRevisions[0]!.memory_revision,
					config_revision:
						dataset.sourceSnapshot.learningRevisions[0]!.config_revision,
					state_digest: neuronStoreSnapshotDigest(dataset.sourceSnapshot),
				},
			],
			targets: [
				{
					stage_id: config.activation.stage_id,
					lens: config.activation.target_registry.lenses[0]!,
					snapshot: dataset.targetSnapshot,
				},
			],
			mappings: [dataset.mapping],
		},
		staging_policy: config.activation.staging_policy,
		created_at: config.activation.created_at,
		updated_at: config.activation.updated_at,
	}
	writeFileSync(
		resolve(artifactRoot, 'activation-input.raw.json'),
		JSON.stringify(activationInput, null, 2),
	)

	const firstControl = new RecordingRunControl()
	let injectedFailure: Error | undefined
	const interrupted = await activateEvolution(store, activationInput, firstControl, {
		onStage(stage) {
			if (stage === config.failureStage) {
				injectedFailure = new EvolutionActivationInterruption(config.failureMessage)
				throw injectedFailure
			}
		},
	})
	writeFileSync(
		resolve(artifactRoot, 'failure.raw.json'),
		JSON.stringify(injectedFailure, null, 2),
	)
	writeFileSync(
		resolve(artifactRoot, 'failure.inspect.txt'),
		inspect(injectedFailure, {
			depth: null,
			maxArrayLength: null,
			maxStringLength: null,
		}),
	)
	const beforeRestart = {
		interrupted,
		control_events: firstControl.events,
		registry: await pinEvolutionRegistry(store),
		activation: await store.evolutionActivations.get(config.activation.activation_id),
		stages: await store.evolutionStages.list({ activation_id: config.activation.activation_id }),
		source: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.source_store_id),
		),
		target: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.target_store_id),
		),
	}
	await store.dispose()

	store = new SQLiteBrainStore(databasePath)
	const recoveryControl = new RecordingRunControl()
	const recovery = await recoverEvolutionActivation(
		store,
		config.activation.activation_id,
		'abandon',
		recoveryControl,
	)
	const duplicate = await activateEvolution(
		store,
		activationInput,
		new RecordingRunControl(),
	)
	const afterRecovery = {
		recovery,
		duplicate,
		control_events: recoveryControl.events,
		registry: await pinEvolutionRegistry(store),
		activation: await store.evolutionActivations.get(config.activation.activation_id),
		stages: await store.evolutionStages.list({ activation_id: config.activation.activation_id }),
		source: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.source_store_id),
		),
		target: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.target_store_id),
		),
	}
	writeFileSync(
		resolve(artifactRoot, 'output.raw.json'),
		JSON.stringify({ validation, beforeRestart, afterRecovery }, null, 2),
	)
	writeFileSync(
		resolve(artifactRoot, 'output.inspect.txt'),
		inspect({ validation, beforeRestart, afterRecovery }, {
			depth: null,
			maxArrayLength: null,
			maxStringLength: null,
		}),
	)
	writeFileSync(
		resolve(artifactRoot, 'metadata.json'),
		JSON.stringify(
			{
				run_id: config.runId,
				adapter: 'SQLiteBrainStore (node)',
				config_path: configPath,
				dataset_path: datasetPath,
				database_path: databasePath,
			},
			null,
			2,
		),
	)
	await store.dispose()
}

await main()
