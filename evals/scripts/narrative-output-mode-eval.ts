/**
 * Compares the production narrative recipe's edit-action and plain-text
 * output modes, then commits accepted results through SQLite and reopens it.
 * This is an isolated recipe + store eval, not a Brain or observer pipeline.
 *
 * Run:
 *   npx tsx evals/scripts/narrative-output-mode-eval.ts <config-path>
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateText, Output } from 'ai'
import { z } from 'zod'

import {
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	learningLensValueSchema,
	learningObservationsValueSchema,
	planRecipe,
	registerNarrativeRecipe,
	runRecipe,
	stringArrayValueSchema,
	textMemorySnapshotValueSchema,
	type BudgetClaim,
	type LearningGenerationRequest,
	type LearningModelCapability,
	type LearningTextGenerationRequest,
	type RecipeExecution,
} from '../../src/learning/index'
import type { AdaptFinishReason } from '../../src/llm/index'
import { SQLiteNeuronStore } from '../../src/sqlite'
import type {
	LearningCommitInput,
	NeuronStore,
	PendingWorkRecord,
	UnderstandingRecord,
} from '../../src/stores'
import {
	createObservedModel,
	generationSettings,
	modelCapabilityLadderSupport,
	runId,
	sha256,
	writeEvidence,
	writeJson,
	type CapabilityDataset,
	type RecipeStage,
} from './model-capability-ladder-eval'

const outputModeSchema = z.enum(['edit-action', 'plain-text'])
export type NarrativeOutputMode = z.infer<typeof outputModeSchema>

const configSchema = z
	.object({
		schemaVersion: z.literal(1),
		provider: z
			.object({
				name: z.string().min(1),
				baseUrl: z.string().url(),
				modelId: z.string().min(1),
				apiKeyEnv: z.string().min(1).optional(),
			})
			.strict(),
		settings: z
			.object({
				temperature: z.number(),
				maxOutputTokens: z.number().int().positive(),
				maxRetries: z.number().int().nonnegative(),
				timeoutMs: z.number().int().positive(),
			})
			.strict(),
		repetitions: z.number().int().positive(),
		datasetPath: z.string().min(1),
		sourceStageId: z.string().min(1),
		arms: z.tuple([
			z.literal('edit-action'),
			z.literal('plain-text'),
		]),
		outputRoot: z.string().min(1),
		databaseFileName: z.string().min(1),
		ids: z
			.object({
				recipeId: z.string().min(1),
				recipeVersion: z.string().min(1),
				registryRevision: z.string().min(1),
				memoryId: z.string().min(1),
				prefix: z.string().min(1),
			})
			.strict(),
		planning: z
			.object({
				maxNodes: z.number().int().positive(),
				maxCollectionItems: z.number().int().positive(),
				maxOperations: z.number().int().positive(),
			})
			.strict(),
		execution: z
			.object({ maxClaims: z.number().int().positive() })
			.strict(),
		observedAt: z.string().datetime(),
		committedAt: z.string().datetime(),
	})
	.strict()

export type NarrativeOutputModeConfig = z.infer<typeof configSchema>

export interface FrozenNarrativeCase {
	readonly id: string
	readonly description: string
	readonly stage: RecipeStage
}

export function selectFrozenCases(
	dataset: CapabilityDataset,
	sourceStageId: string,
): readonly FrozenNarrativeCase[] {
	return dataset.cases.map((suppliedCase) => {
		const matches = suppliedCase.stages.filter(
			(stage) => stage.id === sourceStageId,
		)
		if (matches.length !== 1 || matches[0]?.kind !== 'recipe') {
			throw new Error(
				`case ${suppliedCase.id} requires exactly one recipe stage ${sourceStageId}`,
			)
		}
		return {
			id: suppliedCase.id,
			description: suppliedCase.description,
			stage: matches[0],
		}
	})
}

function normalizeFinishReason(reason: string): AdaptFinishReason {
	if (reason === 'stop' || reason === 'length' || reason === 'error') {
		return reason
	}
	if (reason === 'tool-calls') return 'tool-calls'
	return 'unknown'
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function pendingWork(
	id: string,
	attemptId: string,
	inputIds: readonly string[],
	timestamp: string,
	inputs?: readonly { readonly id: string; readonly text: string }[],
): PendingWorkRecord {
	return {
		id,
		attempt_id: attemptId,
		input_ids: [...inputIds],
		...(inputs === undefined
			? {}
			: { inputs: inputs.map((input) => ({ ...input })) }),
		status: 'pending',
		retry_count: 0,
		available_at: timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
}

function understanding(
	memoryId: string,
	text: string,
	timestamp: string,
): UnderstandingRecord {
	return {
		id: memoryId,
		data: text,
		metadata_confidence: null,
		metadata_confidence_provenance: 'unknown',
		metadata_created_at: timestamp,
		metadata_updated_at: timestamp,
	}
}

function commitHistory(
	id: string,
	attemptId: string,
	inputIds: readonly string[],
	previousRevision: number,
	nextRevision: number,
	configRevision: number,
	timestamp: string,
	explanation?: string,
) {
	return {
		id,
		attempt_id: attemptId,
		outcome: 'change' as const,
		previous_memory_revision: previousRevision,
		memory_revision: nextRevision,
		config_revision: configRevision,
		input_ids: [...inputIds],
		change_ids: [],
		...(explanation === undefined ? {} : { explanation }),
		created_at: timestamp,
	}
}

function identifiers(
	config: NarrativeOutputModeConfig,
	caseId: string,
) {
	const stem = `${config.ids.prefix}:${caseId}`
	return {
		setupInput: `${stem}:setup-input`,
		setupWork: `${stem}:setup-work`,
		setupAttempt: `${stem}:setup-attempt`,
		setupHistory: `${stem}:setup-history`,
		sourceInput: `${stem}:source-input`,
		observerWork: `${stem}:observer-work`,
		observerAttempt: `${stem}:observer-attempt`,
		observerHistory: `${stem}:observer-history`,
		observation: `${caseId}:observation`,
		synthesisWork: `${stem}:synthesis-work`,
		synthesisAttempt: `${stem}:synthesis-attempt`,
		synthesisHistory: `${stem}:synthesis-history`,
	}
}

async function snapshotStore(store: NeuronStore): Promise<Record<string, unknown>> {
	return {
		understanding: await store.understanding.list(),
		observations: await store.observations.list(),
		evolution: await store.evolution.list(),
		state: await store.state.list(),
		learningHistory: await store.learningHistory.list(),
		memoryChanges: await store.memoryChanges.list(),
		pendingWork: await store.pendingWork.list(),
		pendingInputs: await store.pendingInputs.list(),
		processedInputs: await store.processedInputs.list(),
		outbox: await store.outbox.list(),
		learningAttempts: await store.learningAttempts.list(),
		learningRevisions: await store.learningRevisions.list(),
		revisions: await store.learning.getRevisions(),
	}
}

async function seedCurrentMemory(
	store: NeuronStore,
	config: NarrativeOutputModeConfig,
	ids: ReturnType<typeof identifiers>,
	text: string,
	stageDirectory: string,
): Promise<void> {
	if (text.length === 0) return
	const work = pendingWork(
		ids.setupWork,
		ids.setupAttempt,
		[ids.setupInput],
		config.committedAt,
		[{ id: ids.setupInput, text }],
	)
	const enqueue = await store.learning.enqueue({ work })
	writeEvidence(stageDirectory, 'setup-enqueue', { work, result: enqueue })
	if (enqueue.status !== 'queued') {
		throw new Error(`setup enqueue failed: ${JSON.stringify(enqueue)}`)
	}
	const revisions = await store.learning.getRevisions()
	const commit: LearningCommitInput = {
		logical_attempt_id: ids.setupAttempt,
		pending_work_id: ids.setupWork,
		expected_memory_revision: revisions.memory_revision,
		expected_config_revision: revisions.config_revision,
		input_ids: [ids.setupInput],
		outcome: 'change',
		patch: {
			type: 'replace',
			records: [understanding(config.ids.memoryId, text, config.committedAt)],
		},
		history: commitHistory(
			ids.setupHistory,
			ids.setupAttempt,
			[ids.setupInput],
			revisions.memory_revision,
			revisions.memory_revision + 1,
			revisions.config_revision,
			config.committedAt,
		),
		changes: [],
		outbox: [],
		committed_at: config.committedAt,
	}
	const result = await store.learning.commit(commit)
	writeEvidence(stageDirectory, 'setup-commit', { input: commit, result })
	if (result.status !== 'committed') {
		throw new Error(`setup commit failed: ${JSON.stringify(result)}`)
	}
}

async function commitFrozenObservation(
	store: NeuronStore,
	config: NarrativeOutputModeConfig,
	ids: ReturnType<typeof identifiers>,
	text: string,
	stageDirectory: string,
): Promise<void> {
	const work = pendingWork(
		ids.observerWork,
		ids.observerAttempt,
		[ids.sourceInput],
		config.committedAt,
		[{ id: ids.sourceInput, text }],
	)
	const enqueue = await store.learning.enqueue({ work })
	writeEvidence(stageDirectory, 'observer-enqueue', { work, result: enqueue })
	if (enqueue.status !== 'queued') {
		throw new Error(`observer enqueue failed: ${JSON.stringify(enqueue)}`)
	}
	const revisions = await store.learning.getRevisions()
	const commit: LearningCommitInput = {
		logical_attempt_id: ids.observerAttempt,
		pending_work_id: ids.observerWork,
		expected_memory_revision: revisions.memory_revision,
		expected_config_revision: revisions.config_revision,
		input_ids: [ids.sourceInput],
		outcome: 'change',
		observations: {
			add: [
				{
					id: ids.observation,
					data: text,
					metadata_importance: 1,
					metadata_tokens: 0,
					metadata_status: 'pending',
					metadata_created_at: config.observedAt,
				},
			],
			mark_processed_ids: [],
		},
		history: commitHistory(
			ids.observerHistory,
			ids.observerAttempt,
			[ids.sourceInput],
			revisions.memory_revision,
			revisions.memory_revision + 1,
			revisions.config_revision,
			config.committedAt,
		),
		changes: [],
		outbox: [],
		committed_at: config.committedAt,
	}
	const result = await store.learning.commit(commit)
	writeEvidence(stageDirectory, 'observer-commit', { input: commit, result })
	if (result.status !== 'committed') {
		throw new Error(`observer commit failed: ${JSON.stringify(result)}`)
	}
}

function createLearningModel(
	config: NarrativeOutputModeConfig,
	stageDirectory: string,
): LearningModelCapability {
	const model = createObservedModel(config, stageDirectory)
	let callCount = 0
	return {
		async generate<T>(request: LearningGenerationRequest<T>) {
			callCount += 1
			try {
				const result = await generateText({
					model,
					system: request.system,
					prompt: request.prompt,
					output: Output.object({ schema: request.schema }),
					abortSignal: request.signal,
					...generationSettings(config),
				})
				writeEvidence(stageDirectory, `model-output-${callCount}`, result)
				return {
					value: result.output as T,
					raw: result,
					usage: result.usage,
				}
			} catch (error) {
				writeEvidence(stageDirectory, `model-error-${callCount}`, error)
				throw error
			}
		},
		async generateText(request: LearningTextGenerationRequest) {
			callCount += 1
			try {
				const result = await generateText({
					model,
					system: request.system,
					prompt: request.prompt,
					abortSignal: request.signal,
					...generationSettings(config),
				})
				writeEvidence(stageDirectory, `model-output-${callCount}`, result)
				return {
					value: result.text,
					raw: result,
					usage: result.usage,
					finishReason: normalizeFinishReason(result.finishReason),
				}
			} catch (error) {
				writeEvidence(stageDirectory, `model-error-${callCount}`, error)
				throw error
			}
		},
		async decide(): Promise<never> {
			throw new Error('narrative output-mode eval does not use decisions')
		},
	}
}

async function executeRecipe(
	store: NeuronStore,
	config: NarrativeOutputModeConfig,
	arm: NarrativeOutputMode,
	suppliedCase: FrozenNarrativeCase,
	ids: ReturnType<typeof identifiers>,
	stageDirectory: string,
): Promise<{
	execution: RecipeExecution
	input: Record<string, unknown>
	revisions: { memory_revision: number; config_revision: number }
}> {
	const synthesisWork = pendingWork(
		ids.synthesisWork,
		ids.synthesisAttempt,
		[ids.observation],
		config.committedAt,
	)
	const enqueue = await store.learning.enqueue({ work: synthesisWork })
	writeEvidence(stageDirectory, 'synthesis-enqueue', {
		work: synthesisWork,
		result: enqueue,
	})
	if (enqueue.status !== 'queued') {
		throw new Error(`synthesis enqueue failed: ${JSON.stringify(enqueue)}`)
	}
	const revisions = await store.learning.getRevisions()
	const current = await store.understanding.get(config.ids.memoryId)
	const processed = await store.processedInputs.list()
	const lens = suppliedCase.stage.lens
	const memory = {
		id: config.ids.memoryId,
		revision: revisions.memory_revision,
		text: typeof current?.data === 'string' ? current.data : '',
		processedInputIds: processed.map(({ id }) => id),
	}
	const observations = [
		{
			id: ids.observation,
			text: suppliedCase.stage.observation,
			observedAt: config.observedAt,
		},
	]
	const input = {
		outputMode: arm,
		lens,
		memory,
		observations,
		processedInputIds: memory.processedInputIds,
		recipeLimits: suppliedCase.stage.recipeLimits,
	}
	writeJson(resolve(stageDirectory, 'raw-input.json'), input)

	const registry = new LearningRegistry()
	registerNarrativeRecipe(registry, {
		recipeId: config.ids.recipeId,
		version: config.ids.recipeVersion,
		outputMode: arm,
		...suppliedCase.stage.recipeLimits,
	})
	const roots = {
		lens: { schema: learningLensValueSchema, value: lens },
		memory: { schema: textMemorySnapshotValueSchema, value: memory },
		observations: {
			schema: learningObservationsValueSchema,
			value: observations,
		},
		processedInputIds: {
			schema: stringArrayValueSchema,
			value: memory.processedInputIds,
		},
	}
	const plan = planRecipe(registry, {
		recipe: { id: config.ids.recipeId, version: config.ids.recipeVersion },
		roots,
		memoryType: 'text',
		availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
		revisions: {
			memory: revisions.memory_revision,
			configuration: revisions.config_revision,
			registry: config.ids.registryRevision,
		},
		limits: config.planning,
	})
	const claims: BudgetClaim[] = []
	const learningModel = createLearningModel(config, stageDirectory)
	const execution = await runRecipe(plan, {
		signal: new AbortController().signal,
		capabilities: {
			has: (id) => id === LEARNING_MODEL_CAPABILITY,
			get: <T>(id: string) =>
				id === LEARNING_MODEL_CAPABILITY
					? (learningModel as T)
					: undefined,
		},
		budget: {
			claim(claim) {
				if (claims.length >= config.execution.maxClaims) return false
				claims.push(claim)
				return true
			},
			snapshot: () => ({ claims: [...claims] }),
		},
	})
	writeEvidence(stageDirectory, 'recipe-execution', execution)
	return { execution, input, revisions }
}

export function synthesisCommit(
	config: NarrativeOutputModeConfig,
	ids: ReturnType<typeof identifiers>,
	execution: RecipeExecution,
	currentRevision: number,
	configRevision: number,
): LearningCommitInput | undefined {
	if (
		execution.result.outcome !== 'change' &&
		execution.result.outcome !== 'no_change'
	) {
		return undefined
	}
	const consumed = execution.result.consumedInputIds ?? []
	if (!consumed.includes(ids.observation)) return undefined
	let patch: LearningCommitInput['patch']
	if (execution.result.outcome === 'change') {
		const value = execution.result.patch as {
			readonly kind?: unknown
			readonly memoryId?: unknown
			readonly text?: unknown
		}
		if (
			value.kind !== 'replace_text' ||
			value.memoryId !== config.ids.memoryId ||
			typeof value.text !== 'string'
		) {
			throw new Error('narrative recipe returned an invalid text patch')
		}
		patch = {
			type: 'replace',
			records: [
				understanding(config.ids.memoryId, value.text, config.committedAt),
			],
		}
	}
	return {
		logical_attempt_id: ids.synthesisAttempt,
		pending_work_id: ids.synthesisWork,
		expected_memory_revision: currentRevision,
		expected_config_revision: configRevision,
		input_ids: [ids.observation],
		outcome: 'change',
		...(patch === undefined ? {} : { patch }),
		observations: { add: [], mark_processed_ids: [ids.observation] },
		history: commitHistory(
			ids.synthesisHistory,
			ids.synthesisAttempt,
			[ids.observation],
			currentRevision,
			currentRevision + 1,
			configRevision,
			config.committedAt,
			'explanation' in execution.result &&
				typeof execution.result.explanation === 'string'
				? execution.result.explanation
				: undefined,
		),
		changes: [],
		outbox: [],
		committed_at: config.committedAt,
	}
}

async function runStage(
	config: NarrativeOutputModeConfig,
	suppliedCase: FrozenNarrativeCase,
	arm: NarrativeOutputMode,
	stageDirectory: string,
): Promise<void> {
	const ids = identifiers(config, suppliedCase.id)
	const databasePath = resolve(stageDirectory, config.databaseFileName)
	let store: NeuronStore = new SQLiteNeuronStore(databasePath)
	let closed = false
	try {
		await seedCurrentMemory(
			store,
			config,
			ids,
			suppliedCase.stage.currentMemory,
			stageDirectory,
		)
		await commitFrozenObservation(
			store,
			config,
			ids,
			suppliedCase.stage.observation,
			stageDirectory,
		)
		const { execution, revisions } = await executeRecipe(
			store,
			config,
			arm,
			suppliedCase,
			ids,
			stageDirectory,
		)
		const commit = synthesisCommit(
			config,
			ids,
			execution,
			revisions.memory_revision,
			revisions.config_revision,
		)
		if (commit !== undefined) {
			const result = await store.learning.commit(commit)
			writeEvidence(stageDirectory, 'synthesis-commit', {
				input: commit,
				result,
			})
			if (result.status !== 'committed') {
				throw new Error(`synthesis commit failed: ${JSON.stringify(result)}`)
			}
		} else {
			writeEvidence(stageDirectory, 'synthesis-commit', {
				input: null,
				result: { status: 'not-attempted', outcome: execution.result.outcome },
			})
		}
		writeEvidence(
			stageDirectory,
			'store-before-close',
			await snapshotStore(store),
		)
		await store.dispose()
		closed = true
		store = new SQLiteNeuronStore(databasePath)
		closed = false
		writeEvidence(
			stageDirectory,
			'store-after-reopen',
			await snapshotStore(store),
		)
	} catch (error) {
		writeEvidence(stageDirectory, 'stage-error', error)
		try {
			writeEvidence(
				stageDirectory,
				'store-before-close',
				await snapshotStore(store),
			)
		} catch (snapshotError) {
			writeEvidence(stageDirectory, 'snapshot-error', snapshotError)
		}
		throw error
	} finally {
		if (!closed) await store.dispose()
	}
}

function writeSourceIdentifiers(
	config: NarrativeOutputModeConfig,
	runDirectory: string,
	configPath: string,
	datasetPath: string,
): void {
	const repositoryRoot = resolve(import.meta.dirname, '../..')
	const sourceFiles = [
		'evals/scripts/model-capability-ladder-eval.ts',
		'evals/scripts/narrative-output-mode-eval.ts',
		'src/learning/recipes/narrative.ts',
		'src/learning/recipes/provider.ts',
		'src/learning/recipes/types.ts',
		'src/learning/executor.ts',
		'src/learning/planner.ts',
		'src/stores/internal/learning.ts',
		'src/stores/sqlite/node/neuron.ts',
	]
	writeJson(resolve(runDirectory, 'source-identifiers.json'), {
		runtime: {
			node: process.version,
			platform: process.platform,
			architecture: process.arch,
		},
		repository: {
			revision: execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
				encoding: 'utf8',
			}).trim(),
			status: execFileSync('git', ['-C', repositoryRoot, 'status', '--short'], {
				encoding: 'utf8',
			}).trim(),
		},
		model: { provider: config.provider, settings: config.settings },
		inputs: {
			config: { path: configPath, sha256: sha256(readFileSync(configPath)) },
			dataset: { path: datasetPath, sha256: sha256(readFileSync(datasetPath)) },
		},
		sourceFiles: sourceFiles.map((path) => ({
			path,
			sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
		})),
	})
}

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2]
	if (suppliedConfigPath === undefined) {
		throw new Error('provide a narrative output-mode config path')
	}
	const configPath = resolve(suppliedConfigPath)
	const configRaw = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configRaw) as unknown)
	const datasetPath = resolve(config.datasetPath)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = modelCapabilityLadderSupport.datasetSchema.parse(
		JSON.parse(datasetRaw) as unknown,
	)
	const cases = selectFrozenCases(dataset, config.sourceStageId)
	const runDirectory = resolve(config.outputRoot, runId())
	mkdirSync(runDirectory, { recursive: true })
	writeFileSync(resolve(runDirectory, 'supplied-config.raw.json'), configRaw)
	writeFileSync(resolve(runDirectory, 'supplied-dataset.raw.json'), datasetRaw)
	writeSourceIdentifiers(config, runDirectory, configPath, datasetPath)

	let stageCount = 0
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		for (const [caseIndex, suppliedCase] of cases.entries()) {
			for (const [armIndex, arm] of config.arms.entries()) {
				stageCount += 1
				const stageDirectory = resolve(
					runDirectory,
					`repeat-${String(repetition).padStart(2, '0')}`,
					`case-${String(caseIndex + 1).padStart(2, '0')}`,
					`arm-${String(armIndex + 1).padStart(2, '0')}-${arm}`,
				)
				mkdirSync(stageDirectory, { recursive: true })
				writeJson(resolve(stageDirectory, 'metadata.json'), {
					repetition,
					caseId: suppliedCase.id,
					caseDescription: suppliedCase.description,
					sourceStageId: config.sourceStageId,
					arm,
					scope: 'isolated production narrative recipe plus SQLite commit/reopen; no Brain or observer pipeline',
					grading: null,
				})
				console.log(
					`[${stageCount}] repeat ${repetition}/${config.repetitions} ${suppliedCase.id}/${arm}`,
				)
				try {
					await runStage(
						config,
						suppliedCase,
						arm,
						stageDirectory,
					)
				} catch (error) {
					console.error(
						`stage failed ${suppliedCase.id}/${arm}: ${errorMessage(error)}`,
					)
				}
			}
		}
	}
	writeJson(resolve(runDirectory, 'metadata.json'), {
		completedAt: new Date().toISOString(),
		stageCount,
		providerCallExpectation: stageCount,
		scope: 'isolated production narrative recipe plus SQLite commit/reopen; no Brain or observer pipeline',
		grading: null,
	})
	console.log(runDirectory)
}

export const narrativeOutputModeSupport = {
	configSchema,
	selectFrozenCases,
	normalizeFinishReason,
}

const entryPoint = process.argv[1]
if (
	entryPoint !== undefined &&
	import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
	await main()
}
