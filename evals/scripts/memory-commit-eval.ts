/**
 * Mechanical atomic learning persistence eval. It writes exact supplied and
 * constructed inputs, exact store outputs, and original injected failures.
 * It makes no automated quality judgment and does not call a model.
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

interface CommitScenario {
	workId: string
	attemptId: string
	inputId: string
	rawText: string
	learnedText: string
	historyId: string
	changeId: string
	outboxId: string
	deduplicationKey: string
}

interface EvalConfig {
	adapter: EvalAdapter
	artifactDirectory: string
	runId: string
	databaseFileName: string
	createdAt: string
	committedAt: string
	memoryId: string
	changeKind: string
	outboxKind: string
	failureStage: LearningCommitStage
	failureMessage: string
	whole: CommitScenario
	partial: CommitScenario & {
		residualWorkId: string
		residualAttemptId: string
		residualInputId: string
		residualRawText: string
		residualHistoryId: string
	}
}

const suppliedConfigPath = process.env.MEMORY_COMMIT_EVAL_CONFIG
if (!suppliedConfigPath) throw new Error('MEMORY_COMMIT_EVAL_CONFIG is required')
const configPath = resolve(suppliedConfigPath)
const suppliedRaw = readFileSync(configPath, 'utf8')
const config = JSON.parse(suppliedRaw) as EvalConfig
const adapter = (process.env.MEMORY_COMMIT_EVAL_ADAPTER ?? config.adapter) as EvalAdapter
const artifactRoot = resolve(config.artifactDirectory, config.runId, adapter)
const databasePath = resolve(artifactRoot, config.databaseFileName)

function pending(
	workId: string,
	attemptId: string,
	inputs: Array<{ id: string; text: string }>,
): PendingWorkRecord {
	return {
		id: workId,
		attempt_id: attemptId,
		input_ids: inputs.map(({ id }) => id),
		inputs,
		status: 'pending',
		retry_count: 0,
		available_at: config.createdAt,
		created_at: config.createdAt,
		updated_at: config.createdAt,
	}
}

function changeCommit(
	scenario: CommitScenario,
	expectedMemoryRevision: number,
	inputIds = [scenario.inputId],
): LearningCommitInput {
	const memoryRevision = expectedMemoryRevision + 1
	return {
		logical_attempt_id: scenario.attemptId,
		pending_work_id: scenario.workId,
		expected_memory_revision: expectedMemoryRevision,
		expected_config_revision: 0,
		input_ids: inputIds,
		outcome: 'change',
		patch: {
			type: 'replace',
			records: [{
				id: config.memoryId,
				data: scenario.learnedText,
				metadata_confidence: null,
				metadata_confidence_provenance: 'unknown',
				metadata_created_at: config.createdAt,
				metadata_updated_at: config.committedAt,
			}],
		},
		history: {
			id: scenario.historyId,
			attempt_id: scenario.attemptId,
			outcome: 'change',
			previous_memory_revision: expectedMemoryRevision,
			memory_revision: memoryRevision,
			config_revision: 0,
			input_ids: inputIds,
			change_ids: [scenario.changeId],
			explanation: scenario.learnedText,
			created_at: config.committedAt,
		},
		changes: [{
			id: scenario.changeId,
			attempt_id: scenario.attemptId,
			memory_revision: memoryRevision,
			kind: config.changeKind,
			affected_memory_ids: [config.memoryId],
			summary: scenario.learnedText,
			created_at: config.committedAt,
		}],
		outbox: [{
			id: scenario.outboxId,
			kind: config.outboxKind,
			deduplication_key: scenario.deduplicationKey,
			change_ids: [scenario.changeId],
			status: 'pending',
			attempts: 0,
			available_at: config.committedAt,
			created_at: config.committedAt,
			updated_at: config.committedAt,
		}],
		committed_at: config.committedAt,
	}
}

function noChangeResidual(expectedMemoryRevision: number): LearningCommitInput {
	const partial = config.partial
	return {
		logical_attempt_id: partial.residualAttemptId,
		pending_work_id: partial.residualWorkId,
		expected_memory_revision: expectedMemoryRevision,
		expected_config_revision: 0,
		input_ids: [partial.residualInputId],
		outcome: 'no-change',
		history: {
			id: partial.residualHistoryId,
			attempt_id: partial.residualAttemptId,
			outcome: 'no-change',
			previous_memory_revision: expectedMemoryRevision,
			memory_revision: expectedMemoryRevision,
			config_revision: 0,
			input_ids: [partial.residualInputId],
			change_ids: [],
			created_at: config.committedAt,
		},
		changes: [],
		outbox: [],
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
	writeFileSync(resolve(artifactRoot, 'supplied-input.raw.json'), suppliedRaw)

	const wholeWork = pending(config.whole.workId, config.whole.attemptId, [{ id: config.whole.inputId, text: config.whole.rawText }])
	const wholeCommit = changeCommit(config.whole, 0)
	const partialWork = pending(config.partial.workId, config.partial.attemptId, [
		{ id: config.partial.inputId, text: config.partial.rawText },
		{ id: config.partial.residualInputId, text: config.partial.residualRawText },
	])
	const partialCommit: LearningCommitInput = {
		...changeCommit(config.partial, 1),
		remaining_work: {
			id: config.partial.residualWorkId,
			attempt_id: config.partial.residualAttemptId,
			input_ids: [config.partial.residualInputId],
			status: 'pending',
			retry_count: 0,
			available_at: config.committedAt,
			created_at: config.committedAt,
			updated_at: config.committedAt,
		},
	}
	const residualCommit = noChangeResidual(2)
	saveJson('constructed-input.raw.json', {
		wholeWork,
		wholeCommit,
		partialWork,
		partialCommit,
		residualCommit,
	})

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
	const wholeEnqueue = await store.learning.enqueue({ work: wholeWork })
	const wholeResult = await store.learning.commit(wholeCommit)
	store = await reconnect(store, options)
	const afterWholeReconnect = await inspectStore(store)

	const partialEnqueue = await store.learning.enqueue({ work: partialWork })
	faultEnabled = true
	const failedPartialResult = await store.learning.commit(partialCommit)
	faultEnabled = false
	const immediatelyAfterFailure = await inspectStore(store)
	store = await reconnect(store, options)
	const afterFailureReconnect = await inspectStore(store)
	const partialResult = await store.learning.commit(partialCommit)
	store = await reconnect(store, options)
	const afterPartialReconnect = await inspectStore(store)
	const duplicateParentResult = await store.learning.commit(partialCommit)
	const residualResult = await store.learning.commit(residualCommit)
	store = await reconnect(store, options)
	const finalAfterReconnect = await inspectStore(store)

	saveJson('output.raw.json', {
		wholeEnqueue,
		wholeResult,
		afterWholeReconnect,
		partialEnqueue,
		failedPartialResult,
		immediatelyAfterFailure,
		afterFailureReconnect,
		partialResult,
		afterPartialReconnect,
		duplicateParentResult,
		residualResult,
		finalAfterReconnect,
	})
	saveJson('failure.raw.json', injectedFailure)
	writeFileSync(resolve(artifactRoot, 'failure.inspect.txt'), `${inspect(injectedFailure, { depth: null, maxArrayLength: null, maxStringLength: null })}\n`)
	saveJson('metadata.json', {
		run_id: config.runId,
		adapter,
		config_path: configPath,
		database_path: adapter === 'memory' ? null : databasePath,
	})
	await store.dispose()
}

await main()
