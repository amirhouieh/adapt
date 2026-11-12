/**
 * Mechanical two-stage observation/understanding commit eval.
 * Saves exact supplied inputs, constructed commit inputs, store outputs, and
 * the original injected failure. It makes no automated quality judgment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import type {
	LearningCommitInput,
	LearningCommitStage,
	LearningStoreOptions,
	NeuronStore,
	PendingWorkRecord,
} from '../../src/stores'

type EvalAdapter = 'memory' | 'sqlite-node' | 'sqlite-bun'

interface EvalConfig {
	adapter: EvalAdapter
	artifactDirectory: string
	runId: string
	databaseFileName: string
	datasetPath: string
	createdAt: string
	committedAt: string
	failureStage: LearningCommitStage
	failureMessage: string
	sourceWorkId: string
	sourceAttemptId: string
	sourceInputId: string
	observationId: string
	observerHistoryId: string
	synthesisWorkId: string
	synthesisAttemptId: string
	synthesisHistoryId: string
	memoryId: string
	evolutionId: string
	changeId: string
	changeKind: string
	outboxId: string
	outboxKind: string
	deduplicationKey: string
}

interface EvalDataset {
	sourceText: string
	observationData: unknown
	observationImportance: number
	observationTokens: number
	learnedUnderstanding: unknown
	evolutionSummary: string
	evolutionReasoning: string
	evolutionSignificance: 'routine' | 'notable' | 'critical'
	historyExplanation: string
	changeSummary: string
	changedIntentExplanation: string
}

const suppliedConfigPath = process.env.OBSERVATION_COMMIT_EVAL_CONFIG
if (!suppliedConfigPath) throw new Error('OBSERVATION_COMMIT_EVAL_CONFIG is required')
const configPath = resolve(suppliedConfigPath)
const suppliedConfigRaw = readFileSync(configPath, 'utf8')
const config = JSON.parse(suppliedConfigRaw) as EvalConfig
const datasetPath = resolve(config.datasetPath)
const suppliedDatasetRaw = readFileSync(datasetPath, 'utf8')
const dataset = JSON.parse(suppliedDatasetRaw) as EvalDataset
const adapter = (process.env.OBSERVATION_COMMIT_EVAL_ADAPTER ?? config.adapter) as EvalAdapter
const artifactRoot = resolve(config.artifactDirectory, config.runId, adapter)
const databasePath = resolve(artifactRoot, config.databaseFileName)

function pendingSourceWork(): PendingWorkRecord {
	return {
		id: config.sourceWorkId,
		attempt_id: config.sourceAttemptId,
		input_ids: [config.sourceInputId],
		inputs: [{ id: config.sourceInputId, text: dataset.sourceText }],
		status: 'pending',
		retry_count: 0,
		available_at: config.createdAt,
		created_at: config.createdAt,
		updated_at: config.createdAt,
	}
}

function observerCommit(): LearningCommitInput {
	return {
		logical_attempt_id: config.sourceAttemptId,
		pending_work_id: config.sourceWorkId,
		expected_memory_revision: 0,
		expected_config_revision: 0,
		input_ids: [config.sourceInputId],
		outcome: 'change',
		observations: {
			add: [{
				id: config.observationId,
				data: dataset.observationData,
				metadata_importance: dataset.observationImportance,
				metadata_tokens: dataset.observationTokens,
				metadata_status: 'pending',
				metadata_created_at: config.committedAt,
			}],
			mark_processed_ids: [],
		},
		history: {
			id: config.observerHistoryId,
			attempt_id: config.sourceAttemptId,
			outcome: 'change',
			previous_memory_revision: 0,
			memory_revision: 1,
			config_revision: 0,
			input_ids: [config.sourceInputId],
			change_ids: [],
			created_at: config.committedAt,
		},
		changes: [],
		outbox: [],
		committed_at: config.committedAt,
	}
}

function synthesisWork(): PendingWorkRecord {
	return {
		id: config.synthesisWorkId,
		attempt_id: config.synthesisAttemptId,
		input_ids: [config.observationId],
		status: 'pending',
		retry_count: 0,
		available_at: config.committedAt,
		created_at: config.committedAt,
		updated_at: config.committedAt,
	}
}

function synthesisCommit(): LearningCommitInput {
	return {
		logical_attempt_id: config.synthesisAttemptId,
		pending_work_id: config.synthesisWorkId,
		expected_memory_revision: 1,
		expected_config_revision: 0,
		input_ids: [config.observationId],
		outcome: 'change',
		patch: {
			type: 'replace',
			records: [{
				id: config.memoryId,
				data: dataset.learnedUnderstanding,
				metadata_confidence: null,
				metadata_confidence_provenance: 'unknown',
				metadata_created_at: config.committedAt,
				metadata_updated_at: config.committedAt,
			}],
		},
		observations: { add: [], mark_processed_ids: [config.observationId] },
		evolution_records: [{
			id: config.evolutionId,
			summary: dataset.evolutionSummary,
			reasoning: dataset.evolutionReasoning,
			significance: dataset.evolutionSignificance,
			created_at: config.committedAt,
		}],
		history: {
			id: config.synthesisHistoryId,
			attempt_id: config.synthesisAttemptId,
			outcome: 'change',
			previous_memory_revision: 1,
			memory_revision: 2,
			config_revision: 0,
			input_ids: [config.observationId],
			change_ids: [config.changeId],
			explanation: dataset.historyExplanation,
			created_at: config.committedAt,
		},
		changes: [{
			id: config.changeId,
			attempt_id: config.synthesisAttemptId,
			memory_revision: 2,
			kind: config.changeKind,
			affected_memory_ids: [config.memoryId],
			summary: dataset.changeSummary,
			created_at: config.committedAt,
		}],
		outbox: [{
			id: config.outboxId,
			kind: config.outboxKind,
			deduplication_key: config.deduplicationKey,
			change_ids: [config.changeId],
			status: 'pending',
			attempts: 0,
			available_at: config.committedAt,
			created_at: config.committedAt,
			updated_at: config.committedAt,
		}],
		committed_at: config.committedAt,
	}
}

let memoryStore: NeuronStore | undefined

async function openStore(options: LearningStoreOptions): Promise<NeuronStore> {
	if (adapter === 'memory') {
		if (!memoryStore) {
			const { MemoryNeuronStore } = await import('../../src/stores')
			memoryStore = new MemoryNeuronStore(options)
		}
		return memoryStore
	}
	if (adapter === 'sqlite-bun') {
		const { SQLiteNeuronStore } = await import('../../src/sqlite/bun')
		return new SQLiteNeuronStore(databasePath, options)
	}
	const { SQLiteNeuronStore } = await import('../../src/sqlite')
	return new SQLiteNeuronStore(databasePath, options)
}

async function reconnect(store: NeuronStore, options: LearningStoreOptions): Promise<NeuronStore> {
	if (adapter === 'memory') return store
	await store.dispose()
	return openStore(options)
}

async function inspectStore(store: NeuronStore): Promise<Record<string, unknown>> {
	return {
		understanding: await store.understanding.list(),
		observations: await store.observations.list(),
		evolution: await store.evolution.list(),
		learningHistory: await store.learningHistory.list(),
		memoryChanges: await store.memoryChanges.list(),
		pendingWork: await store.pendingWork.list(),
		pendingInputs: await store.pendingInputs.list(),
		processedInputs: await store.processedInputs.list(),
		outbox: await store.outbox.list(),
		learningAttempts: await store.learningAttempts.list(),
		learningRevisions: await store.learningRevisions.list(),
	}
}

function saveJson(name: string, value: unknown): void {
	writeFileSync(resolve(artifactRoot, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function main(): Promise<void> {
	if (existsSync(artifactRoot) || existsSync(databasePath)) {
		throw new Error(`Eval artifact or database path already exists: ${artifactRoot}`)
	}
	mkdirSync(artifactRoot, { recursive: true })
	writeFileSync(resolve(artifactRoot, 'supplied-config.raw.json'), suppliedConfigRaw)
	writeFileSync(resolve(artifactRoot, 'supplied-dataset.raw.json'), suppliedDatasetRaw)

	const sourceWork = pendingSourceWork()
	const observe = observerCommit()
	const synthesis = synthesisCommit()
	const synthWork = synthesisWork()
	const changedSynthesisIntent = structuredClone(synthesis)
	changedSynthesisIntent.history.explanation = dataset.changedIntentExplanation
	saveJson('constructed-input.raw.json', { sourceWork, observe, synthWork, synthesis, changedSynthesisIntent })

	let faultEnabled = false
	let injectedFailure: Error | undefined
	const options: LearningStoreOptions = {
		onCommitStage(stage) {
			if (faultEnabled && stage === config.failureStage) {
				injectedFailure = new Error(config.failureMessage)
				throw injectedFailure
			}
		},
	}

	let store = await openStore(options)
	const sourceEnqueue = await store.learning.enqueue({ work: sourceWork })
	const observerResult = await store.learning.commit(observe)
	store = await reconnect(store, options)
	const afterObserverReconnect = await inspectStore(store)

	const synthesisEnqueue = await store.learning.enqueue({ work: synthWork })
	faultEnabled = true
	const failedSynthesisResult = await store.learning.commit(synthesis)
	faultEnabled = false
	const immediatelyAfterFailure = await inspectStore(store)
	store = await reconnect(store, options)
	const afterFailureReconnect = await inspectStore(store)
	const synthesisResult = await store.learning.commit(synthesis)
	store = await reconnect(store, options)
	const afterSynthesisReconnect = await inspectStore(store)
	const duplicateSynthesisResult = await store.learning.commit(synthesis)
	const changedIntentResult = await store.learning.commit(changedSynthesisIntent)
	const finalState = await inspectStore(store)

	saveJson('output.raw.json', {
		sourceEnqueue,
		observerResult,
		afterObserverReconnect,
		synthesisEnqueue,
		failedSynthesisResult,
		immediatelyAfterFailure,
		afterFailureReconnect,
		synthesisResult,
		afterSynthesisReconnect,
		duplicateSynthesisResult,
		changedIntentResult,
		finalState,
	})
	saveJson('failure.raw.json', injectedFailure)
	writeFileSync(
		resolve(artifactRoot, 'failure.inspect.txt'),
		`${inspect(injectedFailure, { depth: null, maxArrayLength: null, maxStringLength: null })}\n`,
	)
	saveJson('metadata.json', {
		run_id: config.runId,
		adapter,
		config_path: configPath,
		dataset_path: datasetPath,
		database_path: adapter === 'memory' ? null : databasePath,
		reconnect_scope: adapter === 'memory' ? 'same MemoryNeuronStore instance' : 'closed and reopened SQLiteNeuronStore instance in the same process',
	})
	await store.dispose()
}

await main()
