/**
 * Mechanical Brain mutation-fence and registry-recovery eval.
 *
 * Records supplied fixtures, constructed activation input, production return
 * values, failures, and actual SQLite state. It performs no assertions or
 * automated grading and uses no model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import {
	activateEvolution,
	EvolutionActivationInterruption,
	initializeEvolutionRegistry,
	neuronStoreSnapshotDigest,
	pinEvolutionRegistry,
	readNeuronStoreSnapshot,
} from '../../src/brain/evolution/activation'
import type {
	EvolutionActivationInput,
	EvolutionActivationStage,
	EvolutionCatalogue,
	EvolutionLensDefinition,
	EvolutionPolicy,
	EvolutionProposal,
} from '../../src/brain/evolution/contracts'
import { validateEvolutionProposal } from '../../src/brain/evolution/validation'
import {
	physicalStoreForLens,
	recoverBrainRegistry,
} from '../../src/brain/registry-lifecycle'
import { BrainRunCoordinator } from '../../src/brain/run-control'
import type {
	BrainMemoryMappingRecord,
	BrainRegistryRevisionRecord,
	NeuronStore,
	NeuronStoreSnapshot,
	PendingWorkRecord,
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
		source_lens_id: string
		source_store_id: string
		target_store_id: string
		created_at: string
		updated_at: string
		staging_policy: EvolutionActivationInput['staging_policy']
	}
	concurrency: {
		admittedWork: PendingWorkRecord
		postRecoveryWork: PendingWorkRecord
	}
}

interface EvalDataset {
	initialSourceSnapshot: NeuronStoreSnapshot
	targetSnapshot: NeuronStoreSnapshot
	mapping: BrainMemoryMappingRecord
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
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
	const suppliedPath = process.env.BRAIN_RUN_CONTROL_EVAL_CONFIG
	if (!suppliedPath) throw new Error('BRAIN_RUN_CONTROL_EVAL_CONFIG is required')
	const configPath = resolve(suppliedPath)
	const suppliedRaw = readFileSync(configPath, 'utf8')
	const config = JSON.parse(suppliedRaw) as EvalConfig
	const datasetPath = resolve(config.datasetPath)
	const suppliedDatasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = JSON.parse(suppliedDatasetRaw) as EvalDataset
	const artifactRoot = resolve(config.artifactDirectory, config.runId)
	const databasePath = resolve(artifactRoot, config.databaseFileName)
	if (existsSync(artifactRoot) || existsSync(databasePath))
		throw new Error('eval artifact or database path already exists')
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
		dataset.initialSourceSnapshot,
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

	const events: Array<Record<string, unknown>> = []
	const coordinator = new BrainRunCoordinator({
		pinCurrentRegistry: () => pinEvolutionRegistry(store),
	})
	const releaseAdmitted = deferred()
	const admittedStarted = deferred()
	const admittedMutation = coordinator.runMutation(
		[config.activation.source_lens_id],
		async (registry) => {
			const bound = registry.getLens(config.activation.source_lens_id)
			const enqueue = await physicalStoreForLens(
				store,
				registry,
				config.activation.source_lens_id,
			).learning.enqueue({ work: config.concurrency.admittedWork })
			events.push({
				operation: 'admitted-mutation-started',
				registry_revision_id: registry.revision.id,
				physical_store_id: bound?.physical_store_id,
				enqueue,
			})
			admittedStarted.resolve()
			await releaseAdmitted.promise
			events.push({ operation: 'admitted-mutation-finished' })
		},
	)
	await admittedStarted.promise
	const sourceAfterAdmittedMutation = await readNeuronStoreSnapshot(
		store.getNeuronStore(config.activation.source_store_id),
	)
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
						sourceAfterAdmittedMutation.learningRevisions[0]!.memory_revision,
					config_revision:
						sourceAfterAdmittedMutation.learningRevisions[0]!.config_revision,
					state_digest: neuronStoreSnapshotDigest(sourceAfterAdmittedMutation),
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

	const firstControl = coordinator.createEvolutionRunControl({
		publication: {
			async publish(registry) {
				events.push({
					operation: 'pre-reopen-publication',
					requested_registry_revision_id:
						config.activation.target_registry.id,
					authoritative_registry_revision_id: registry.revision.id,
				})
			},
		},
	})
	await firstControl.quiesce([config.activation.source_lens_id])
	let oldBlockedMutationStarted = false
	void coordinator
		.runMutation([config.activation.source_lens_id], async (registry) => {
			oldBlockedMutationStarted = true
			events.push({
				operation: 'old-process-blocked-mutation-started',
				registry_revision_id: registry.revision.id,
			})
		})
		.catch((error: unknown) => {
			events.push({
				operation: 'old-process-blocked-mutation-failed',
				error,
			})
		})

	let injectedFailure: Error | undefined
	const interruptedPromise = activateEvolution(
		store,
		activationInput,
		firstControl,
		{
			onStage(stage) {
				events.push({ operation: 'activation-stage', stage })
				if (stage === config.failureStage) {
					injectedFailure = new EvolutionActivationInterruption(
						config.failureMessage,
					)
					throw injectedFailure
				}
			},
		},
	)
	releaseAdmitted.resolve()
	await admittedMutation
	const interrupted = await interruptedPromise
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
		old_blocked_mutation_started: oldBlockedMutationStarted,
		registry: await pinEvolutionRegistry(store),
		activation: await store.evolutionActivations.get(
			config.activation.activation_id,
		),
		source: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.source_store_id),
		),
		target: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.target_store_id),
		),
	}
	await store.dispose()

	store = new SQLiteBrainStore(databasePath)
	const recoveryEvents: Array<Record<string, unknown>> = []
	const recoveredCoordinator = new BrainRunCoordinator({
		pinCurrentRegistry: () => pinEvolutionRegistry(store),
	})
	const recovery = await recoverBrainRegistry({
		store,
		strategy: () => 'complete',
		resolveTransformationValidator: () => undefined,
		createRunControl: () =>
			recoveredCoordinator.createEvolutionRunControl({
				publication: {
					async publish(registry) {
						recoveryEvents.push({
							operation: 'runtime-published',
							requested_registry_revision_id:
								config.activation.target_registry.id,
							authoritative_registry_revision_id: registry.revision.id,
						})
					},
				},
			}),
	})
	const postRecoveryMutation = await recoveredCoordinator.runMutation(
		[config.activation.source_lens_id],
		async (registry) => {
			const bound = registry.getLens(config.activation.source_lens_id)
			const enqueue = await physicalStoreForLens(
				store,
				registry,
				config.activation.source_lens_id,
			).learning.enqueue({ work: config.concurrency.postRecoveryWork })
			return {
				registry_revision_id: registry.revision.id,
				physical_store_id: bound?.physical_store_id,
				enqueue,
			}
		},
	)
	const afterRecovery = {
		recovery,
		recovery_events: recoveryEvents,
		post_recovery_mutation: postRecoveryMutation,
		registry: await pinEvolutionRegistry(store),
		activation: await store.evolutionActivations.get(
			config.activation.activation_id,
		),
		source: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.source_store_id),
		),
		target: await readNeuronStoreSnapshot(
			store.getNeuronStore(config.activation.target_store_id),
		),
	}
	const output = {
		validation,
		events,
		source_after_admitted_mutation: sourceAfterAdmittedMutation,
		before_restart: beforeRestart,
		after_recovery: afterRecovery,
	}
	writeFileSync(
		resolve(artifactRoot, 'output.raw.json'),
		JSON.stringify(output, null, 2),
	)
	writeFileSync(
		resolve(artifactRoot, 'output.inspect.txt'),
		inspect(output, {
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
				recovery_scope:
					'SQLite store close/reopen with a new coordinator in the same process',
			},
			null,
			2,
		),
	)
	await store.dispose()
}

await main()
