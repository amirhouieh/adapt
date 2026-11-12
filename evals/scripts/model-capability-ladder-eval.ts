/**
 * Runs the unjudged model-capability ladder against one configured provider.
 * Every stage and repetition is independent. The harness records exact wire
 * bodies, SDK results or errors, and production narrative-recipe executions.
 *
 * Run:
 *   npx tsx evals/scripts/model-capability-ladder-eval.ts <config-path>
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	generateText,
	jsonSchema,
	Output,
	type LanguageModel,
} from 'ai'
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
} from '../../src/learning/index'

const jsonObjectSchema = z.record(z.string(), z.json())

const directStageSchema = z
	.object({
		id: z.string().min(1),
		kind: z.literal('direct'),
		system: z.string(),
		prompt: z.string(),
		outputSchema: jsonObjectSchema.optional(),
		enforceSchema: z.boolean(),
	})
	.strict()
	.superRefine((stage, context) => {
		if (stage.enforceSchema && stage.outputSchema === undefined) {
			context.addIssue({
				code: 'custom',
				message: 'enforced direct stages require outputSchema',
				path: ['outputSchema'],
			})
		}
	})

const recipeStageSchema = z
	.object({
		id: z.string().min(1),
		kind: z.literal('recipe'),
		lens: z
			.object({
				purpose: z.string().min(1),
				memoryType: z.literal('text'),
				schema: jsonObjectSchema,
				developerConstraints: z.string(),
			})
			.strict(),
		currentMemory: z.string(),
		observation: z.string(),
		recipeLimits: z
			.object({
				maxObservations: z.number().int().positive(),
				maxObservationCharacters: z.number().int().positive(),
				maxMemoryCharacters: z.number().int().positive(),
				maxContextCharacters: z.number().int().positive(),
			})
			.strict(),
	})
	.strict()

const stageSchema = z.union([directStageSchema, recipeStageSchema])

const datasetSchema = z
	.object({
		schemaVersion: z.literal(1),
		cases: z
			.array(
				z
					.object({
						id: z.string().min(1),
						description: z.string().min(1),
						stages: z.array(stageSchema).min(1),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()

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
		outputRoot: z.string().min(1),
		ids: z
			.object({
				recipeId: z.string().min(1),
				recipeVersion: z.string().min(1),
				registryRevision: z.string().min(1),
				memoryId: z.string().min(1),
			})
			.strict(),
		revisions: z
			.object({
				memory: z.number().int().nonnegative(),
				configuration: z.number().int().nonnegative(),
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
	})
	.strict()

export type CapabilityConfig = z.infer<typeof configSchema>
export type CapabilityDataset = z.infer<typeof datasetSchema>
export type DirectStage = z.infer<typeof directStageSchema>
export type RecipeStage = z.infer<typeof recipeStageSchema>

export function buildDirectRequest(stage: DirectStage): {
	readonly system: string
	readonly prompt: string
	readonly outputSchema?: Readonly<Record<string, unknown>>
} {
	return {
		system: stage.system,
		prompt: stage.prompt,
		...(stage.enforceSchema && stage.outputSchema !== undefined
			? { outputSchema: stage.outputSchema }
			: {}),
	}
}

export function buildRecipeInput(
	config: CapabilityConfig,
	caseId: string,
	stage: RecipeStage,
): {
	readonly lens: RecipeStage['lens']
	readonly memory: {
		readonly id: string
		readonly revision: number
		readonly text: string
		readonly processedInputIds: readonly string[]
	}
	readonly observations: readonly {
		readonly id: string
		readonly text: string
		readonly observedAt: string
	}[]
	readonly processedInputIds: readonly string[]
} {
	return {
		lens: stage.lens,
		memory: {
			id: config.ids.memoryId,
			revision: config.revisions.memory,
			text: stage.currentMemory,
			processedInputIds: [],
		},
		observations: [
			{
				id: `${caseId}:observation`,
				text: stage.observation,
				observedAt: config.observedAt,
			},
		],
		processedInputIds: [],
	}
}

function exactInspect(value: unknown): string {
	return inspect(value, {
		depth: null,
		maxArrayLength: null,
		maxStringLength: null,
		getters: true,
	})
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

export function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, errorAwareReplacer, 2)}\n`)
}

export function writeEvidence(directory: string, stem: string, value: unknown): void {
	writeJson(resolve(directory, `${stem}.json`), value)
	writeFileSync(resolve(directory, `${stem}.inspect.txt`), `${exactInspect(value)}\n`)
}

export function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

export function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

export function createObservedModel(
	config: Pick<CapabilityConfig, 'provider'>,
	stageDirectory: string,
): LanguageModel {
	const apiKeyEnv = config.provider.apiKeyEnv
	const apiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv]
	if (apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
		throw new Error(
			`configured provider credential environment variable ${apiKeyEnv} is absent`,
		)
	}
	const transportDirectory = resolve(stageDirectory, 'transport')
	mkdirSync(transportDirectory, { recursive: true })
	let exchangeIndex = 0
	const observedFetch: typeof fetch = async (input, init) => {
		exchangeIndex += 1
		const stem = String(exchangeIndex).padStart(3, '0')
		const request = new Request(input, init)
		writeFileSync(
			resolve(transportDirectory, `${stem}-request-body.raw.txt`),
			await request.clone().text(),
		)
		writeJson(resolve(transportDirectory, `${stem}-request-metadata.json`), {
			url: request.url,
			method: request.method,
			headers: request.headers.has('content-type')
				? { 'content-type': request.headers.get('content-type') }
				: {},
		})
		try {
			const response = await fetch(request)
			writeFileSync(
				resolve(transportDirectory, `${stem}-response-body.raw.txt`),
				await response.clone().text(),
			)
			writeJson(resolve(transportDirectory, `${stem}-response-metadata.json`), {
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			})
			return response
		} catch (error) {
			writeEvidence(transportDirectory, `${stem}-failure`, error)
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: config.provider.name,
		baseURL: config.provider.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }),
		fetch: observedFetch,
		supportsStructuredOutputs: true,
	})
	return provider(config.provider.modelId)
}

export function generationSettings(config: Pick<CapabilityConfig, 'settings'>) {
	return {
		temperature: config.settings.temperature,
		maxOutputTokens: config.settings.maxOutputTokens,
		maxRetries: config.settings.maxRetries,
		timeout: config.settings.timeoutMs,
	}
}

async function runDirectStage(
	config: CapabilityConfig,
	stage: DirectStage,
	stageDirectory: string,
): Promise<void> {
	const request = buildDirectRequest(stage)
	writeJson(resolve(stageDirectory, 'raw-input.json'), request)
	const model = createObservedModel(config, stageDirectory)
	try {
		const result = await generateText({
			model,
			system: request.system,
			prompt: request.prompt,
			...generationSettings(config),
			...(request.outputSchema === undefined
				? {}
				: {
						output: Output.object({
							schema: jsonSchema(request.outputSchema as never),
						}),
					}),
		})
		writeEvidence(stageDirectory, 'raw-output', result)
	} catch (error) {
		writeEvidence(stageDirectory, 'raw-error', error)
	}
}

function learningModel(
	config: CapabilityConfig,
	model: LanguageModel,
	stageDirectory: string,
): LearningModelCapability {
	let callIndex = 0
	return {
		async generate<T>(request: LearningGenerationRequest<T>) {
			callIndex += 1
			const stem = `model-output-${String(callIndex).padStart(3, '0')}`
			try {
				const result = await generateText({
					model,
					system: request.system,
					prompt: request.prompt,
					output: Output.object({ schema: request.schema }),
					abortSignal: request.signal,
					...generationSettings(config),
				})
				writeEvidence(stageDirectory, stem, result)
				return {
					value: result.output as T,
					raw: result,
					usage: result.usage,
				}
			} catch (error) {
				writeEvidence(stageDirectory, `${stem}-error`, error)
				throw error
			}
		},
		async decide(): Promise<never> {
			throw new Error('the narrative recipe does not use a decision capability')
		},
	}
}

async function runRecipeStage(
	config: CapabilityConfig,
	caseId: string,
	stage: RecipeStage,
	stageDirectory: string,
): Promise<void> {
	const input = buildRecipeInput(config, caseId, stage)
	writeJson(resolve(stageDirectory, 'raw-input.json'), input)
	const registry = new LearningRegistry()
	registerNarrativeRecipe(registry, {
		recipeId: config.ids.recipeId,
		version: config.ids.recipeVersion,
		...stage.recipeLimits,
	})
	const roots = {
		lens: { schema: learningLensValueSchema, value: input.lens },
		memory: { schema: textMemorySnapshotValueSchema, value: input.memory },
		observations: {
			schema: learningObservationsValueSchema,
			value: input.observations,
		},
		processedInputIds: {
			schema: stringArrayValueSchema,
			value: input.processedInputIds,
		},
	}
	const plan = planRecipe(registry, {
		recipe: { id: config.ids.recipeId, version: config.ids.recipeVersion },
		roots,
		memoryType: 'text',
		availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
		revisions: {
			memory: config.revisions.memory,
			configuration: config.revisions.configuration,
			registry: config.ids.registryRevision,
		},
		limits: config.planning,
	})
	const claims: BudgetClaim[] = []
	const model = createObservedModel(config, stageDirectory)
	try {
		const execution = await runRecipe(plan, {
			signal: new AbortController().signal,
			capabilities: {
				has: (id) => id === LEARNING_MODEL_CAPABILITY,
				get: <T>(id: string) =>
					id === LEARNING_MODEL_CAPABILITY
						? (learningModel(config, model, stageDirectory) as T)
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
	} catch (error) {
		writeEvidence(stageDirectory, 'raw-error', error)
	}
}

function writeSourceIdentifiers(
	config: CapabilityConfig,
	runDirectory: string,
	configPath: string,
	datasetPath: string,
): void {
	const repositoryRoot = resolve(import.meta.dirname, '../..')
	const sourceFiles = [
		'evals/scripts/model-capability-ladder-eval.ts',
		'src/learning/contracts.ts',
		'src/learning/executor.ts',
		'src/learning/planner.ts',
		'src/learning/recipes/common.ts',
		'src/learning/recipes/narrative.ts',
		'src/learning/recipes/schemas.ts',
		'src/learning/registry.ts',
	]
	writeJson(resolve(runDirectory, 'source-identifiers.json'), {
		runtime: {
			node: process.version,
			platform: process.platform,
			architecture: process.arch,
		},
		repository: {
			root: repositoryRoot,
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
		throw new Error('provide a model-capability ladder config path')
	}
	const configPath = resolve(suppliedConfigPath)
	const configRaw = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configRaw) as unknown)
	const datasetPath = resolve(config.datasetPath)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = datasetSchema.parse(JSON.parse(datasetRaw) as unknown)
	const runDirectory = resolve(config.outputRoot, runId())
	mkdirSync(runDirectory, { recursive: true })
	writeFileSync(resolve(runDirectory, 'supplied-config.raw.json'), configRaw)
	writeFileSync(resolve(runDirectory, 'supplied-dataset.raw.json'), datasetRaw)
	writeSourceIdentifiers(config, runDirectory, configPath, datasetPath)

	let stageCount = 0
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		for (const [caseIndex, suppliedCase] of dataset.cases.entries()) {
			for (const [stageIndex, stage] of suppliedCase.stages.entries()) {
				stageCount += 1
				const stageDirectory = resolve(
					runDirectory,
					`repeat-${String(repetition).padStart(2, '0')}`,
					`case-${String(caseIndex + 1).padStart(2, '0')}`,
					`stage-${String(stageIndex + 1).padStart(2, '0')}`,
				)
				mkdirSync(stageDirectory, { recursive: true })
				writeJson(resolve(stageDirectory, 'metadata.json'), {
					repetition,
					caseId: suppliedCase.id,
					caseDescription: suppliedCase.description,
					stageId: stage.id,
					stageKind: stage.kind,
					grading: null,
				})
				console.log(
					`[${stageCount}] repeat ${repetition}/${config.repetitions} ${suppliedCase.id}/${stage.id}`,
				)
				if (stage.kind === 'direct') {
					await runDirectStage(config, stage, stageDirectory)
				} else {
					await runRecipeStage(config, suppliedCase.id, stage, stageDirectory)
				}
			}
		}
	}
	writeJson(resolve(runDirectory, 'metadata.json'), {
		completedAt: new Date().toISOString(),
		stageCount,
		grading: null,
	})
	console.log(runDirectory)
}

export const modelCapabilityLadderSupport = {
	configSchema,
	datasetSchema,
	buildDirectRequest,
	buildRecipeInput,
}

const entryPoint = process.argv[1]
if (
	entryPoint !== undefined &&
	import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
	await main()
}
