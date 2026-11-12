/**
 * Runs one arm of the fixed, unjudged v1 TextNeuron versus v2 text-DAG
 * comparison. The v2 module is imported lazily so the v1 arm can be
 * typechecked and run independently.
 *
 * Run:
 *   npx tsx evals/scripts/text-dag-comparison-eval.ts <config> --arm v1
 *   npx tsx evals/scripts/text-dag-comparison-eval.ts <config> --arm v2 --run-directory <v1 run directory>
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import type { LearningGenerationRequest, LearningModelCapability } from '../../src/learning'
import type { AdaptLLMPlugin, AdaptUsage, LanguageModel } from '../../src/llm'
import type { TextDagDependencies, TextDagLearner } from '../../src/neurons/text/dag'
import type { NeuronStore } from '../../src/stores'

const modelSettingsSchema = z.object({
	temperature: z.number().optional(),
	seed: z.number().int().optional(),
	maxOutputTokens: z.number().int().positive().optional(),
}).strict()

const configSchema = z.object({
	schemaVersion: z.literal(1),
	label: z.literal('UNJUDGED'),
	baseline: z.object({
		root: z.string().min(1),
		revision: z.string().min(1),
	}).strict(),
	provider: z.object({
		name: z.string().min(1),
		baseUrl: z.string().url(),
		modelId: z.string().min(1),
		apiKeyEnv: z.string().min(1).optional(),
	}).strict(),
	model: modelSettingsSchema,
	requests: z.object({
		timeoutMs: z.number().int().positive(),
		maxRetries: z.number().int().nonnegative(),
		maxConcurrent: z.literal(1),
	}).strict(),
	paths: z.object({
		dataset: z.string().min(1),
		outputRoot: z.string().min(1),
		v1DatabaseFileName: z.string().min(1),
		v2DatabaseFileName: z.string().min(1),
	}).strict(),
	ids: z.object({
		v1Neuron: z.string().min(1),
		v2Memory: z.string().min(1),
		v2Recipe: z.string().min(1),
		v2RecipeVersion: z.string().min(1),
		v2RegistryRevision: z.string().min(1),
	}).strict(),
	bounds: z.object({
		maxObservations: z.number().int().positive(),
		maxObservationCharacters: z.number().int().positive(),
		maxObservationTokens: z.number().int().positive(),
		maxMemoryCharacters: z.number().int().positive(),
		maxMemoryTokens: z.number().int().positive(),
		maxContextCharacters: z.number().int().positive(),
		maxNodes: z.number().int().positive(),
		maxCollectionItems: z.number().int().positive(),
		maxOperations: z.number().int().positive(),
		maxClaims: z.number().int().positive(),
		minImportance: z.number().min(0).max(1),
	}).strict(),
}).strict()

const jsonStringSchema = z.object({ type: z.literal('string') }).strict()
const datasetSchema = z.object({
	schemaVersion: z.literal(1),
	label: z.literal('UNJUDGED'),
	provenance: z.string().min(1),
	scenario: z.object({
		id: z.string().min(1),
		purpose: z.string().min(1),
		developerInstructions: z.string().min(1),
		memoryType: z.literal('text'),
		observationSchema: jsonStringSchema,
		understandingSchema: jsonStringSchema,
		deliveries: z.array(
			z.object({ id: z.string().min(1), observedAt: z.string().datetime(), text: z.string().min(1) }).strict(),
		).min(1),
		metadata: z.object({ expectedLearningNote: z.string().min(1) }).strict(),
	}).strict(),
}).strict()

export type ComparisonConfig = z.infer<typeof configSchema>
export type ComparisonDataset = z.infer<typeof datasetSchema>
type ComparisonArm = 'v1' | 'v2'

interface ModelTurnSettings {
	readonly temperature?: number
	readonly seed?: number
	readonly maxOutputTokens?: number
	readonly maxRetries?: number
	readonly timeout?: number
	readonly [key: string]: unknown
}

interface ModelTurnRequest {
	readonly settings?: Readonly<ModelTurnSettings>
	readonly [key: string]: unknown
}

export interface ModelTurnPlugin {
	readonly id: string
	readonly model: unknown
	call(request: ModelTurnRequest): Promise<unknown>
	resolveModel?(config: Readonly<Record<string, unknown>>): unknown
	readonly [key: string]: unknown
}

export interface LegacyStore {
	readonly observations: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly understanding: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly evolution: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly state: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	dispose(): Promise<void>
}

export interface LegacyNeuron {
	learn(batch: unknown[], options: { forceSynthesize: boolean }): Promise<unknown>
	getUnderstanding(): Promise<string>
	getObserveSystemPrompt(): string | null
	getUnderstandSystemPrompt(): string | null
	getUnderstandIdentity(): unknown
	dispose(): Promise<void>
}

interface LegacyModule {
	TextNeuron: {
		create(config: Readonly<Record<string, unknown>>): Promise<LegacyNeuron>
		restore(store: LegacyStore, runtime: Readonly<Record<string, unknown>>): Promise<LegacyNeuron>
	}
	createAiSdkLLM(options?: Readonly<Record<string, unknown>>): ModelTurnPlugin
}

interface LegacySqliteModule {
	SQLiteNeuronStore: new (path: string) => LegacyStore
}

export interface LegacyRuntime extends LegacyModule, LegacySqliteModule {}

interface V2Store {
	readonly observations: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly understanding: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly evolution: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly state: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly learningHistory: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly memoryChanges: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly pendingWork: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly pendingInputs: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly processedInputs: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly outbox: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly learningAttempts: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	readonly learningRevisions: { list(filter?: Record<string, unknown>): Promise<unknown[]> }
	dispose(): Promise<void>
}

interface CapturedModelCall {
	readonly index: number
	readonly arm: string
	readonly phase: string
	readonly startedAt: string
	readonly durationMs?: number
	readonly request: unknown
	readonly result?: unknown
	readonly error?: unknown
}

export interface RuntimeContext {
	readonly config: ComparisonConfig
	readonly dataset: ComparisonDataset
	readonly runDirectory: string
	readonly armDirectory: string
	readonly transportDirectory: string
	readonly modelCalls: CapturedModelCall[]
	readonly arm?: string
	phase: string
}

function exactInspect(value: unknown): string {
	return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, getters: true })
}

function errorAwareReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return {
			...value,
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: value.cause,
		}
	}
	if (typeof value === 'bigint') return value.toString()
	return value
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, errorAwareReplacer, 2)}\n`)
}

function writeEvidencePair(directory: string, stem: string, value: unknown): void {
	writeJson(resolve(directory, `${stem}.json`), value)
	writeFileSync(resolve(directory, `${stem}.inspect.txt`), `${exactInspect(value)}\n`)
}

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

function gitValue(root: string, args: string[]): string {
	return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function timestampId(): string {
	return new Date().toISOString().split(':').join('-')
}

function duration(started: number): number {
	return Number((performance.now() - started).toFixed(3))
}

function mergeRequestSettings(
	settings: Readonly<ModelTurnSettings> | undefined,
	config: Pick<ComparisonConfig, 'model' | 'requests'>,
): ModelTurnSettings {
	return {
		...(settings ?? {}),
		...(config.model.temperature === undefined ? {} : { temperature: config.model.temperature }),
		...(config.model.seed === undefined ? {} : { seed: config.model.seed }),
		...(config.model.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.model.maxOutputTokens }),
		maxRetries: config.requests.maxRetries,
		timeout: config.requests.timeoutMs,
	}
}

function parseArguments(): { configPath: string; arm: ComparisonArm; runDirectory?: string } {
	const configValue = process.argv[2]
	if (configValue === undefined) throw new Error('provide the comparison config path')
	let arm: ComparisonArm | undefined
	let runDirectory: string | undefined
	for (let index = 3; index < process.argv.length; index += 1) {
		const argument = process.argv[index]
		if (argument === '--arm') {
			const value = process.argv[index + 1]
			if (value !== 'v1' && value !== 'v2') throw new Error('--arm must be v1 or v2')
			arm = value
			index += 1
			continue
		}
		if (argument === '--run-directory') {
			const value = process.argv[index + 1]
			if (value === undefined) throw new Error('--run-directory requires a path')
			runDirectory = resolve(value)
			index += 1
			continue
		}
		throw new Error(`unknown argument ${argument}`)
	}
	if (arm === undefined) throw new Error('--arm v1 or --arm v2 is required')
	return { configPath: resolve(configValue), arm, ...(runDirectory === undefined ? {} : { runDirectory }) }
}

function listFiles(root: string, directory: string = root): string[] {
	const values: string[] = []
	for (const name of readdirSync(directory).sort()) {
		const path = resolve(directory, name)
		if (statSync(path).isDirectory()) values.push(...listFiles(root, path))
		else values.push(relative(root, path))
	}
	return values
}

function writeRunDocuments(context: RuntimeContext): void {
	const deliveryCount = context.dataset.scenario.deliveries.length
	const limitations = [
		`One synthetic scenario with ${deliveryCount} sequential deliveries is recorded for one run per arm.`,
		'The v1 and v2 learning implementations differ: v1 uses its existing batch synthesis path; v2 uses observer output followed by current narrative actions.',
		'The v2 execution graph is fixed and hand-written, not model-generated.',
		'Semantic quality is UNJUDGED. No output is accepted, rejected, scored, or compared by this harness.',
	]
	writeFileSync(resolve(context.runDirectory, 'README.md'), [
		'# Text DAG comparison evidence',
		'',
		'Label: **UNJUDGED**',
		'',
		`This directory contains raw evidence from the standalone v1 TextNeuron and/or standalone v2 fixed-DAG text learner. Each arm begins with empty SQLite state, processes the same ${deliveryCount} deliveries sequentially, and closes, reopens, and reads its store after every delivery.`,
		'',
		'## Limitations',
		'',
		...limitations.map((value) => `- ${value}`),
		'',
	].join('\n'))
	const files = listFiles(context.runDirectory).filter((path) => path !== 'manifest.json')
	writeJson(resolve(context.runDirectory, 'manifest.json'), {
		label: 'UNJUDGED',
		generatedAt: new Date().toISOString(),
		scenarioId: context.dataset.scenario.id,
		completedArmDirectories: ['v1', 'v2'].filter((arm) => existsSync(resolve(context.runDirectory, arm))),
		limitations,
		files,
	})
}

function prepareRun(
	configPath: string,
	arm: ComparisonArm,
	suppliedRunDirectory?: string,
): RuntimeContext {
	const configRaw = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configRaw) as unknown)
	const datasetPath = resolve(config.paths.dataset)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = datasetSchema.parse(JSON.parse(datasetRaw) as unknown)
	const runDirectory = suppliedRunDirectory ?? resolve(config.paths.outputRoot, timestampId())
	const armDirectory = resolve(runDirectory, arm)
	if (existsSync(armDirectory)) throw new Error(`arm artifact directory already exists: ${armDirectory}`)
	mkdirSync(resolve(armDirectory, 'transport'), { recursive: true })
	const configSnapshot = resolve(runDirectory, 'supplied-config.raw.json')
	const datasetSnapshot = resolve(runDirectory, 'supplied-dataset.raw.json')
	if (existsSync(configSnapshot)) {
		if (readFileSync(configSnapshot, 'utf8') !== configRaw) throw new Error('run directory config snapshot differs from supplied config bytes')
		if (readFileSync(datasetSnapshot, 'utf8') !== datasetRaw) throw new Error('run directory dataset snapshot differs from supplied dataset bytes')
	} else {
		writeFileSync(configSnapshot, configRaw)
		writeFileSync(datasetSnapshot, datasetRaw)
		writeJson(resolve(runDirectory, 'snapshot-digests.json'), {
			configSha256: sha256(configRaw),
			datasetSha256: sha256(datasetRaw),
		})
	}
	const context: RuntimeContext = {
		config,
		dataset,
		runDirectory,
		armDirectory,
		transportDirectory: resolve(armDirectory, 'transport'),
		modelCalls: [],
		phase: `${arm}-setup`,
	}
	writeJson(resolve(armDirectory, 'runtime-input.json'), {
		label: 'UNJUDGED',
		arm,
		config,
		dataset,
	})
	return context
}

async function createObservedRuntime(
	context: RuntimeContext,
	legacy: LegacyRuntime,
): Promise<{ model: unknown; llm: ModelTurnPlugin }> {
	const apiKeyEnv = context.config.provider.apiKeyEnv
	const apiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv]
	if (apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
		throw new Error(`configured provider credential environment variable ${apiKeyEnv} is absent`)
	}
	let exchangeIndex = 0
	const observedFetch: typeof fetch = async (input, init) => {
		exchangeIndex += 1
		const prefix = `${String(exchangeIndex).padStart(3, '0')}-${context.phase}`
		const request = new Request(input, init)
		writeFileSync(resolve(context.transportDirectory, `${prefix}-request-body.raw.txt`), await request.clone().text())
		writeJson(resolve(context.transportDirectory, `${prefix}-request-metadata.json`), {
			phase: context.phase,
			url: request.url,
			method: request.method,
			headers: request.headers.has('content-type')
				? { 'content-type': request.headers.get('content-type') }
				: {},
		})
		try {
			const response = await fetch(request)
			writeFileSync(resolve(context.transportDirectory, `${prefix}-response-body.raw.txt`), await response.clone().text())
			writeJson(resolve(context.transportDirectory, `${prefix}-response-metadata.json`), {
				phase: context.phase,
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			})
			return response
		} catch (error) {
			writeEvidencePair(context.transportDirectory, `${prefix}-failure`, error)
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: context.config.provider.name,
		baseURL: context.config.provider.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }),
		fetch: observedFetch,
		supportsStructuredOutputs: true,
	})
	const model = provider(context.config.provider.modelId)
	const persistedProvider = (model as { provider?: unknown }).provider
	if (typeof persistedProvider !== 'string' || persistedProvider.length === 0) {
		throw new Error('configured compatible provider model has no persisted provider identifier')
	}
	const baseLlm = legacy.createAiSdkLLM({
		providers: { [persistedProvider]: (modelId: string) => provider(modelId) },
	})
	if (baseLlm.resolveModel === undefined) {
		throw new Error('legacy AI SDK plugin does not expose provider resolution verification')
	}
	const resolvedModel = baseLlm.resolveModel({
		plugin: baseLlm.id,
		provider: persistedProvider,
		id: context.config.provider.modelId,
		options: {},
	}) as { provider?: unknown; modelId?: unknown }
	writeJson(resolve(context.armDirectory, 'provider-resolution.json'), {
		persisted: { plugin: baseLlm.id, provider: persistedProvider, id: context.config.provider.modelId },
		resolved: { provider: resolvedModel.provider, modelId: resolvedModel.modelId },
	})
	const llm: ModelTurnPlugin = {
		...baseLlm,
		async call(request) {
			const index = context.modelCalls.length + 1
			const startedAt = new Date().toISOString()
			const started = performance.now()
				const suppliedRequest = {
					...request,
					settings: mergeRequestSettings(request.settings, context.config),
				}
			try {
				const result = await baseLlm.call(suppliedRequest)
				context.modelCalls.push({
					index,
					arm: context.arm ?? basename(context.armDirectory),
					phase: context.phase,
					startedAt,
					durationMs: duration(started),
					request: suppliedRequest,
					result,
				})
				writeEvidencePair(context.armDirectory, 'model-calls.partial', context.modelCalls)
				return result
			} catch (error) {
				context.modelCalls.push({
					index,
					arm: context.arm ?? basename(context.armDirectory),
					phase: context.phase,
					startedAt,
					durationMs: duration(started),
					request: suppliedRequest,
					error,
				})
				writeEvidencePair(context.armDirectory, 'model-calls.partial', context.modelCalls)
				throw error
			}
		},
	}
	return { model, llm }
}

async function snapshotLegacyStore(store: LegacyStore): Promise<Record<string, unknown>> {
	return {
		observations: await store.observations.list(),
		understanding: await store.understanding.list(),
		evolution: await store.evolution.list(),
		state: await store.state.list(),
	}
}

async function snapshotV2Store(store: V2Store): Promise<Record<string, unknown>> {
	return {
		observations: await store.observations.list(),
		understanding: await store.understanding.list(),
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
	}
}

function combinedInstructions(dataset: ComparisonDataset): string {
	return `${dataset.scenario.purpose}\n\nDeveloper instructions:\n${dataset.scenario.developerInstructions}`
}

async function loadLegacy(config: ComparisonConfig): Promise<LegacyRuntime> {
	const baselineRoot = resolve(config.baseline.root)
	const revision = gitValue(baselineRoot, ['rev-parse', 'HEAD'])
	if (revision !== config.baseline.revision) throw new Error('v1 baseline revision does not match configured revision')
	const [core, sqlite] = await Promise.all([
		import(pathToFileURL(resolve(baselineRoot, 'src/index.ts')).href) as Promise<LegacyModule>,
		import(pathToFileURL(resolve(baselineRoot, 'src/sqlite.ts')).href) as Promise<LegacySqliteModule>,
	])
	return { ...core, ...sqlite }
}

async function runV1(context: RuntimeContext): Promise<void> {
	const legacy = await loadLegacy(context.config)
	const { model, llm } = await createObservedRuntime(context, legacy)
	const databasePath = resolve(context.armDirectory, context.config.paths.v1DatabaseFileName)
	const events: unknown[] = []
	let store = new legacy.SQLiteNeuronStore(databasePath)
	context.phase = 'v1-initialization'
	const started = performance.now()
	let neuron = await legacy.TextNeuron.create({
		id: context.config.ids.v1Neuron,
		name: context.dataset.scenario.id,
		instructions: combinedInstructions(context.dataset),
		model,
		llm,
		store,
		observationSchema: context.dataset.scenario.observationSchema,
		understandingSchema: context.dataset.scenario.understandingSchema,
		governance: { strategy: 'continuous', maxTokens: context.config.bounds.maxMemoryTokens },
		understand: { thresholds: {
			maxObservations: context.config.bounds.maxObservations,
			maxTokens: context.config.bounds.maxObservationTokens,
			minImportance: context.config.bounds.minImportance,
		} },
		onEvent: (event: unknown) => events.push(event),
	})
	const initialization = {
		durationMs: duration(started),
		observeSystemPrompt: neuron.getObserveSystemPrompt(),
		understandSystemPrompt: neuron.getUnderstandSystemPrompt(),
		understandIdentity: neuron.getUnderstandIdentity(),
		understandingRead: await neuron.getUnderstanding(),
		storeRead: await snapshotLegacyStore(store),
		events: [...events],
	}
	writeEvidencePair(context.armDirectory, 'initialization', initialization)

	const executions: unknown[] = []
	for (let index = 0; index < context.dataset.scenario.deliveries.length; index += 1) {
		const delivery = context.dataset.scenario.deliveries[index]
		if (delivery === undefined) continue
		context.phase = `v1-delivery-${index + 1}`
		const callStart = context.modelCalls.length
		const eventStart = events.length
		const deliveryStarted = performance.now()
		let result: unknown
		let failure: unknown
		try {
			result = await neuron.learn([delivery.text], { forceSynthesize: true })
		} catch (error) {
			failure = error
		}
		const understandingReadBeforeClose = await neuron.getUnderstanding()
		const storeReadBeforeClose = await snapshotLegacyStore(store)
		await neuron.dispose()
		store = new legacy.SQLiteNeuronStore(databasePath)
		const storeReadAfterReopen = await snapshotLegacyStore(store)
		const understandingRecordAfterReopen = await store.understanding.list()
		const execution = {
			delivery,
			durationMs: duration(deliveryStarted),
			result,
			failure,
			understandingReadBeforeClose,
			storeReadBeforeClose,
			storeReadAfterReopen,
			understandingRecordAfterReopen,
			modelCalls: context.modelCalls.slice(callStart),
			events: events.slice(eventStart),
		}
		executions.push(execution)
		writeEvidencePair(context.armDirectory, 'deliveries.partial', executions)
		if (failure !== undefined) {
			await store.dispose()
			throw failure
		}
		neuron = await legacy.TextNeuron.restore(store, {
			id: context.config.ids.v1Neuron,
			model,
			llm,
			onEvent: (event: unknown) => events.push(event),
		})
	}
	writeEvidencePair(context.armDirectory, 'deliveries', executions)
	writeEvidencePair(context.armDirectory, 'model-calls', context.modelCalls)
	await neuron.dispose()
	writeJson(resolve(context.armDirectory, 'metadata.json'), {
		label: 'UNJUDGED',
		arm: 'v1',
		databasePath,
		initializationModelCallCount: context.modelCalls.filter((call) => call.phase === 'v1-initialization').length,
		deliveryModelCallCount: context.modelCalls.filter((call) => call.phase !== 'v1-initialization').length,
		grading: null,
	})
}

async function runV2(context: RuntimeContext): Promise<void> {
	const legacy = await loadLegacy(context.config)
	const { model, llm } = await createObservedRuntime(context, legacy)
	const dagModulePath = '../../src/neurons/text/dag.ts'
	const storesModulePath = '../../src/sqlite.ts'
	const llmModulePath = '../../src/llm/index.ts'
	const dag = await import(dagModulePath) as typeof import('../../src/neurons/text/dag')
	const stores = await import(storesModulePath) as typeof import('../../src/sqlite')
	const llmModule = await import(llmModulePath) as {
		generate: (options: Record<string, unknown>) => Promise<{ output: unknown; raw: unknown; usage?: AdaptUsage }>
		Output: { object(input: { schema: unknown }): unknown }
	}
	const databasePath = resolve(context.armDirectory, context.config.paths.v2DatabaseFileName)
	let store: NeuronStore = new stores.SQLiteNeuronStore(databasePath)
	const modelCapability: LearningModelCapability = {
		async generate<T>(request: LearningGenerationRequest<T>) {
			const result = await llmModule.generate({
				llm,
				model,
				system: request.system,
				prompt: request.prompt,
				output: llmModule.Output.object({ schema: request.schema }),
				repairSchema: request.schema,
				abortSignal: request.signal,
			})
			return { value: result.output as T, raw: result.raw, usage: result.usage }
		},
		async decide(): Promise<never> {
			throw new Error('the fixed text DAG does not configure a decision-model operation')
		},
	}
	const observer = dag.createAdaptTextDagObserver({
		llm: llm as unknown as AdaptLLMPlugin,
		model: model as LanguageModel,
	})
	let idSequence = 0
	let clockMilliseconds = Date.parse(context.dataset.scenario.deliveries[0].observedAt)
	const learnerConfig = (): TextDagDependencies => ({
		store,
		model: modelCapability,
		observer,
		clock: {
			now: () => {
				clockMilliseconds += 1
				return new Date(clockMilliseconds).toISOString()
			},
		},
		ids: {
			next: (kind: string) => {
				idSequence += 1
				return `${context.dataset.scenario.id}-${kind}-${idSequence}`
			},
		},
		config: {
			neuronId: context.config.ids.v1Neuron,
			memoryId: context.config.ids.v2Memory,
			registryRevision: context.config.ids.v2RegistryRevision,
			instructions: combinedInstructions(context.dataset),
			purpose: context.dataset.scenario.purpose,
			developerConstraints: context.dataset.scenario.developerInstructions,
			observationSchema: context.dataset.scenario.observationSchema,
			understandingSchema: context.dataset.scenario.understandingSchema,
			observe: {
				recipeId: `${context.config.ids.v2Recipe}.observe`,
				operationId: `${context.config.ids.v2Recipe}.observe-delivery`,
				version: context.config.ids.v2RecipeVersion,
			},
			narrative: {
				recipeId: context.config.ids.v2Recipe,
				version: context.config.ids.v2RecipeVersion,
				maxObservations: context.config.bounds.maxObservations,
				maxObservationCharacters: context.config.bounds.maxObservationCharacters,
				maxMemoryCharacters: context.config.bounds.maxMemoryCharacters,
				maxContextCharacters: context.config.bounds.maxContextCharacters,
			},
			planningLimits: {
				maxNodes: context.config.bounds.maxNodes,
				maxCollectionItems: context.config.bounds.maxCollectionItems,
				maxOperations: context.config.bounds.maxOperations,
			},
			maxProviderCalls: context.config.bounds.maxClaims,
		},
	})
	let learner: TextDagLearner = dag.createTextDagLearner(learnerConfig())
	const initialization = {
		understandingRead: await learner.getUnderstanding(),
		storeRead: await snapshotV2Store(store),
	}
	writeEvidencePair(context.armDirectory, 'initialization', initialization)
	const executions: unknown[] = []
	for (let index = 0; index < context.dataset.scenario.deliveries.length; index += 1) {
		const delivery = context.dataset.scenario.deliveries[index]
		if (delivery === undefined) continue
		context.phase = `v2-delivery-${index + 1}`
		const callStart = context.modelCalls.length
		const deliveryStarted = performance.now()
		let result: unknown
		let failure: unknown
		try {
			result = await learner.learn({
				id: delivery.id,
				text: delivery.text,
				eventAt: delivery.observedAt,
				signal: new AbortController().signal,
			})
		} catch (error) {
			failure = error
		}
		const understandingReadBeforeClose = await learner.getUnderstanding()
		const storeReadBeforeClose = await snapshotV2Store(store)
		await store.dispose()
		store = new stores.SQLiteNeuronStore(databasePath)
		const storeReadAfterReopen = await snapshotV2Store(store)
		const understandingRecordAfterReopen = await store.understanding.list()
		learner = dag.createTextDagLearner(learnerConfig())
		const learnerUnderstandingAfterReopen = await learner.getUnderstanding()
		const execution = {
			delivery,
			durationMs: duration(deliveryStarted),
			result,
			failure,
			understandingReadBeforeClose,
			storeReadBeforeClose,
			storeReadAfterReopen,
			understandingRecordAfterReopen,
			learnerUnderstandingAfterReopen,
			modelCalls: context.modelCalls.slice(callStart),
		}
		executions.push(execution)
		writeEvidencePair(context.armDirectory, 'deliveries.partial', executions)
		if (failure !== undefined) {
			await store.dispose()
			throw failure
		}
	}
	writeEvidencePair(context.armDirectory, 'deliveries', executions)
	writeEvidencePair(context.armDirectory, 'model-calls', context.modelCalls)
	await store.dispose()
	writeJson(resolve(context.armDirectory, 'metadata.json'), {
		label: 'UNJUDGED',
		arm: 'v2',
		databasePath,
		graph: 'fixed hand-written DAG',
		modelCallCount: context.modelCalls.length,
		grading: null,
	})
}

async function main(): Promise<void> {
	const args = parseArguments()
	const context = prepareRun(args.configPath, args.arm, args.runDirectory)
	try {
		const repositoryRoot = resolve(import.meta.dirname, '../..')
		writeJson(resolve(context.armDirectory, 'source-identifiers.json'), {
			runtime: { node: process.version, platform: process.platform, architecture: process.arch },
			repository: {
				root: repositoryRoot,
				revision: gitValue(repositoryRoot, ['rev-parse', 'HEAD']),
				status: gitValue(repositoryRoot, ['status', '--short']),
			},
			baseline: {
				root: context.config.baseline.root,
				revision: gitValue(context.config.baseline.root, ['rev-parse', 'HEAD']),
			},
			model: { provider: context.config.provider, settings: context.config.model },
			script: import.meta.url,
			inputs: {
				config: { path: args.configPath, sha256: sha256(readFileSync(args.configPath)) },
				dataset: {
					path: resolve(context.config.paths.dataset),
					sha256: sha256(readFileSync(resolve(context.config.paths.dataset))),
				},
			},
			sourceFiles: [
				'evals/scripts/text-dag-comparison-eval.ts',
				'src/neurons/text/dag.ts',
				'src/learning/recipes/narrative.ts',
			].map((path) => {
				const absolutePath = resolve(repositoryRoot, path)
				return { path, sha256: sha256(readFileSync(absolutePath)) }
			}),
		})
		if (args.arm === 'v1') await runV1(context)
		else await runV2(context)
		writeRunDocuments(context)
		console.log(context.runDirectory)
	} catch (error) {
		writeEvidencePair(context.armDirectory, 'failure', error)
		writeEvidencePair(context.armDirectory, 'model-calls', context.modelCalls)
		writeRunDocuments(context)
		throw error
	}
}

export const textComparisonSupport = {
	configSchema,
	datasetSchema,
	writeJson,
	writeEvidencePair,
	sha256,
	gitValue,
	duration,
	mergeRequestSettings,
	createObservedRuntime,
	snapshotLegacyStore,
	combinedInstructions,
	loadLegacy,
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
	await main()
}
