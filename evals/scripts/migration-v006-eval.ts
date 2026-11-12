/**
 * Mechanical v0.0.6 store migration eval.
 *
 * Uses the clean v0.0.6 SQLite adapter as the source and current SQLite as
 * the target. It records supplied data, production results, exact stores, and
 * original injected failures without assertions or automated grading.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import type { EvolutionLensDefinition } from '../../src/brain/evolution/contracts'
import {
	createLegacyV006BrainSource,
	createLegacyV006NeuronSource,
	executeLegacyV006BrainMigration,
	executeLegacyV006NeuronMigration,
	inspectLegacyV006Migration,
	migrationDigest,
	type LegacyMigrationBounds,
	type LegacyMigrationRuntimeCompatibility,
	type LegacyV006BrainSnapshot,
	type LegacyV006BrainStoreReader,
	type LegacyV006NeuronSnapshot,
	type LegacyV006NeuronStoreReader,
	type LegacyV006StoreKind,
} from '../../src/brain/migration'
import type {
	BrainStore,
	NeuronStore,
	NeuronStoreSnapshot,
} from '../../src/stores'
import { SQLiteBrainStore, SQLiteNeuronStore } from '../../src/sqlite'

interface LegacyWritableCollection<T extends { id: string }> {
	add(item: T): Promise<void>
	list(filter?: Record<string, unknown>): Promise<T[]>
}

interface LegacyWritableNeuronStore extends LegacyV006NeuronStoreReader {
	state: LegacyWritableCollection<LegacyV006NeuronSnapshot['state'][number]>
	observations: LegacyWritableCollection<LegacyV006NeuronSnapshot['observations'][number]>
	understanding: LegacyWritableCollection<LegacyV006NeuronSnapshot['understanding'][number]>
	evolution: LegacyWritableCollection<LegacyV006NeuronSnapshot['evolution'][number]>
	dispose(): Promise<void>
}

interface LegacyWritableBrainStore extends LegacyV006BrainStoreReader {
	state: LegacyWritableCollection<LegacyV006BrainSnapshot['state'][number]>
	neurons: LegacyWritableCollection<LegacyV006BrainSnapshot['neurons'][number]>
	internalNeurons: LegacyWritableCollection<LegacyV006BrainSnapshot['internalNeurons'][number]>
	evolution: LegacyWritableCollection<LegacyV006BrainSnapshot['evolution'][number]>
	dismissedBatches: LegacyWritableCollection<LegacyV006BrainSnapshot['dismissedBatches'][number]>
	getNeuronStore(neuronId: string): LegacyWritableNeuronStore
	dispose(): Promise<void>
}

interface LegacySQLiteModule {
	SQLiteBrainStore: new (path: string) => LegacyWritableBrainStore
	SQLiteNeuronStore: new (path: string) => LegacyWritableNeuronStore
}

interface RuntimeConfig {
	allowedModels: unknown[]
	allowedSchemas: Record<string, {
		observation: unknown
		understanding: unknown
	}>
	allowedRecipes: Array<{ id: string; version: string; memoryType: string }>
	lenses: Record<string, EvolutionLensDefinition>
}

interface EvalConfig {
	artifactDirectory: string
	runId: string
	legacySqliteModulePath: string
	databaseFiles: {
		sourceBrain: string
		targetBrain: string
		sourceNeuron: string
		targetNeuron: string
	}
	datasetPath: string
	declaredVersion: string
	storeKind: LegacyV006StoreKind
	sourceIds: { brain: string; neuron: string }
	targetIds: { brain: string; neuron: string }
	brainMigration: {
		migrationId: string
		journalStateId: string
		targetRegistryRevisionId: string
		targetRegistryRevision: number
		targetPhysicalStoreIds: Record<string, string>
	}
	neuronMigration: {
		migrationId: string
		journalStateId: string
		lensId: string
		lensType: string
		targetPhysicalStoreIds: Record<string, string>
	}
	revisions: { initialMemoryRevision: number; initialConfigRevision: number }
	bounds: LegacyMigrationBounds
	timestamps: { inspectedAt: string; retriedAt: string }
	failure: {
		brainStage: 'after-journal' | 'after-target-write' | 'before-publish' | 'after-publish'
		brainLensId: string
		brainMessage: string
		neuronStage: 'after-journal' | 'after-target-write' | 'before-publish' | 'after-publish'
		neuronMessage: string
	}
	runtime: RuntimeConfig
}

interface EvalDataset {
	provenance: unknown
	brain: LegacyV006BrainSnapshot
	standalone: LegacyV006NeuronSnapshot
}

async function addAll<T extends { id: string }>(
	collection: LegacyWritableCollection<T>,
	records: readonly T[],
): Promise<void> {
	for (const record of records) await collection.add(structuredClone(record))
}

async function seedLegacyNeuron(
	store: LegacyWritableNeuronStore,
	snapshot: LegacyV006NeuronSnapshot,
): Promise<void> {
	await addAll(store.state, snapshot.state)
	await addAll(store.observations, snapshot.observations)
	await addAll(store.understanding, snapshot.understanding)
	await addAll(store.evolution, snapshot.evolution)
}

async function seedLegacyBrain(
	store: LegacyWritableBrainStore,
	snapshot: LegacyV006BrainSnapshot,
): Promise<void> {
	await addAll(store.state, snapshot.state)
	await addAll(store.neurons, snapshot.neurons)
	await addAll(store.internalNeurons, snapshot.internalNeurons)
	await addAll(store.evolution, snapshot.evolution)
	await addAll(store.dismissedBatches, snapshot.dismissedBatches)
	for (const lens of snapshot.lenses) {
		await seedLegacyNeuron(store.getNeuronStore(lens.record.id), lens.store)
	}
}

function runtimeCompatibility(config: RuntimeConfig): LegacyMigrationRuntimeCompatibility {
	return {
		validateModelReference({ reference }) {
			return config.allowedModels.some((allowed) =>
				migrationDigest(allowed) === migrationDigest(reference)
			) ? undefined : 'model reference is not registered for migration'
		},
		validateSchema({ lensType, kind, schema }) {
			const allowed = config.allowedSchemas[lensType]?.[kind]
			return allowed !== undefined && migrationDigest(allowed) === migrationDigest(schema)
				? undefined
				: 'schema is not registered for migration'
		},
		buildLens({ record }) {
			const lens = config.lenses[record.id]
			if (!lens) throw new Error(`lens ${record.id} is not registered for migration`)
			return structuredClone(lens)
		},
		hasRecipe({ reference, memoryType }) {
			return config.allowedRecipes.some((allowed) =>
				allowed.id === reference.id &&
				allowed.version === reference.version &&
				allowed.memoryType === memoryType
			)
		},
	}
}

async function readNeuronStore(store: NeuronStore): Promise<NeuronStoreSnapshot> {
	return store.runAtomic((atomic) => ({
		observations: atomic.observations.list(),
		understanding: atomic.understanding.list(),
		evolution: atomic.evolution.list(),
		state: atomic.state.list(),
		learningHistory: atomic.learningHistory.list(),
		memoryChanges: atomic.memoryChanges.list(),
		pendingWork: atomic.pendingWork.list(),
		pendingInputs: atomic.pendingInputs.list(),
		processedInputs: atomic.processedInputs.list(),
		outbox: atomic.outbox.list(),
		learningAttempts: atomic.learningAttempts.list(),
		learningRevisions: atomic.learningRevisions.list(),
	}))
}

async function readBrainStore(
	store: BrainStore,
	physicalStoreIds: readonly string[],
): Promise<Record<string, unknown>> {
	const lensStores: Record<string, NeuronStoreSnapshot> = Object.create(null)
	for (const id of physicalStoreIds) lensStores[id] = await readNeuronStore(store.getNeuronStore(id))
	return {
		state: await store.state.list(),
		neurons: await store.neurons.list(),
		internalNeurons: await store.internalNeurons.list(),
		evolution: await store.evolution.list(),
		dismissedBatches: await store.dismissedBatches.list(),
		registryHeads: await store.registryHeads.list(),
		registryRevisions: await store.registryRevisions.list(),
		evolutionActivations: await store.evolutionActivations.list(),
		evolutionStages: await store.evolutionStages.list(),
		memoryMappings: await store.memoryMappings.list(),
		lensStores,
	}
}

function saveJson(directory: string, name: string, value: unknown): void {
	writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function main(): Promise<void> {
	const suppliedConfigPath = process.env.MIGRATION_V006_EVAL_CONFIG
	if (!suppliedConfigPath) throw new Error('MIGRATION_V006_EVAL_CONFIG is required')
	const configPath = resolve(suppliedConfigPath)
	const suppliedConfigRaw = readFileSync(configPath, 'utf8')
	const config = JSON.parse(suppliedConfigRaw) as EvalConfig
	const datasetPath = resolve(config.datasetPath)
	const suppliedDatasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = JSON.parse(suppliedDatasetRaw) as EvalDataset
	const artifactRoot = resolve(config.artifactDirectory, config.runId)
	if (existsSync(artifactRoot)) throw new Error(`eval artifact path already exists: ${artifactRoot}`)
	mkdirSync(artifactRoot, { recursive: true })
	writeFileSync(resolve(artifactRoot, 'supplied-config.raw.json'), suppliedConfigRaw)
	writeFileSync(resolve(artifactRoot, 'supplied-dataset.raw.json'), suppliedDatasetRaw)

	const paths = {
		sourceBrain: resolve(artifactRoot, config.databaseFiles.sourceBrain),
		targetBrain: resolve(artifactRoot, config.databaseFiles.targetBrain),
		sourceNeuron: resolve(artifactRoot, config.databaseFiles.sourceNeuron),
		targetNeuron: resolve(artifactRoot, config.databaseFiles.targetNeuron),
	}
	const legacyModule = await import(
		pathToFileURL(resolve(config.legacySqliteModulePath)).href
	) as LegacySQLiteModule
	let sourceBrain = new legacyModule.SQLiteBrainStore(paths.sourceBrain)
	let sourceNeuron = new legacyModule.SQLiteNeuronStore(paths.sourceNeuron)
	await seedLegacyBrain(sourceBrain, dataset.brain)
	await seedLegacyNeuron(sourceNeuron, dataset.standalone)

	let exclusiveChecks = 0
	const brainSource = () => createLegacyV006BrainSource({
		sourceId: config.sourceIds.brain,
		storeKind: config.storeKind,
		declaredVersion: config.declaredVersion,
		assertExclusive() { exclusiveChecks += 1 },
		store: sourceBrain,
	})
	const neuronSource = () => createLegacyV006NeuronSource({
		sourceId: config.sourceIds.neuron,
		storeKind: config.storeKind,
		declaredVersion: config.declaredVersion,
		assertExclusive() { exclusiveChecks += 1 },
		store: sourceNeuron,
		lensId: config.neuronMigration.lensId,
		lensType: config.neuronMigration.lensType,
	})
	const compatibility = runtimeCompatibility(config.runtime)
	const brainInspection = await inspectLegacyV006Migration({
		source: brainSource(),
		compatibility,
		bounds: config.bounds,
		ids: config.brainMigration,
		revisions: config.revisions,
		clock: { now: () => config.timestamps.inspectedAt },
	})
	const neuronInspection = await inspectLegacyV006Migration({
		source: neuronSource(),
		compatibility,
		bounds: config.bounds,
		ids: config.neuronMigration,
		revisions: config.revisions,
		clock: { now: () => config.timestamps.inspectedAt },
	})
	saveJson(artifactRoot, 'inspection.raw.json', { brainInspection, neuronInspection })

	let targetBrain = new SQLiteBrainStore(paths.targetBrain)
	let targetNeuron = new SQLiteNeuronStore(paths.targetNeuron)
	let brainFailure: unknown
	let neuronFailure: unknown
	let brainAfterFailure: unknown
	let neuronAfterFailure: unknown
	let brainRetry: unknown
	let brainDuplicate: unknown
	let neuronRetry: unknown
	let neuronDuplicate: unknown

	if (brainInspection.status === 'ready') {
		let enabled = true
		const result = await executeLegacyV006BrainMigration({
			source: brainSource(),
			plan: brainInspection.plan,
			targetId: config.targetIds.brain,
			target: targetBrain,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
			options: {
				onStage(stage, lensId) {
					if (enabled && stage === config.failure.brainStage && lensId === config.failure.brainLensId) {
						enabled = false
						throw new Error(config.failure.brainMessage)
					}
				},
			},
		})
		brainFailure = result
		brainAfterFailure = await readBrainStore(
			targetBrain,
			brainInspection.plan.targets.map(({ physicalStoreId }) => physicalStoreId),
		)
	}
	if (neuronInspection.status === 'ready') {
		let enabled = true
		const result = await executeLegacyV006NeuronMigration({
			source: neuronSource(),
			plan: neuronInspection.plan,
			targetId: config.targetIds.neuron,
			target: targetNeuron,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
			options: {
				onStage(stage) {
					if (enabled && stage === config.failure.neuronStage) {
						enabled = false
						throw new Error(config.failure.neuronMessage)
					}
				},
			},
		})
		neuronFailure = result
		neuronAfterFailure = await readNeuronStore(targetNeuron)
	}
	saveJson(artifactRoot, 'failure.raw.json', { brainFailure, neuronFailure })
	writeFileSync(
		resolve(artifactRoot, 'failure.error.inspect'),
		`${inspect({
			brain: brainFailure && typeof brainFailure === 'object' && 'error' in brainFailure
				? (brainFailure as { error: unknown }).error : undefined,
			neuron: neuronFailure && typeof neuronFailure === 'object' && 'error' in neuronFailure
				? (neuronFailure as { error: unknown }).error : undefined,
		}, { depth: null, maxArrayLength: null, maxStringLength: null })}\n`,
	)

	await targetBrain.dispose()
	await targetNeuron.dispose()
	await sourceBrain.dispose()
	await sourceNeuron.dispose()
	targetBrain = new SQLiteBrainStore(paths.targetBrain)
	targetNeuron = new SQLiteNeuronStore(paths.targetNeuron)
	sourceBrain = new legacyModule.SQLiteBrainStore(paths.sourceBrain)
	sourceNeuron = new legacyModule.SQLiteNeuronStore(paths.sourceNeuron)

	if (brainInspection.status === 'ready') {
		brainRetry = await executeLegacyV006BrainMigration({
			source: brainSource(),
			plan: brainInspection.plan,
			targetId: config.targetIds.brain,
			target: targetBrain,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
		})
		brainDuplicate = await executeLegacyV006BrainMigration({
			source: brainSource(),
			plan: brainInspection.plan,
			targetId: config.targetIds.brain,
			target: targetBrain,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
		})
	}
	if (neuronInspection.status === 'ready') {
		neuronRetry = await executeLegacyV006NeuronMigration({
			source: neuronSource(),
			plan: neuronInspection.plan,
			targetId: config.targetIds.neuron,
			target: targetNeuron,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
		})
		neuronDuplicate = await executeLegacyV006NeuronMigration({
			source: neuronSource(),
			plan: neuronInspection.plan,
			targetId: config.targetIds.neuron,
			target: targetNeuron,
			assertTargetExclusive() {},
			clock: { now: () => config.timestamps.retriedAt },
		})
	}

	const output = {
		brainAfterFailure,
		neuronAfterFailure,
		brainRetry,
		brainDuplicate,
		neuronRetry,
		neuronDuplicate,
		brainFinal: brainInspection.status === 'ready'
			? await readBrainStore(targetBrain, brainInspection.plan.targets.map(({ physicalStoreId }) => physicalStoreId))
			: undefined,
		neuronFinal: await readNeuronStore(targetNeuron),
		legacyBrainAfter: await brainSource().read(),
		legacyNeuronAfter: await neuronSource().read(),
		exclusiveChecks,
	}
	saveJson(artifactRoot, 'output.raw.json', output)
	saveJson(artifactRoot, 'metadata.json', {
		adapter: config.storeKind,
		legacyImplementation: resolve(config.legacySqliteModulePath),
		sourceRuntime: 'clean v0.0.6 TypeScript SQLite adapter loaded by tsx',
		targetRuntime: 'current Node SQLite adapter',
		recoveryBoundary: 'adapter close and reopen in one process; not a process crash',
		datasetProvenance: dataset.provenance,
		compatibilityBoundary: 'supplied allowlist fixture validates the migration port only; it does not prove public runtime compatibility',
		completedRetryBoundary: 'receipt requires the migrated registry head to remain authoritative; a later registry evolution requires lifecycle-level receipt handling',
		modelUsed: false,
		assessment: 'none; raw artifacts require orchestrator inspection',
	})
	await targetBrain.dispose()
	await targetNeuron.dispose()
	await sourceBrain.dispose()
	await sourceNeuron.dispose()
}

await main()
