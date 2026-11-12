/**
 * Eval: adaptive text procedure operations, four recipes, and selection.
 *
 * Records supplied inputs, exact local wire exchanges, raw AI SDK results or
 * errors, and raw module outputs. It performs no grading or expected comparison.
 *
 * Run:
 *   npx tsx evals/scripts/adaptive-text-procedures-eval.ts <config-path>
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { z } from 'zod'

import { createAiSdkLLM } from '../../src/llm'
import { createBoundedDeviceScheduler } from '../../src/llm/local/scheduler'
import { LearningRegistry } from '../../src/learning/registry'
import {
	createAdaptTextProcedureProvider,
	createConservativeByteTokenCounter,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	selectTextProcedure,
	textProcedureRecipeRefs,
	type ProcedureSelectionInput,
	type TextLearningConfig,
} from '../../src/learning/text-procedures'

const textInputSchema = z.object({
	deliveryId: z.string().min(1), eventId: z.string().min(1).optional(), text: z.string(),
	observedAt: z.string().min(1), urgency: z.enum(['normal', 'urgent']).optional(),
}).strict().readonly()
const lensSchema = z.object({
	purpose: z.string().min(1), developerInstructions: z.array(z.string().min(1)).readonly(),
	instructionPrecedence: z.array(z.string().min(1)).readonly(), incomingTextRole: z.literal('data-only'),
}).strict().readonly()
const caseBase = {
	id: z.string().min(1),
	memory: z.object({ text: z.string(), revision: z.number().int().nonnegative() }).strict().readonly(),
	inputs: z.array(textInputSchema).readonly(), lens: lensSchema,
}
const procedureCaseSchema = z.object({
	...caseBase,
	kind: z.enum(['writer', 'compare', 'pattern', 'combined']),
	procedure: z.enum(['direct', 'compare-rewrite', 'pattern-rewrite', 'compare-pattern-rewrite']),
}).strict().readonly()
const metricsSchema = z.object({
	committedRuns: z.number().int().nonnegative(), deferredRuns: z.number().int().nonnegative(),
	failedRuns: z.number().int().nonnegative(), meanBatchItems: z.number().nonnegative(),
}).strict().readonly()
const selectorCaseSchema = z.object({
	...caseBase,
	kind: z.literal('selector'),
	selection: z.object({
		currentProcedure: z.enum(['direct', 'compare-rewrite', 'pattern-rewrite', 'compare-pattern-rewrite']),
		allowed: z.array(z.object({ id: z.enum(['direct', 'compare-rewrite', 'pattern-rewrite', 'compare-pattern-rewrite']), expectedEffect: z.string().min(1) }).strict().readonly()).min(1).readonly(),
		learnedChanges: z.array(z.string().min(1)).readonly(), pending: z.array(textInputSchema).readonly(),
		feedback: z.array(z.string().min(1)).readonly(), metrics: metricsSchema,
	}).strict().readonly(),
}).strict().readonly()
const datasetSchema = z.object({
	schemaVersion: z.literal(1), synthetic: z.literal(true),
	cases: z.array(z.discriminatedUnion('kind', [procedureCaseSchema, selectorCaseSchema])).min(1).readonly(),
}).strict().readonly()

const positiveInteger = z.number().int().positive()
const nonnegativeInteger = z.number().int().nonnegative()
const configSchema = z.object({
	schemaVersion: z.literal(1),
	provider: z.object({
		name: z.string().min(1), baseUrl: z.string().url(), modelId: z.string().min(1),
		apiKeyEnv: z.string().min(1).optional(),
	}).strict().readonly(),
	settings: z.object({
		temperature: z.number(), maxOutputTokens: positiveInteger,
		maxRetries: nonnegativeInteger, timeoutMs: positiveInteger,
	}).strict().readonly(),
	datasetPath: z.string().min(1), datasetSha256: z.string().min(1),
	outputRoot: z.string().min(1), repetitions: positiveInteger,
	clock: z.string().min(1),
	ids: z.object({
		registryRevision: z.string().min(1), neuronId: z.string().min(1),
		incarnation: z.string().min(1), ownershipRevision: nonnegativeInteger,
		profileId: z.string().min(1), profileVersion: z.string().min(1),
		modelVersion: z.string().min(1), selectorId: z.string().min(1), selectorVersion: z.string().min(1),
		profileRevision: nonnegativeInteger, configurationRevision: nonnegativeInteger,
	}).strict().readonly(),
	profile: z.object({
		selectionMode: z.enum(['fixed', 'periodic']), selectionTrigger: z.enum(['periodic', 'feedback', 'operational']),
		minCommittedRuns: nonnegativeInteger, minElapsedMs: nonnegativeInteger,
		autoActivatePreEvaluated: z.boolean(), maxBatchDelayMs: nonnegativeInteger,
		acceptCallerUrgency: z.boolean(), allowExplicitClear: z.boolean(),
		standaloneCapacity: z.enum(['compact', 'reject']),
		maxLogicalAttempts: nonnegativeInteger, initialRetryDelayMs: nonnegativeInteger,
		maxRetryDelayMs: nonnegativeInteger, terminalAfterMs: nonnegativeInteger,
		maxHistoryEntries: positiveInteger, maxHistoryCharacters: positiveInteger,
		processedIdHorizonMs: nonnegativeInteger, maxProcessedIds: positiveInteger,
	}).strict().readonly(),
	procedure: z.object({
		loadedContextTokens: positiveInteger, reservedOutputTokens: positiveInteger,
		maxNoteCharacters: positiveInteger, maxProviderCalls: positiveInteger,
		maxTokenClaims: positiveInteger, maxBudgetClaims: positiveInteger,
		maxItems: positiveInteger, maxInputCharacters: positiveInteger, maxInputTokens: positiveInteger,
		maxItemCharacters: positiveInteger, maxRoutingSpanCharacters: positiveInteger,
		maxMemoryCharacters: positiveInteger, maxNarrativeTokens: positiveInteger,
		splitPressureCharacters: positiveInteger,
		planning: z.object({ maxNodes: positiveInteger, maxCollectionItems: positiveInteger, maxOperations: positiveInteger }).strict().readonly(),
	}).strict().readonly(),
	selection: z.object({
		maxCatalogueEntries: positiveInteger, maxContextCharacters: positiveInteger,
	}).strict().readonly(),
	tokenCounter: z.object({
		requestTemplateOverheadTokens: nonnegativeInteger, textTemplateOverheadTokens: nonnegativeInteger,
	}).strict().readonly(),
	scheduler: z.object({
		maxConcurrent: positiveInteger, maxQueued: nonnegativeInteger,
		priority: z.enum(['query', 'foreground', 'background']),
	}).strict().readonly(),
}).strict().readonly()

type EvalConfig = z.infer<typeof configSchema>
type EvalCase = z.infer<typeof datasetSchema>['cases'][number]

function exactInspect(value: unknown): string {
	return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, getters: true })
}

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
	}
	if (typeof value === 'bigint') return value.toString()
	return value
}

function writeEvidence(directory: string, stem: string, value: unknown): void {
	writeFileSync(resolve(directory, `${stem}.raw.json`), `${JSON.stringify(value, replacer, 2)}\n`)
	writeFileSync(resolve(directory, `${stem}.raw.inspect.txt`), `${exactInspect(value)}\n`)
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

function observedModel(config: EvalConfig, caseDirectory: string): LanguageModel {
	const apiKey = config.provider.apiKeyEnv === undefined
		? undefined
		: process.env[config.provider.apiKeyEnv]
	const transportDirectory = resolve(caseDirectory, 'wire')
	const sdkDirectory = resolve(caseDirectory, 'sdk')
	mkdirSync(transportDirectory, { recursive: true })
	mkdirSync(sdkDirectory, { recursive: true })
	let wireIndex = 0
	const observedFetch: typeof fetch = async (input, init) => {
		wireIndex += 1
		const stem = String(wireIndex).padStart(3, '0')
		const request = new Request(input, init)
		writeFileSync(resolve(transportDirectory, `${stem}-request-body.raw.txt`), await request.clone().text())
		writeEvidence(transportDirectory, `${stem}-request-metadata`, {
			url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()),
		})
		try {
			const response = await fetch(request)
			writeFileSync(resolve(transportDirectory, `${stem}-response-body.raw.txt`), await response.clone().text())
			writeEvidence(transportDirectory, `${stem}-response-metadata`, {
				status: response.status, headers: Object.fromEntries(response.headers.entries()),
			})
			return response
		} catch (error) {
			writeEvidence(transportDirectory, `${stem}-error`, error)
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: config.provider.name, baseURL: config.provider.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }), fetch: observedFetch,
	})
	const model = provider(config.provider.modelId)
	let sdkIndex = 0
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property !== 'doGenerate') return Reflect.get(target, property, receiver)
			return async (options: unknown) => {
				sdkIndex += 1
				const stem = String(sdkIndex).padStart(3, '0')
				writeEvidence(sdkDirectory, `${stem}-input`, options)
				try {
					const result = await target.doGenerate(options as never)
					writeEvidence(sdkDirectory, `${stem}-result`, result)
					return result
				} catch (error) {
					writeEvidence(sdkDirectory, `${stem}-error`, error)
					throw error
				}
			}
		},
	}) as LanguageModel
}

const procedureRefs = {
	direct: textProcedureRecipeRefs.direct,
	'compare-rewrite': textProcedureRecipeRefs.compare,
	'pattern-rewrite': textProcedureRecipeRefs.pattern,
	'compare-pattern-rewrite': textProcedureRecipeRefs.comparePattern,
} as const

function learningConfig(config: EvalConfig, suppliedCase: EvalCase, activeProcedure: keyof typeof procedureRefs): TextLearningConfig {
	return {
		lens: suppliedCase.lens,
		model: { id: config.provider.modelId, version: config.ids.modelVersion },
		activeProcedure: procedureRefs[activeProcedure], allowedProcedures: Object.values(procedureRefs),
		selection: {
			mode: config.profile.selectionMode, selector: { id: config.ids.selectorId, version: config.ids.selectorVersion },
			minCommittedRuns: config.profile.minCommittedRuns, minElapsedMs: config.profile.minElapsedMs,
			maxCatalogueEntries: config.selection.maxCatalogueEntries,
			autoActivatePreEvaluated: config.profile.autoActivatePreEvaluated,
		},
		batching: {
			maxItems: config.procedure.maxItems, maxInputCharacters: config.procedure.maxInputCharacters,
			maxInputTokens: config.procedure.maxInputTokens,
			maxDelayMs: config.profile.maxBatchDelayMs,
			acceptCallerUrgency: config.profile.acceptCallerUrgency,
		},
		input: {
			maxItemCharacters: config.procedure.maxItemCharacters,
			maxRoutingSpanCharacters: config.procedure.maxRoutingSpanCharacters,
		},
		memory: {
			maxCharacters: config.procedure.maxMemoryCharacters,
			maxNarrativeTokens: config.procedure.maxNarrativeTokens,
			splitPressureCharacters: config.procedure.splitPressureCharacters,
			allowExplicitClear: config.profile.allowExplicitClear,
			standaloneCapacity: config.profile.standaloneCapacity,
		},
		generation: {
			loadedContextTokens: config.procedure.loadedContextTokens,
			reservedOutputTokens: config.procedure.reservedOutputTokens,
			maxNoteCharacters: config.procedure.maxNoteCharacters,
			maxProviderCalls: config.procedure.maxProviderCalls,
			maxTokenClaims: config.procedure.maxTokenClaims,
			maxBudgetClaims: config.procedure.maxBudgetClaims,
		},
		planning: config.procedure.planning,
		retries: {
			maxLogicalAttempts: config.profile.maxLogicalAttempts,
			initialDelayMs: config.profile.initialRetryDelayMs,
			maxDelayMs: config.profile.maxRetryDelayMs,
			terminalAfterMs: config.profile.terminalAfterMs,
		},
		history: { maxEntries: config.profile.maxHistoryEntries, maxCharacters: config.profile.maxHistoryCharacters },
		idempotence: {
			processedIdHorizonMs: config.profile.processedIdHorizonMs,
			maxProcessedIds: config.profile.maxProcessedIds,
		},
	}
}

async function runCase(config: EvalConfig, suppliedCase: EvalCase, caseDirectory: string): Promise<void> {
	mkdirSync(caseDirectory, { recursive: true })
	writeEvidence(caseDirectory, 'constructed-input', suppliedCase)
	const model = observedModel(config, caseDirectory)
	const llm = createAiSdkLLM({ providers: { [config.provider.name]: () => model } })
	const scheduler = createBoundedDeviceScheduler({
		maxConcurrent: config.scheduler.maxConcurrent, maxQueued: config.scheduler.maxQueued,
	})
	const provider = createAdaptTextProcedureProvider({
		llm,
		model: { plugin: 'ai-sdk', provider: config.provider.name, id: config.provider.modelId },
		settings: {
			temperature: config.settings.temperature, maxOutputTokens: config.settings.maxOutputTokens,
			maxRetries: config.settings.maxRetries, timeout: config.settings.timeoutMs,
		},
		scheduler, priority: config.scheduler.priority,
	})
	const tokens = createConservativeByteTokenCounter(config.tokenCounter)
	if (suppliedCase.kind === 'selector') {
		const currentProcedure = procedureRefs[suppliedCase.selection.currentProcedure]
		const input: ProcedureSelectionInput = {
			review: {
				id: `${suppliedCase.id}:review`, trigger: config.profile.selectionTrigger,
				contextDigest: digest(JSON.stringify(suppliedCase.selection)), evidenceRefs: [],
			},
			lens: suppliedCase.lens,
			state: {
				neuron: { id: config.ids.neuronId, incarnation: config.ids.incarnation, ownershipRevision: config.ids.ownershipRevision },
				learnedStateRevision: suppliedCase.memory.revision, procedure: currentProcedure,
				profile: { id: config.ids.profileId, version: config.ids.profileVersion },
				profileRevision: config.ids.profileRevision,
				model: { id: config.provider.modelId, version: config.ids.modelVersion },
				allowedCatalogueDigest: digest(JSON.stringify(suppliedCase.selection.allowed)),
				referencedDefinitionDigest: config.ids.registryRevision,
			},
			currentNarrative: suppliedCase.memory.text,
			learnedChanges: suppliedCase.selection.learnedChanges,
			pending: suppliedCase.selection.pending,
			feedback: suppliedCase.selection.feedback,
			metrics: suppliedCase.selection.metrics,
			allowed: suppliedCase.selection.allowed.map(({ id, expectedEffect }) => ({
				procedure: procedureRefs[id], expectedEffect, token: id,
			})),
			limits: {
				loadedContextTokens: config.procedure.loadedContextTokens,
				reservedOutputTokens: config.procedure.reservedOutputTokens,
				maxContextCharacters: config.selection.maxContextCharacters,
				maxCatalogueEntries: config.selection.maxCatalogueEntries,
			},
			signal: new AbortController().signal,
		}
		writeEvidence(caseDirectory, 'activation-input', input)
		const output = await selectTextProcedure(input, { provider, tokens })
		writeEvidence(caseDirectory, 'output', output)
		return
	}
	const procedure = procedureRefs[suppliedCase.procedure]
	const configuration = learningConfig(config, suppliedCase, suppliedCase.procedure)
	const registry = new LearningRegistry()
	registerAdaptiveTextProcedures(registry)
	const input = {
		runId: `${suppliedCase.id}:run`,
		pins: {
			execution: {
				memory: suppliedCase.memory.revision,
				configuration: config.ids.configurationRevision,
				registry: config.ids.registryRevision,
			},
			neuron: { id: config.ids.neuronId, incarnation: config.ids.incarnation, ownershipRevision: config.ids.ownershipRevision },
			procedure,
			profile: { id: config.ids.profileId, version: config.ids.profileVersion },
			model: configuration.model, learnedStateRevision: suppliedCase.memory.revision,
		},
		configuration, memory: suppliedCase.memory, inputs: suppliedCase.inputs,
		signal: new AbortController().signal,
	}
	writeEvidence(caseDirectory, 'activation-input', input)
	const output = await runTextProcedure(input, {
		provider, registry, tokens, clock: { now: () => config.clock },
	})
	writeEvidence(caseDirectory, 'output', output)
}

async function main(): Promise<void> {
	const configArgument = process.argv[2]
	if (configArgument === undefined) throw new Error('provide an eval config path')
	const configPath = resolve(configArgument)
	const configText = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configText))
	const datasetPath = resolve(config.datasetPath)
	const datasetText = readFileSync(datasetPath, 'utf8')
	const dataset = datasetSchema.parse(JSON.parse(datasetText))
	const directory = resolve(config.outputRoot, runId())
	mkdirSync(directory, { recursive: true })
	writeFileSync(resolve(directory, 'supplied-config.raw.json'), configText)
	writeFileSync(resolve(directory, 'supplied-dataset.raw.json'), datasetText)
	writeEvidence(directory, 'metadata', {
		script: 'evals/scripts/adaptive-text-procedures-eval.ts', timestamp: new Date().toISOString(),
		configPath, datasetPath, configuredDatasetSha256: config.datasetSha256,
		actualDatasetSha256: digest(datasetText), model: config.provider.modelId,
	})
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		for (const suppliedCase of dataset.cases) {
			const caseDirectory = resolve(directory, `repetition-${repetition}`, suppliedCase.id)
			try {
				await runCase(config, suppliedCase, caseDirectory)
			} catch (error) {
				mkdirSync(caseDirectory, { recursive: true })
				writeEvidence(caseDirectory, 'error', error)
			}
		}
	}
	console.log(directory)
}

main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
