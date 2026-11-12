/**
 * Runs the unjudged public-TextNeuron longitudinal comparison one isolated job
 * at a time. Raw model, transport, public API, and reopened-store evidence is
 * written immediately. This harness performs no semantic grading.
 *
 * Run:
 *   npx tsx evals/scripts/adaptive-text-longitudinal-eval.ts <config-path>
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { z } from 'zod'

import {
	createAiSdkLLM,
	TextNeuron,
	type AdaptLLMPlugin,
	type AdaptModelConfig,
	type AiSdkProviderFactory,
} from '../../src'
import {
	createAdaptTextProcedureProvider,
	createConservativeByteTokenCounter,
	type TextLearningConfig,
} from '../../src/learning/text-procedures'
import type {
	TextProfileSnapshot,
	TextStateClock,
	TextStateIds,
	TextStateScheduler,
} from '../../src/learning/text-state'
import { createBoundedDeviceScheduler } from '../../src/llm/local/scheduler'
import type {
	AdaptiveTextLearningRuntime,
	AdaptiveTextSelectionCatalogueEntry,
} from '../../src/neurons/text'
import { SQLiteNeuronStore } from '../../src/stores/sqlite/node/neuron'
import type { NeuronStore } from '../../src/stores'

const positiveInteger = z.number().int().positive()
const nonnegativeInteger = z.number().int().nonnegative()
const versionRefSchema = z.object({ id: z.string().min(1), version: z.string().min(1) }).strict()
const armIdSchema = z.enum(['A-v1', 'B-fixed-direct', 'B-line-revision', 'C-adaptive', 'D-fixed-rich'])

const textInputSchema = z.object({
	deliveryId: z.string().min(1),
	eventId: z.string().min(1).optional(),
	text: z.string(),
	observedAt: z.string().datetime(),
	urgency: z.enum(['normal', 'urgent']).optional(),
}).strict()

const lensSchema = z.object({
	purpose: z.string().min(1),
	developerInstructions: z.array(z.string().min(1)).min(1),
	instructionPrecedence: z.array(z.string().min(1)).min(1),
	incomingTextRole: z.literal('data-only'),
}).strict()

const streamSchema = z.object({
	schemaVersion: z.literal(1),
	synthetic: z.literal(true),
	visibility: z.enum(['development', 'sealed-heldout']),
	id: z.string().min(1),
	title: z.string().min(1),
	lens: lensSchema,
	checkpoints: z.array(positiveInteger).length(6),
	inputs: z.array(textInputSchema).length(180),
}).strict()

const manifestFileSchema = z.object({
	path: z.string().min(1),
	role: z.enum(['input-stream', 'reviewer-key', 'module-inputs']),
	visibility: z.enum(['development', 'sealed-heldout']),
	inputCount: positiveInteger.optional(),
	caseCount: positiveInteger.optional(),
	sha256: z.string().length(64),
}).strict()

const fixtureManifestSchema = z.object({
	schemaVersion: z.literal(1),
	synthetic: z.literal(true),
	authoringSource: z.object({ path: z.string().min(1), sha256: z.string().length(64) }).strict(),
	files: z.array(manifestFileSchema).min(1),
	notes: z.array(z.string()),
}).strict()

const currentConfigurationSchema = z.object({
	model: versionRefSchema,
	activeProcedure: versionRefSchema,
	allowedProcedures: z.array(versionRefSchema).min(1),
	selection: z.object({
		mode: z.enum(['fixed', 'periodic']),
		selector: versionRefSchema,
		minCommittedRuns: nonnegativeInteger,
		minElapsedMs: nonnegativeInteger,
		maxCatalogueEntries: positiveInteger,
		autoActivatePreEvaluated: z.boolean(),
	}).strict(),
	batching: z.object({
		maxItems: positiveInteger,
		maxInputCharacters: positiveInteger,
		maxInputTokens: positiveInteger,
		maxDelayMs: nonnegativeInteger,
		acceptCallerUrgency: z.boolean(),
	}).strict(),
	input: z.object({ maxItemCharacters: positiveInteger, maxRoutingSpanCharacters: positiveInteger }).strict(),
	memory: z.object({
		maxCharacters: positiveInteger,
		maxNarrativeTokens: positiveInteger,
		splitPressureCharacters: positiveInteger,
		allowExplicitClear: z.boolean(),
		standaloneCapacity: z.enum(['compact', 'reject']),
		compactionProcedure: versionRefSchema.optional(),
	}).strict(),
	generation: z.object({
		loadedContextTokens: positiveInteger,
		reservedOutputTokens: positiveInteger,
		maxNoteCharacters: positiveInteger,
		maxProviderCalls: positiveInteger,
		maxTokenClaims: positiveInteger,
		maxBudgetClaims: positiveInteger,
	}).strict(),
	planning: z.object({
		maxNodes: positiveInteger,
		maxCollectionItems: positiveInteger,
		maxOperations: positiveInteger,
	}).strict(),
	retries: z.object({
		maxLogicalAttempts: nonnegativeInteger,
		initialDelayMs: nonnegativeInteger,
		maxDelayMs: nonnegativeInteger,
		terminalAfterMs: nonnegativeInteger,
	}).strict(),
	history: z.object({ maxEntries: positiveInteger, maxCharacters: positiveInteger }).strict(),
	idempotence: z.object({ processedIdHorizonMs: nonnegativeInteger, maxProcessedIds: positiveInteger }).strict(),
	lineRevision: z.object({
		maxRelatedLines: positiveInteger,
		minRelatedScore: z.number().positive(),
		maxLineCharacters: positiveInteger,
		compactAtCharacters: positiveInteger,
		compactTargetRatio: z.number().gt(0).lt(1),
		minCompactionWords: positiveInteger,
		minClusterScore: z.number().positive(),
		minClusterLines: positiveInteger,
		maxClusterLines: positiveInteger,
		maxCompactionsPerRun: nonnegativeInteger,
		maxChangeSummaryCharacters: positiveInteger,
		strategy: z.enum(['continuous', 'cumulative', 'decay']).optional(),
		screenControlText: z.boolean().optional(),
	}).strict().optional(),
	fieldRevision: z.object({
		schema: z.record(z.string(), z.unknown()),
		ordinalFields: z.array(z.string()),
		maxOrdinalStep: positiveInteger,
		maxListItems: positiveInteger,
		maxChangeSummaryCharacters: positiveInteger,
		screenControlText: z.boolean().optional(),
		levelDescriptions: z.record(z.string(), z.record(z.string(), z.string())).optional(),
		indicators: z.record(z.string(), z.record(z.string(), z.string())).optional(),
		confirmations: positiveInteger,
	}).strict().optional(),
}).strict()

const profileTemplateSchema = z.object({
	refId: z.string().min(1),
	refVersion: z.string().min(1),
	revision: nonnegativeInteger,
	configuration: currentConfigurationSchema.omit({ activeProcedure: true }),
	createdAt: z.string().datetime(),
	bindings: z.object({
		incarnation: z.string().min(1),
		ownershipRevision: nonnegativeInteger,
		profileRevision: nonnegativeInteger,
		registryLineage: z.string().min(1),
		referencedDefinitionDigest: z.string().min(1),
		allowedCatalogueDigest: z.string().min(1),
	}).strict(),
}).strict()

const currentArmSchema = z.object({
	id: z.enum(['B-fixed-direct', 'B-line-revision', 'C-adaptive', 'D-fixed-rich']),
	kind: z.literal('current'),
	profile: profileTemplateSchema,
	procedure: z.object({
		default: versionRefSchema,
		byStream: z.array(z.object({ streamId: z.string().min(1), procedure: versionRefSchema }).strict()),
	}).strict(),
	catalogue: z.array(z.object({
		token: z.string().min(1),
		expectedEffect: z.string().min(1),
		procedure: versionRefSchema,
		profileRefId: z.string().min(1),
		profileRefVersion: z.string().min(1),
		profileRevision: nonnegativeInteger,
		evaluation: z.object({
			model: versionRefSchema,
			evidenceRefs: z.array(z.string().min(1)).min(1),
		}).strict(),
	}).strict()),
}).strict()

const v1ArmSchema = z.object({
	id: z.literal('A-v1'),
	kind: z.literal('v1'),
	understand: z.object({
		maxObservations: positiveInteger,
		maxTokens: positiveInteger,
		minImportance: z.number().min(0).max(1),
	}).strict(),
	governance: z.object({ strategy: z.enum(['continuous', 'cumulative', 'decay']), maxTokens: positiveInteger }).strict(),
}).strict()

const commandSchema = z.object({
	id: z.string().min(1),
	executable: z.string().min(1),
	arguments: z.array(z.string()),
}).strict()

const sourceSchema = z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()

const configSchema = z.object({
	schemaVersion: z.literal(1),
	label: z.literal('UNJUDGED'),
	baseline: z.object({ root: z.string().min(1), revision: z.string().length(40) }).strict(),
	provider: z.object({
		name: z.string().min(1), baseUrl: z.string().url(), modelId: z.string().min(1),
		apiKeyEnv: z.string().min(1).optional(), supportsStructuredOutputs: z.boolean(),
	}).strict(),
	settings: z.object({
		temperature: z.number(), maxOutputTokens: positiveInteger,
		maxRetries: nonnegativeInteger, timeoutMs: positiveInteger,
	}).strict(),
	fixtureManifest: z.object({ path: z.string().min(1), sha256: z.string().length(64) }).strict(),
	profileLineage: z.object({ path: z.string().min(1), sha256: z.string().length(64) }).strict().optional(),
	streams: z.array(z.object({
		id: z.string().min(1), path: z.string().min(1), sha256: z.string().length(64),
		reviewerKeyPath: z.string().min(1), reviewerKeySha256: z.string().length(64),
		visibility: z.enum(['development', 'sealed-heldout']),
	}).strict()).length(4),
	arms: z.array(z.discriminatedUnion('kind', [v1ArmSchema, currentArmSchema])).min(1),
	selection: z.object({
		streamIds: z.array(z.string().min(1)).min(1),
		armIds: z.array(armIdSchema).min(1),
		repetitions: z.array(positiveInteger).min(1),
	}).strict(),
	queries: z.array(z.string().min(1)).min(1),
	paths: z.object({ outputRoot: z.string().min(1), databaseFileName: z.string().min(1) }).strict(),
	ids: z.object({ neuronPrefix: z.string().min(1), runtimePrefix: z.string().min(1) }).strict(),
	adaptiveRuntime: z.object({
		tokenCounter: z.object({ requestTemplateOverheadTokens: nonnegativeInteger, textTemplateOverheadTokens: nonnegativeInteger }).strict(),
		deviceScheduler: z.object({ maxConcurrent: z.literal(1), maxQueued: nonnegativeInteger, priority: z.enum(['query', 'foreground', 'background']) }).strict(),
		statePolicy: z.object({
			maxRetainedProfiles: positiveInteger, maxFlushRuns: positiveInteger,
			headStateId: z.string().min(1), narrativeMemoryId: z.string().min(1),
			stateKind: z.string().min(1), selectionStateId: z.string().min(1),
		}).strict(),
		selectionLimits: z.object({
			maxContextCharacters: positiveInteger, maxLearnedChanges: positiveInteger,
			maxPendingInputs: positiveInteger, maxFeedbackEntries: positiveInteger,
		}).strict(),
	}).strict(),
	dueWakeup: z.object({ enabled: z.boolean(), afterInput: positiveInteger, waitMs: positiveInteger }).strict(),
	recovery: z.object({
		enabled: z.boolean(), streamId: z.string().min(1), armId: armIdSchema,
		repetition: positiveInteger, afterInput: positiveInteger,
	}).strict(),
	storeCollections: z.object({ v1: z.array(z.string().min(1)).min(1), current: z.array(z.string().min(1)).min(1) }).strict(),
	runtimeCommands: z.array(commandSchema),
	sourceFiles: z.array(sourceSchema).min(1),
}).strict()

export type LongitudinalConfig = z.infer<typeof configSchema>
export type LongitudinalStream = z.infer<typeof streamSchema>
export type LongitudinalArm = LongitudinalConfig['arms'][number]
export type LongitudinalArmId = z.infer<typeof armIdSchema>

export interface LongitudinalJob {
	readonly id: string
	readonly streamId: string
	readonly armId: LongitudinalArmId
	readonly repetition: number
}

interface JobProgress {
	readonly nextInputIndex: number
	readonly completedCheckpoints: readonly number[]
	readonly recoveryTriggered: boolean
}

interface LegacyStore {
	readonly [key: string]: unknown
	dispose(): Promise<void>
}

interface PublicNeuron {
	learn(batch: unknown[], options?: { forceSynthesize?: boolean }): Promise<unknown>
	getUnderstanding(): Promise<string>
	query(question: string): Promise<unknown>
	flush?(signal?: AbortSignal): Promise<unknown>
	resume?(signal?: AbortSignal): Promise<unknown>
	getLearningState?(): Promise<unknown>
	dispose(): Promise<void>
}

interface LegacyRuntime {
	TextNeuron: {
		create(config: Readonly<Record<string, unknown>>): Promise<PublicNeuron>
		restore(store: LegacyStore, runtime: Readonly<Record<string, unknown>>): Promise<PublicNeuron>
	}
	createAiSdkLLM(options?: Readonly<Record<string, unknown>>): AdaptLLMPlugin
	SQLiteNeuronStore: new (path: string) => LegacyStore
}

interface EvidenceRuntime {
	readonly model: LanguageModel
	readonly llm: AdaptLLMPlugin
	readonly provider: ReturnType<typeof createAdaptTextProcedureProvider>
	readonly tokenCounter: ReturnType<typeof createConservativeByteTokenCounter>
	readonly phase: { value: string }
}

type PluginFactory = (providers: Record<string, AiSdkProviderFactory>) => AdaptLLMPlugin

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

function timestampId(): string {
	return new Date().toISOString().split(':').join('-')
}

function errorReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
	}
	if (typeof value === 'bigint') return value.toString()
	return value
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, errorReplacer, 2)}\n`)
}

function writeEvidence(directory: string, stem: string, value: unknown): void {
	mkdirSync(directory, { recursive: true })
	writeJson(resolve(directory, `${stem}.raw.json`), value)
	writeFileSync(resolve(directory, `${stem}.raw.inspect.txt`), `${inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, getters: true })}\n`)
}

function writeProgress(path: string, value: JobProgress): void {
	const temporaryPath = `${path}.next`
	writeJson(temporaryPath, value)
	renameSync(temporaryPath, path)
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function unique<T>(values: readonly T[]): boolean {
	return new Set(values).size === values.length
}

function resolveConfigured(...paths: readonly string[]): string {
	return resolve(...paths)
}

export function readLongitudinalConfig(path: string): LongitudinalConfig {
	const config = configSchema.parse(readJson(resolveConfigured(path)))
	if (!unique(config.selection.streamIds) || !unique(config.selection.armIds) || !unique(config.selection.repetitions)) {
		throw new Error('selected streams, arms, and repetitions must each be unique')
	}
	if (!unique(config.streams.map(({ id }) => id)) || !unique(config.arms.map(({ id }) => id))) {
		throw new Error('configured stream and arm ids must be unique')
	}
	return config
}

export function expandExecutionPlan(config: LongitudinalConfig): readonly LongitudinalJob[] {
	const streams = new Set(config.streams.map(({ id }) => id))
	const arms = new Set(config.arms.map(({ id }) => id))
	for (const id of config.selection.streamIds) if (!streams.has(id)) throw new Error(`selected stream is not configured: ${id}`)
	for (const id of config.selection.armIds) if (!arms.has(id)) throw new Error(`selected arm is not configured: ${id}`)
	const jobs: LongitudinalJob[] = []
	for (const repetition of config.selection.repetitions) {
		for (const streamId of config.selection.streamIds) {
			for (const armId of config.selection.armIds) {
				jobs.push({ id: `rep-${String(repetition).padStart(2, '0')}--${streamId}--${armId}`, streamId, armId, repetition })
			}
		}
	}
	return jobs
}

export function readSelectedStream(config: LongitudinalConfig, streamId: string): { stream: LongitudinalStream; raw: Buffer } {
	const descriptor = config.streams.find((entry) => entry.id === streamId)
	if (descriptor === undefined) throw new Error(`stream is not configured: ${streamId}`)
	const path = resolveConfigured(descriptor.path)
	const raw = readFileSync(path)
	if (sha256(raw) !== descriptor.sha256) throw new Error(`stream digest differs from config: ${streamId}`)
	const stream = streamSchema.parse(JSON.parse(raw.toString('utf8')) as unknown)
	if (stream.id !== streamId || stream.visibility !== descriptor.visibility) throw new Error(`stream identity differs from config: ${streamId}`)
	return { stream, raw }
}

export function reserveRunDirectory(outputRoot: string, id: string = timestampId()): string {
	const root = resolveConfigured(outputRoot)
	mkdirSync(root, { recursive: true })
	const directory = resolve(root, id)
	mkdirSync(directory, { recursive: false })
	return directory
}

function selectedArm(config: LongitudinalConfig, id: LongitudinalArmId): LongitudinalArm {
	const arm = config.arms.find((entry) => entry.id === id)
	if (arm === undefined) throw new Error(`arm is not configured: ${id}`)
	return arm
}

function selectedStreamDescriptor(config: LongitudinalConfig, id: string): LongitudinalConfig['streams'][number] {
	const stream = config.streams.find((entry) => entry.id === id)
	if (stream === undefined) throw new Error(`stream is not configured: ${id}`)
	return stream
}

function gitValue(root: string, arguments_: readonly string[]): string {
	const result = spawnSync('git', ['-C', root, ...arguments_], { encoding: 'utf8' })
	if (result.status !== 0) throw new Error(`git command failed for ${root}: ${result.stderr}`)
	return result.stdout.trim()
}

function listFiles(root: string, directory: string = root): string[] {
	const files: string[] = []
	for (const name of readdirSync(directory).sort()) {
		const path = resolve(directory, name)
		if (statSync(path).isDirectory()) files.push(...listFiles(root, path))
		else files.push(relative(root, path))
	}
	return files
}

function nextEvidenceIndex(directory: string): number {
	if (!existsSync(directory)) return 1
	return readdirSync(directory).filter((name) => statSync(resolve(directory, name)).isDirectory()).length + 1
}

function safeTransportMetadata(headers: Headers): Record<string, string | null> {
	return {
		'content-type': headers.get('content-type'),
		'content-length': headers.get('content-length'),
	}
}

function requestSettings(config: LongitudinalConfig, supplied: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
	return {
		temperature: config.settings.temperature,
		maxOutputTokens: config.settings.maxOutputTokens,
		maxRetries: config.settings.maxRetries,
		timeout: config.settings.timeoutMs,
		...(supplied ?? {}),
	}
}

function observedLanguageModel(config: LongitudinalConfig, jobDirectory: string, phase: { value: string }): LanguageModel {
	const apiKey = config.provider.apiKeyEnv === undefined ? undefined : process.env[config.provider.apiKeyEnv]
	if (config.provider.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
		throw new Error(`configured provider credential is absent: ${config.provider.apiKeyEnv}`)
	}
	const wireDirectory = resolve(jobDirectory, 'wire')
	const sdkDirectory = resolve(jobDirectory, 'sdk')
	mkdirSync(wireDirectory, { recursive: true })
	mkdirSync(sdkDirectory, { recursive: true })
	let wireIndex = nextEvidenceIndex(wireDirectory)
	const observedFetch: typeof fetch = async (input, init) => {
		const directory = resolve(wireDirectory, String(wireIndex).padStart(6, '0'))
		wireIndex += 1
		mkdirSync(directory, { recursive: false })
		const request = new Request(input, init)
		writeFileSync(resolve(directory, 'request-body.raw.bin'), Buffer.from(await request.clone().arrayBuffer()))
		writeEvidence(directory, 'request-metadata', {
			phase: phase.value,
			url: request.url,
			method: request.method,
			headers: safeTransportMetadata(request.headers),
		})
		try {
			const response = await fetch(request)
			writeFileSync(resolve(directory, 'response-body.raw.bin'), Buffer.from(await response.clone().arrayBuffer()))
			writeEvidence(directory, 'response-metadata', {
				phase: phase.value,
				status: response.status,
				headers: safeTransportMetadata(response.headers),
			})
			return response
		} catch (error) {
			writeEvidence(directory, 'transport-error', error)
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: config.provider.name,
		baseURL: config.provider.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }),
		fetch: observedFetch,
		supportsStructuredOutputs: config.provider.supportsStructuredOutputs,
	})
	const model = provider(config.provider.modelId)
	let sdkIndex = nextEvidenceIndex(sdkDirectory)
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property !== 'doGenerate') return Reflect.get(target, property, receiver)
			return async (options: unknown) => {
				const directory = resolve(sdkDirectory, String(sdkIndex).padStart(6, '0'))
				sdkIndex += 1
				mkdirSync(directory, { recursive: false })
				writeEvidence(directory, 'input', { phase: phase.value, options })
				try {
					const result = await target.doGenerate(options as never)
					writeEvidence(directory, 'result', { phase: phase.value, result })
					return result
				} catch (error) {
					writeEvidence(directory, 'error', error)
					throw error
				}
			}
		},
	}) as LanguageModel
}

function observedPlugin(config: LongitudinalConfig, jobDirectory: string, base: AdaptLLMPlugin, phase: { value: string }): AdaptLLMPlugin {
	const callsDirectory = resolve(jobDirectory, 'model-calls')
	mkdirSync(callsDirectory, { recursive: true })
	let index = nextEvidenceIndex(callsDirectory)
	return {
		...base,
		async call(request: Parameters<AdaptLLMPlugin['call']>[0]) {
			const directory = resolve(callsDirectory, String(index).padStart(6, '0'))
			index += 1
			mkdirSync(directory, { recursive: false })
			const supplied = {
				...request,
				settings: requestSettings(config, request.settings as Readonly<Record<string, unknown>> | undefined),
			}
			const startedAt = new Date().toISOString()
			const started = performance.now()
			writeEvidence(directory, 'input', { phase: phase.value, startedAt, request: supplied })
			try {
				const result = await base.call(supplied)
				writeEvidence(directory, 'result', {
					completedAt: new Date().toISOString(),
					durationMs: Number((performance.now() - started).toFixed(3)),
					result,
				})
				return result
			} catch (error) {
				writeEvidence(directory, 'error', {
					completedAt: new Date().toISOString(),
					durationMs: Number((performance.now() - started).toFixed(3)),
					error,
				})
				throw error
			}
		},
	} as AdaptLLMPlugin
}

export function observedModelProviderFactory(
	expectedModelId: string,
	model: LanguageModel,
): { readonly providerName: string; readonly factory: AiSdkProviderFactory } {
	const identity = model as { readonly provider?: unknown; readonly modelId?: unknown }
	if (typeof identity.provider !== 'string' || identity.provider.length === 0) {
		throw new Error('observed AI SDK model has no provider identifier')
	}
	if (identity.modelId !== expectedModelId) {
		throw new Error(`observed AI SDK model id differs from config: ${String(identity.modelId)}`)
	}
	return {
		providerName: identity.provider,
		factory(modelId, persisted) {
			if (modelId !== expectedModelId || persisted.id !== expectedModelId || persisted.provider !== identity.provider) {
				throw new Error('persisted model identity differs from the observed local model')
			}
			return model
		},
	}
}

function createEvidenceRuntime(config: LongitudinalConfig, jobDirectory: string, pluginFactory: PluginFactory): EvidenceRuntime {
	const phase = { value: 'setup' }
	const model = observedLanguageModel(config, jobDirectory, phase)
	const resolution = observedModelProviderFactory(config.provider.modelId, model)
	const basePlugin = pluginFactory({ [resolution.providerName]: resolution.factory })
	const persistedModel: AdaptModelConfig<'ai-sdk'> = {
		plugin: 'ai-sdk', provider: resolution.providerName, id: config.provider.modelId, options: {},
	}
	const resolver = basePlugin as AdaptLLMPlugin & { resolveModel?: (value: AdaptModelConfig<'ai-sdk'>) => LanguageModel }
	if (resolver.resolveModel === undefined || resolver.resolveModel(persistedModel) !== model) {
		throw new Error('provider-backed Adapt AI SDK plugin did not resolve the observed model')
	}
	const resolutionDirectory = resolve(jobDirectory, 'provider-resolutions', String(nextEvidenceIndex(resolve(jobDirectory, 'provider-resolutions'))).padStart(6, '0'))
	mkdirSync(resolutionDirectory, { recursive: true })
	writeEvidence(resolutionDirectory, 'resolution', {
		persistedModel,
		resolved: { provider: resolution.providerName, modelId: config.provider.modelId },
		gateway: false,
	})
	const llm = observedPlugin(config, jobDirectory, basePlugin, phase)
	const scheduler = createBoundedDeviceScheduler({
		maxConcurrent: config.adaptiveRuntime.deviceScheduler.maxConcurrent,
		maxQueued: config.adaptiveRuntime.deviceScheduler.maxQueued,
	})
	const tokenCounter = createConservativeByteTokenCounter(config.adaptiveRuntime.tokenCounter)
	return {
		model,
		llm,
		provider: createAdaptTextProcedureProvider({
			llm,
			model,
			settings: {
				temperature: config.settings.temperature,
				maxOutputTokens: config.settings.maxOutputTokens,
				maxRetries: config.settings.maxRetries,
				timeout: config.settings.timeoutMs,
			},
			scheduler,
			priority: config.adaptiveRuntime.deviceScheduler.priority,
		}),
		tokenCounter,
		phase,
	}
}

class RuntimeIds implements TextStateIds {
	constructor(private readonly prefix: string) {}
	next(kind: Parameters<TextStateIds['next']>[0]): string {
		return `${this.prefix}-${kind}-${randomUUID()}`
	}
}

class InputIds {
	constructor(private readonly prefix: string) {}
	next(): string {
		return `${this.prefix}-input-${randomUUID()}`
	}
}

class WallClock implements TextStateClock {
	now(): string {
		return new Date().toISOString()
	}
}

class WallScheduler implements TextStateScheduler {
	schedule(dueAt: string, callback: () => void): unknown {
		const delay = Math.max(0, Date.parse(dueAt) - Date.now())
		const handle = setTimeout(callback, delay)
		handle.unref()
		return handle
	}
	cancel(handle: unknown): void {
		clearTimeout(handle as ReturnType<typeof setTimeout>)
	}
}

function assignedProcedure(arm: Extract<LongitudinalArm, { kind: 'current' }>, streamId: string): { id: string; version: string } {
	return arm.procedure.byStream.find((entry) => entry.streamId === streamId)?.procedure ?? arm.procedure.default
}

function jobNeuronId(config: LongitudinalConfig, job: LongitudinalJob): string {
	return `${config.ids.neuronPrefix}-${job.streamId}-${job.armId}-r${String(job.repetition)}`
}

function jobRuntimePrefix(config: LongitudinalConfig, job: LongitudinalJob): string {
	return `${config.ids.runtimePrefix}-${job.streamId}-${job.armId}-r${String(job.repetition)}`
}

function profileFor(
	config: LongitudinalConfig,
	arm: Extract<LongitudinalArm, { kind: 'current' }>,
	stream: LongitudinalStream,
	job: LongitudinalJob,
	procedure: { readonly id: string; readonly version: string },
	refId: string = arm.profile.refId,
	refVersion: string = arm.profile.refVersion,
	revision: number = arm.profile.revision,
): TextProfileSnapshot<TextLearningConfig> {
	const neuronId = jobNeuronId(config, job)
	const profileRef = { id: `${refId}-${stream.id}`, version: refVersion }
	const configuration: TextLearningConfig = {
		...arm.profile.configuration,
		lens: stream.lens,
		activeProcedure: procedure,
	}
	return {
		ref: profileRef,
		revision,
		configuration,
		bindings: {
			neuron: {
				id: neuronId,
				incarnation: arm.profile.bindings.incarnation,
				ownership_revision: arm.profile.bindings.ownershipRevision,
			},
			profile: profileRef,
			profile_revision: arm.profile.bindings.profileRevision,
			procedure,
			model: configuration.model,
			registry_lineage: arm.profile.bindings.registryLineage,
			referenced_definition_digest: arm.profile.bindings.referencedDefinitionDigest,
			allowed_catalogue_digest: arm.profile.bindings.allowedCatalogueDigest,
		},
		createdAt: arm.profile.createdAt,
	}
}

function adaptiveRuntime(
	config: LongitudinalConfig,
	arm: Extract<LongitudinalArm, { kind: 'current' }>,
	stream: LongitudinalStream,
	job: LongitudinalJob,
	evidence: EvidenceRuntime,
	jobDirectory: string,
): AdaptiveTextLearningRuntime {
	const prefix = jobRuntimePrefix(config, job)
	const runtimeErrors = resolve(jobDirectory, 'adaptive-runtime-errors.raw.jsonl')
	const catalogue: AdaptiveTextSelectionCatalogueEntry[] = arm.catalogue.map((entry) => {
		const profile = profileFor(config, arm, stream, job, entry.procedure, entry.profileRefId, entry.profileRefVersion, entry.profileRevision)
		return {
			token: entry.token,
			expectedEffect: entry.expectedEffect,
			profile,
			evaluation: { ...entry.evaluation, profile: profile.ref },
		}
	})
	return {
		models: [{ ref: arm.profile.configuration.model, provider: evidence.provider, tokens: evidence.tokenCounter }],
		stateIds: new RuntimeIds(prefix),
		inputIds: new InputIds(prefix),
		clock: new WallClock(),
		scheduler: new WallScheduler(),
		policy: config.adaptiveRuntime.statePolicy,
		countInputTokens: (inputs) => inputs.reduce((total, input) => total + evidence.tokenCounter.countText(input.text).tokens, 0),
		onError: (error) => appendFileSync(runtimeErrors, `${JSON.stringify(error, errorReplacer)}\n`),
		...(arm.profile.configuration.selection.mode === 'periodic' ? {
			selection: {
				catalogue,
				limits: config.adaptiveRuntime.selectionLimits,
				feedback: async () => [],
			},
		} : {}),
	}
}

async function snapshotStore(store: LegacyStore | NeuronStore, collections: readonly string[]): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {}
	const record = store as Record<string, unknown>
	for (const name of collections) {
		const collection = record[name]
		if (typeof collection !== 'object' || collection === null || !('list' in collection)) {
			snapshot[name] = { unavailable: true }
			continue
		}
		const list = (collection as { list(): Promise<unknown[]> }).list
		snapshot[name] = await list.call(collection)
	}
	return snapshot
}

async function loadLegacy(config: LongitudinalConfig): Promise<LegacyRuntime> {
	const root = resolveConfigured(config.baseline.root)
	if (gitValue(root, ['rev-parse', 'HEAD']) !== config.baseline.revision) {
		throw new Error('v1 baseline revision does not match configured revision')
	}
	const [core, sqlite] = await Promise.all([
		import(pathToFileURL(resolve(root, 'src/index.ts')).href),
		import(pathToFileURL(resolve(root, 'src/sqlite.ts')).href),
	])
	return { ...(core as unknown as Omit<LegacyRuntime, 'SQLiteNeuronStore'>), ...(sqlite as unknown as Pick<LegacyRuntime, 'SQLiteNeuronStore'>) }
}

interface ActiveJobRuntime {
	neuron: PublicNeuron
	store: LegacyStore | NeuronStore
	evidence: EvidenceRuntime
	adaptive?: AdaptiveTextLearningRuntime
}

function eventWriter(jobDirectory: string): (event: unknown) => void {
	const path = resolve(jobDirectory, 'events.raw.jsonl')
	return (event) => appendFileSync(path, `${JSON.stringify(event, errorReplacer)}\n`)
}

async function createJobRuntime(
	config: LongitudinalConfig,
	stream: LongitudinalStream,
	arm: LongitudinalArm,
	job: LongitudinalJob,
	jobDirectory: string,
	databasePath: string,
): Promise<ActiveJobRuntime> {
	if (arm.kind === 'v1') {
		const legacy = await loadLegacy(config)
		const evidence = createEvidenceRuntime(config, jobDirectory, (providers) => legacy.createAiSdkLLM({ providers }))
		const store = new legacy.SQLiteNeuronStore(databasePath)
		evidence.phase.value = 'initialize'
		const protectedInstructions = [stream.lens.purpose, ...stream.lens.developerInstructions].join('\n')
		const neuron = await legacy.TextNeuron.create({
			id: jobNeuronId(config, job),
			model: evidence.model,
			llm: evidence.llm,
			store,
			instructions: stream.lens.purpose,
			observeInstructions: protectedInstructions,
			understandInstructions: protectedInstructions,
			understand: { thresholds: arm.understand },
			governance: arm.governance,
			onEvent: eventWriter(jobDirectory),
		})
		return { neuron, store, evidence }
	}
	const evidence = createEvidenceRuntime(config, jobDirectory, (providers) => createAiSdkLLM({ providers }))
	const store = new SQLiteNeuronStore(databasePath)
	const runtime = adaptiveRuntime(config, arm, stream, job, evidence, jobDirectory)
	const initialProfile = profileFor(config, arm, stream, job, assignedProcedure(arm, stream.id))
	if (initialProfile.configuration.model.id !== config.provider.modelId) {
		throw new Error(`adaptive model profile does not match provider model: ${arm.id}`)
	}
	evidence.phase.value = 'initialize'
	const neuron = await TextNeuron.create({
		id: jobNeuronId(config, job),
		model: evidence.model,
		llm: evidence.llm,
		store,
		instructions: stream.lens.purpose,
		onEvent: eventWriter(jobDirectory),
		learning: { mode: 'adaptive', initialProfile, runtime },
	})
	return { neuron, store, evidence, adaptive: runtime }
}

async function restoreJobRuntime(
	config: LongitudinalConfig,
	stream: LongitudinalStream,
	arm: LongitudinalArm,
	job: LongitudinalJob,
	jobDirectory: string,
	databasePath: string,
): Promise<ActiveJobRuntime> {
	if (arm.kind === 'v1') {
		const legacy = await loadLegacy(config)
		const evidence = createEvidenceRuntime(config, jobDirectory, (providers) => legacy.createAiSdkLLM({ providers }))
		const store = new legacy.SQLiteNeuronStore(databasePath)
		evidence.phase.value = 'restore'
		const neuron = await legacy.TextNeuron.restore(store, {
			id: jobNeuronId(config, job), model: evidence.model, llm: evidence.llm,
			onEvent: eventWriter(jobDirectory),
		})
		return { neuron, store, evidence }
	}
	const evidence = createEvidenceRuntime(config, jobDirectory, (providers) => createAiSdkLLM({ providers }))
	const store = new SQLiteNeuronStore(databasePath)
	const runtime = adaptiveRuntime(config, arm, stream, job, evidence, jobDirectory)
	evidence.phase.value = 'restore'
	const neuron = await TextNeuron.restore(store, {
		id: jobNeuronId(config, job), model: evidence.model, llm: evidence.llm,
		onEvent: eventWriter(jobDirectory),
		learning: {
			mode: 'adaptive', runtime,
		},
	})
	return { neuron, store, evidence, adaptive: runtime }
}

async function runPublicResume(runtime: ActiveJobRuntime, arm: LongitudinalArm, jobDirectory: string): Promise<void> {
	runtime.evidence.phase.value = 'process-resume'
	if (arm.kind === 'v1') {
		const result = await runtime.neuron.learn([], { forceSynthesize: true })
		writeEvidence(resolve(jobDirectory, 'recovery'), 'v1-empty-force-synthesis', result)
		return
	}
	if (runtime.neuron.resume === undefined) throw new Error('adaptive TextNeuron does not expose resume')
	const result = await runtime.neuron.resume()
	writeEvidence(resolve(jobDirectory, 'recovery'), 'adaptive-resume', result)
}

async function runCheckpoint(
	config: LongitudinalConfig,
	stream: LongitudinalStream,
	arm: LongitudinalArm,
	job: LongitudinalJob,
	jobDirectory: string,
	databasePath: string,
	checkpoint: number,
	runtime: ActiveJobRuntime,
): Promise<ActiveJobRuntime> {
	const directory = resolve(jobDirectory, 'checkpoints', String(checkpoint).padStart(3, '0'))
	mkdirSync(directory, { recursive: false })
	runtime.evidence.phase.value = `checkpoint-${String(checkpoint)}-flush`
	const flushResult = arm.kind === 'v1'
		? await runtime.neuron.learn([], { forceSynthesize: true })
		: await runtime.neuron.flush?.()
	writeEvidence(directory, 'flush-result', flushResult)
	runtime.evidence.phase.value = `checkpoint-${String(checkpoint)}-snapshot`
	const before = {
		understanding: await runtime.neuron.getUnderstanding(),
		learningState: await runtime.neuron.getLearningState?.(),
		store: await snapshotStore(runtime.store, arm.kind === 'v1' ? config.storeCollections.v1 : config.storeCollections.current),
	}
	writeEvidence(directory, 'before-reopen', before)
	await runtime.neuron.dispose()
	const reopened = await restoreJobRuntime(config, stream, arm, job, jobDirectory, databasePath)
	const after = {
		understanding: await reopened.neuron.getUnderstanding(),
		learningState: await reopened.neuron.getLearningState?.(),
		store: await snapshotStore(reopened.store, arm.kind === 'v1' ? config.storeCollections.v1 : config.storeCollections.current),
	}
	writeEvidence(directory, 'after-reopen', after)
	for (let index = 0; index < config.queries.length; index += 1) {
		const question = config.queries[index]!
		reopened.evidence.phase.value = `checkpoint-${String(checkpoint)}-query-${String(index + 1)}`
		writeEvidence(directory, `query-${String(index + 1).padStart(2, '0')}-input`, { question })
		try {
			const result = await reopened.neuron.query(question)
			writeEvidence(directory, `query-${String(index + 1).padStart(2, '0')}-result`, result)
		} catch (error) {
			writeEvidence(directory, `query-${String(index + 1).padStart(2, '0')}-error`, error)
		}
	}
	return reopened
}

function shouldInterrupt(config: LongitudinalConfig, job: LongitudinalJob, afterInput: number): boolean {
	return config.recovery.enabled &&
		config.recovery.streamId === job.streamId &&
		config.recovery.armId === job.armId &&
		config.recovery.repetition === job.repetition &&
		config.recovery.afterInput === afterInput
}

function initialProgress(path: string): JobProgress {
	if (!existsSync(path)) return { nextInputIndex: 0, completedCheckpoints: [], recoveryTriggered: false }
	const value = readJson(path)
	if (typeof value !== 'object' || value === null) throw new Error('job progress is invalid')
	const candidate = value as Partial<JobProgress>
	if (!Number.isInteger(candidate.nextInputIndex) || !Array.isArray(candidate.completedCheckpoints) || typeof candidate.recoveryTriggered !== 'boolean') {
		throw new Error('job progress fields are invalid')
	}
	return candidate as JobProgress
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((accept) => setTimeout(accept, milliseconds))
}

async function runWorker(configPath: string, runDirectory: string, jobId: string, resume: boolean): Promise<void> {
	const config = readLongitudinalConfig(configPath)
	const job = expandExecutionPlan(config).find((entry) => entry.id === jobId)
	if (job === undefined) throw new Error(`worker job is absent from execution plan: ${jobId}`)
	const arm = selectedArm(config, job.armId)
	const { stream, raw } = readSelectedStream(config, job.streamId)
	const jobDirectory = resolve(runDirectory, 'jobs', job.id)
	const progressPath = resolve(jobDirectory, 'progress.json')
	const databasePath = resolve(jobDirectory, config.paths.databaseFileName)
	if (!resume) {
		mkdirSync(jobDirectory, { recursive: false })
		mkdirSync(resolve(jobDirectory, 'deliveries'), { recursive: false })
		mkdirSync(resolve(jobDirectory, 'checkpoints'), { recursive: false })
		writeFileSync(resolve(jobDirectory, 'supplied-stream.raw.json'), raw)
		writeEvidence(jobDirectory, 'job-input', { label: 'UNJUDGED', job, arm, streamDescriptor: selectedStreamDescriptor(config, stream.id) })
		writeProgress(progressPath, { nextInputIndex: 0, completedCheckpoints: [], recoveryTriggered: false })
	}
	const startedUsage = process.resourceUsage()
	let progress = initialProgress(progressPath)
	let runtime = resume
		? await restoreJobRuntime(config, stream, arm, job, jobDirectory, databasePath)
		: await createJobRuntime(config, stream, arm, job, jobDirectory, databasePath)
	if (resume) await runPublicResume(runtime, arm, jobDirectory)
	for (const checkpoint of stream.checkpoints) {
		if (checkpoint <= progress.nextInputIndex && !progress.completedCheckpoints.includes(checkpoint)) {
			runtime = await runCheckpoint(config, stream, arm, job, jobDirectory, databasePath, checkpoint, runtime)
			progress = { ...progress, completedCheckpoints: [...progress.completedCheckpoints, checkpoint] }
			writeProgress(progressPath, progress)
		}
	}
	for (let index = progress.nextInputIndex; index < stream.inputs.length; index += 1) {
		const input = stream.inputs[index]!
		const delivery = index + 1
		const directory = resolve(jobDirectory, 'deliveries', String(delivery).padStart(3, '0'))
		mkdirSync(directory, { recursive: false })
		writeEvidence(directory, 'input', input)
		runtime.evidence.phase.value = `delivery-${String(delivery).padStart(3, '0')}-learn`
		try {
			const batch = arm.kind === 'v1' ? [input.text] : [input]
			const result = await runtime.neuron.learn(batch, { forceSynthesize: false })
			writeEvidence(directory, 'result', result)
		} catch (error) {
			writeEvidence(directory, 'error', error)
			throw error
		}
		progress = { ...progress, nextInputIndex: delivery }
		writeProgress(progressPath, progress)
		if (shouldInterrupt(config, job, delivery) && !progress.recoveryTriggered) {
			progress = { ...progress, recoveryTriggered: true }
			writeProgress(progressPath, progress)
			writeEvidence(resolve(jobDirectory, 'recovery'), 'interrupt-marker', {
				stage: 'after-public-learn-before-checkpoint', delivery, signal: 'SIGKILL',
			})
			process.kill(process.pid, 'SIGKILL')
		}
		if (config.dueWakeup.enabled && config.dueWakeup.afterInput === delivery) {
			runtime.evidence.phase.value = `delivery-${String(delivery).padStart(3, '0')}-due-wakeup-wait`
			await wait(config.dueWakeup.waitMs)
			writeEvidence(directory, 'due-wakeup-wait', { waitMs: config.dueWakeup.waitMs })
		}
		if (stream.checkpoints.includes(delivery)) {
			runtime = await runCheckpoint(config, stream, arm, job, jobDirectory, databasePath, delivery, runtime)
			progress = { ...progress, completedCheckpoints: [...progress.completedCheckpoints, delivery] }
			writeProgress(progressPath, progress)
		}
	}
	const finalDirectory = resolve(jobDirectory, 'final')
	mkdirSync(finalDirectory, { recursive: false })
	writeEvidence(finalDirectory, 'understanding', { text: await runtime.neuron.getUnderstanding() })
	writeEvidence(finalDirectory, 'learning-state', await runtime.neuron.getLearningState?.())
	writeEvidence(finalDirectory, 'store', await snapshotStore(runtime.store, arm.kind === 'v1' ? config.storeCollections.v1 : config.storeCollections.current))
	await runtime.neuron.dispose()
	writeEvidence(finalDirectory, 'process-resources', { started: startedUsage, completed: process.resourceUsage() })
}

interface ProcessEvidence {
	readonly jobId: string
	readonly attempt: 'initial' | 'resume'
	readonly startedAt: string
	readonly completedAt: string
	readonly status: number | null
	readonly signal: NodeJS.Signals | null
}

function sourceFingerprints(config: LongitudinalConfig): readonly { id: string; path: string; sha256: string; bytes: number }[] {
	return config.sourceFiles.map(({ id, path }) => {
		const absolute = resolveConfigured(path)
		const raw = readFileSync(absolute)
		return { id, path: absolute, sha256: sha256(raw), bytes: raw.byteLength }
	})
}

function captureRuntimeCommands(config: LongitudinalConfig, directory: string): void {
	mkdirSync(directory, { recursive: false })
	for (const command of config.runtimeCommands) {
		const result = spawnSync(command.executable, command.arguments)
		const commandDirectory = resolve(directory, command.id)
		mkdirSync(commandDirectory, { recursive: false })
		writeFileSync(resolve(commandDirectory, 'stdout.raw.bin'), result.stdout ?? Buffer.alloc(0))
		writeFileSync(resolve(commandDirectory, 'stderr.raw.bin'), result.stderr ?? Buffer.alloc(0))
		writeEvidence(commandDirectory, 'process', {
			executable: command.executable,
			arguments: command.arguments,
			status: result.status,
			signal: result.signal,
			error: result.error,
		})
	}
}

function verifyFixtureManifest(config: LongitudinalConfig): void {
	const path = resolveConfigured(config.fixtureManifest.path)
	const raw = readFileSync(path)
	if (sha256(raw) !== config.fixtureManifest.sha256) throw new Error('fixture manifest digest differs from config')
	const manifest = fixtureManifestSchema.parse(JSON.parse(raw.toString('utf8')) as unknown)
	for (const descriptor of config.streams) {
		const stream = manifest.files.find((entry) => entry.role === 'input-stream' && resolveConfigured(entry.path) === resolveConfigured(descriptor.path))
		const reviewer = manifest.files.find((entry) => entry.role === 'reviewer-key' && resolveConfigured(entry.path) === resolveConfigured(descriptor.reviewerKeyPath))
		if (stream?.sha256 !== descriptor.sha256 || stream.visibility !== descriptor.visibility) {
			throw new Error(`stream descriptor differs from fixture manifest: ${descriptor.id}`)
		}
		if (reviewer?.sha256 !== descriptor.reviewerKeySha256 || reviewer.visibility !== descriptor.visibility) {
			throw new Error(`reviewer descriptor differs from fixture manifest: ${descriptor.id}`)
		}
	}
}

function runChild(
	configPath: string,
	runDirectory: string,
	job: LongitudinalJob,
	attempt: 'initial' | 'resume',
): ProcessEvidence {
	const processRoot = resolve(runDirectory, 'processes', job.id)
	mkdirSync(processRoot, { recursive: true })
	const processDirectory = resolve(processRoot, attempt)
	mkdirSync(processDirectory, { recursive: false })
	const startedAt = new Date().toISOString()
	const arguments_ = [
		'--import', 'tsx', resolveConfigured(process.argv[1]!), configPath,
		'--worker', runDirectory, job.id,
		...(attempt === 'resume' ? ['--resume'] : []),
	]
	const result = spawnSync(process.execPath, arguments_, { cwd: process.cwd() })
	writeFileSync(resolve(processDirectory, 'stdout.raw.bin'), result.stdout ?? Buffer.alloc(0))
	writeFileSync(resolve(processDirectory, 'stderr.raw.bin'), result.stderr ?? Buffer.alloc(0))
	const evidence: ProcessEvidence = {
		jobId: job.id,
		attempt,
		startedAt,
		completedAt: new Date().toISOString(),
		status: result.status,
		signal: result.signal,
	}
	writeEvidence(processDirectory, 'process', { ...evidence, executable: process.execPath, arguments: arguments_, error: result.error })
	return evidence
}

function writeRunManifest(
	runDirectory: string,
	config: LongitudinalConfig,
	plan: readonly LongitudinalJob[],
	processes: readonly ProcessEvidence[],
): void {
	writeJson(resolve(runDirectory, 'manifest.json'), {
		label: 'UNJUDGED',
		generatedAt: new Date().toISOString(),
		design: {
			configuredStreams: config.streams.length,
			configuredArms: config.arms.map(({ id }) => id),
			selectedStreams: config.selection.streamIds,
			selectedArms: config.selection.armIds,
			selectedRepetitions: config.selection.repetitions,
			selectedJobCount: plan.length,
			fullRequestedDesign: { streams: 4, arms: 4, models: 2, repetitions: 3 },
		},
		processes,
		files: listFiles(runDirectory).filter((path) => path !== 'manifest.json'),
	})
}

async function runParent(configPath: string): Promise<string> {
	const absoluteConfigPath = resolveConfigured(configPath)
	const rawConfig = readFileSync(absoluteConfigPath)
	const config = readLongitudinalConfig(absoluteConfigPath)
	verifyFixtureManifest(config)
	if (gitValue(resolveConfigured(config.baseline.root), ['rev-parse', 'HEAD']) !== config.baseline.revision) {
		throw new Error('v1 baseline revision does not match configured revision')
	}
	const plan = expandExecutionPlan(config)
	const runDirectory = reserveRunDirectory(config.paths.outputRoot)
	mkdirSync(resolve(runDirectory, 'jobs'), { recursive: false })
	mkdirSync(resolve(runDirectory, 'processes'), { recursive: false })
	writeFileSync(resolve(runDirectory, 'supplied-config.raw.json'), rawConfig)
	copyFileSync(resolveConfigured(config.fixtureManifest.path), resolve(runDirectory, 'fixture-manifest.raw.json'))
	if (config.profileLineage !== undefined) {
		const lineage = readFileSync(resolveConfigured(config.profileLineage.path))
		if (sha256(lineage) !== config.profileLineage.sha256) throw new Error('profile lineage digest differs from config')
		writeFileSync(resolve(runDirectory, 'profile-lineage.raw.json'), lineage)
	}
	writeEvidence(runDirectory, 'run-input', {
		label: 'UNJUDGED',
		configPath: absoluteConfigPath,
		configSha256: sha256(rawConfig),
		fixtureManifestSha256: config.fixtureManifest.sha256,
		plan,
		comparisonDisclosure: {
			claim: 'configured longitudinal pipelines; not an isolated procedure effect',
			v1DeliveryShape: 'plain text passed through the original observe and understand pipeline',
			currentDeliveryShape: 'TextInput passed through the public adaptive TextNeuron lifecycle',
			armConfigurations: config.arms,
		},
		reviewerKeys: config.streams.map(({ id, reviewerKeyPath, reviewerKeySha256, visibility }) => ({
			id, path: resolveConfigured(reviewerKeyPath), sha256: reviewerKeySha256, visibility, suppliedToModel: false,
		})),
	})
	writeEvidence(runDirectory, 'source-before', {
		current: {
			head: gitValue(process.cwd(), ['rev-parse', 'HEAD']),
			status: gitValue(process.cwd(), ['status', '--short']),
			files: sourceFingerprints(config),
		},
		baseline: {
			head: gitValue(config.baseline.root, ['rev-parse', 'HEAD']),
			status: gitValue(config.baseline.root, ['status', '--short']),
		},
	})
	captureRuntimeCommands(config, resolve(runDirectory, 'runtime-before'))
	const processes: ProcessEvidence[] = []
	for (const job of plan) {
		const initial = runChild(absoluteConfigPath, runDirectory, job, 'initial')
		processes.push(initial)
		writeRunManifest(runDirectory, config, plan, processes)
		if (initial.signal === 'SIGKILL' && config.recovery.enabled &&
			config.recovery.streamId === job.streamId && config.recovery.armId === job.armId &&
			config.recovery.repetition === job.repetition) {
			processes.push(runChild(absoluteConfigPath, runDirectory, job, 'resume'))
			writeRunManifest(runDirectory, config, plan, processes)
		}
	}
	captureRuntimeCommands(config, resolve(runDirectory, 'runtime-after'))
	writeEvidence(runDirectory, 'source-after', {
		current: {
			head: gitValue(process.cwd(), ['rev-parse', 'HEAD']),
			status: gitValue(process.cwd(), ['status', '--short']),
			files: sourceFingerprints(config),
		},
		baseline: {
			head: gitValue(config.baseline.root, ['rev-parse', 'HEAD']),
			status: gitValue(config.baseline.root, ['status', '--short']),
		},
	})
	writeRunManifest(runDirectory, config, plan, processes)
	return runDirectory
}

function parseArguments():
	| { readonly kind: 'parent'; readonly configPath: string }
	| { readonly kind: 'worker'; readonly configPath: string; readonly runDirectory: string; readonly jobId: string; readonly resume: boolean } {
	const configPath = process.argv[2]
	if (configPath === undefined) throw new Error('provide a longitudinal evaluation config path')
	if (process.argv[3] === undefined) return { kind: 'parent', configPath: resolveConfigured(configPath) }
	if (process.argv[3] !== '--worker') throw new Error(`unknown argument: ${process.argv[3]}`)
	const runDirectory = process.argv[4]
	const jobId = process.argv[5]
	if (runDirectory === undefined || jobId === undefined) throw new Error('--worker requires run directory and job id')
	const optional = process.argv[6]
	if (optional !== undefined && optional !== '--resume') throw new Error(`unknown worker argument: ${optional}`)
	return {
		kind: 'worker', configPath: resolveConfigured(configPath),
		runDirectory: resolveConfigured(runDirectory), jobId, resume: optional === '--resume',
	}
}

async function main(): Promise<void> {
	const arguments_ = parseArguments()
	if (arguments_.kind === 'worker') {
		await runWorker(arguments_.configPath, arguments_.runDirectory, arguments_.jobId, arguments_.resume)
		return
	}
	const directory = await runParent(arguments_.configPath)
	console.log(directory)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolveConfigured(invokedPath)).href) {
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}

export const longitudinalEvalSupport = {
	configSchema,
	streamSchema,
	fixtureManifestSchema,
	readLongitudinalConfig,
	expandExecutionPlan,
	readSelectedStream,
	reserveRunDirectory,
}
