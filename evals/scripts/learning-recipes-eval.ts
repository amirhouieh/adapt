/**
 * Runs supplied learning recipe cases through the production registry, planner,
 * executor, and local model adapter. It records evidence for human review and
 * performs no grading or acceptance checks.
 *
 * Run:
 *   npx tsx evals/scripts/learning-recipes-eval.ts <config-path>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'

import {
	LearningRegistry,
	createLocalLearningModel,
	learningLensValueSchema,
	learningObservationsValueSchema,
	planRecipe,
	registerNarrativeRecipe,
	runRecipe,
	stringArrayValueSchema,
	textMemorySnapshotValueSchema,
	LEARNING_MODEL_CAPABILITY,
	type BudgetClaim,
	type LearningObservation,
	type TextMemorySnapshot,
} from '../../src/learning/index'
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
	type LocalRawAttempt,
} from '../../src/llm/local/index'

const lensSchema = z.object({
	purpose: z.string().min(1), memoryType: z.string().min(1), schema: z.json(),
	developerConstraints: z.string(), identityRules: z.string().optional(),
}).strict()

const configSchema = z.object({
	chatCompletionsUrl: z.string().min(1),
	providerId: z.string().min(1),
	model: z.object({
		plugin: z.literal('local'), provider: z.string().min(1), id: z.string().min(1),
		options: z.object({ temperature: z.number(), maxOutputTokens: z.number().int().positive(), seed: z.number().int() }),
	}),
	scheduler: z.object({ maxConcurrent: z.number().int().positive(), maxQueued: z.number().int().nonnegative() }),
	retry: z.object({
		maxAttempts: z.number().int().positive(), maxAttemptsCeiling: z.number().int().positive(),
		initialDelayMs: z.number().nonnegative(), maxDelayMs: z.number().nonnegative(),
		backoff: z.enum(['fixed', 'exponential']),
	}),
	requestTimeoutMs: z.number().int().positive(),
	defaultMaxOutputTokens: z.number().int().positive(),
	defaultPriority: z.enum(['query', 'foreground', 'background']),
	networkPolicy: z.object({
		sandboxPolicyFile: z.string().min(1), allowedProbeUrl: z.string().min(1),
		deniedProbeUrl: z.string().min(1), probeTimeoutMs: z.number().int().positive(),
	}),
	datasetPath: z.string().min(1), outputRoot: z.string().min(1),
	lens: lensSchema,
	roots: z.object({ memoryId: z.string().min(1), observedAt: z.string().min(1) }),
	revisions: z.object({ memory: z.number().int().nonnegative(), configuration: z.number().int().nonnegative(), registry: z.string().min(1) }),
	recipes: z.object({
		narrative: z.object({ id: z.string().min(1), version: z.string().min(1) }),
		structured: z.object({ id: z.string().min(1), version: z.string().min(1) }),
		pattern: z.object({ id: z.string().min(1), version: z.string().min(1) }),
	}),
	recipe: z.object({
		maxObservations: z.number().int().positive(), maxObservationCharacters: z.number().int().positive(),
		maxMemoryCharacters: z.number().int().positive(), maxContextCharacters: z.number().int().positive(),
		maxListCandidates: z.number().int().positive(),
		minimumIndependentSupport: z.number().int().positive(),
	}),
	planning: z.object({ maxNodes: z.number().int().positive(), maxCollectionItems: z.number().int().positive(), maxOperations: z.number().int().positive() }),
	execution: z.object({ maxClaims: z.number().int().positive() }),
	cases: z.array(z.string().min(1)).min(1),
}).strict()

const observationInputSchema = z.union([
	z.string(),
	z.object({ id: z.string().min(1).optional(), text: z.string() }).strict(),
])
const caseSchema = z.object({
	id: z.string().min(1), category: z.string().min(1), recipe: z.string().min(1),
	lens: lensSchema.optional(),
	currentMemory: z.string().optional(), processedInputIds: z.array(z.string()).optional(),
	observations: z.array(observationInputSchema), expected: z.string(), unacceptable: z.string(),
}).passthrough()
const datasetSchema = z.object({
	provenance: z.string().min(1), policy: z.record(z.string(), z.string()),
	cases: z.array(caseSchema),
}).strict()

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

function exactInspect(value: unknown): string {
	return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null })
}

async function networkProbe(url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
		return { url, status: response.status, body: await response.text() }
	} catch (error) {
		return { url, error: exactInspect(error) }
	}
}

function observationsFor(
	caseId: string,
	values: readonly z.infer<typeof observationInputSchema>[],
	observedAt: string,
): LearningObservation[] {
	return values.map((value, index) => {
		const ordinal = index + 1
		const text = typeof value === 'string' ? value : value.text
		return {
			id: typeof value === 'string' ? `${caseId}-input-${ordinal}` : (value.id ?? `${caseId}-input-${ordinal}`),
			text,
			observedAt,
		}
	})
}

let failureDirectory: string | undefined

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2]
	if (suppliedConfigPath === undefined) throw new Error('provide a learning recipe eval config path')
	const configPath = resolve(suppliedConfigPath)
	const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')) as unknown)
	const datasetPath = resolve(config.datasetPath)
	const dataset = datasetSchema.parse(JSON.parse(readFileSync(datasetPath, 'utf8')) as unknown)
	const directory = resolve(config.outputRoot, runId())
	failureDirectory = directory
	const transportDirectory = resolve(directory, 'transport')
	mkdirSync(transportDirectory, { recursive: true })

	writeJson(resolve(directory, 'network-probes.json'), {
		allowedLocalhost: await networkProbe(config.networkPolicy.allowedProbeUrl, config.networkPolicy.probeTimeoutMs),
		deniedExternal: await networkProbe(config.networkPolicy.deniedProbeUrl, config.networkPolicy.probeTimeoutMs),
	})

	let exchangeIndex = 0
	let activeCaseId = 'none'
	const scheduler = createBoundedDeviceScheduler(config.scheduler)
	const llm = createLocalLLM({
		chatCompletionsUrl: config.chatCompletionsUrl,
		providerId: config.providerId,
		scheduler,
		retry: config.retry,
		requestTimeoutMs: config.requestTimeoutMs,
		defaultMaxOutputTokens: config.defaultMaxOutputTokens,
		defaultPriority: config.defaultPriority,
		exchangeObserver(attempt: LocalRawAttempt) {
			exchangeIndex += 1
			const prefix = `${String(exchangeIndex).padStart(2, '0')}-${activeCaseId}-attempt-${attempt.attempt}`
			writeFileSync(resolve(transportDirectory, `${prefix}-request-body.raw.txt`), attempt.request.body)
			if (attempt.response !== undefined) {
				writeFileSync(resolve(transportDirectory, `${prefix}-response-body.raw.txt`), attempt.response.body)
			}
			if (attempt.failure !== undefined) {
				writeFileSync(resolve(transportDirectory, `${prefix}-failure.inspect.txt`), exactInspect(attempt.failure))
			}
			writeJson(resolve(transportDirectory, `${prefix}-metadata.json`), {
				caseId: activeCaseId, attempt: attempt.attempt, requestUrl: attempt.request.url,
				responseStatus: attempt.response?.status, responseHeaders: attempt.response?.headers,
			})
		},
	})
	const model = createLocalLearningModel({ llm, model: config.model, priority: config.defaultPriority })
	const registry = new LearningRegistry()
	registerNarrativeRecipe(registry, {
		recipeId: config.recipes.narrative.id,
		version: config.recipes.narrative.version,
		maxObservations: config.recipe.maxObservations,
		maxObservationCharacters: config.recipe.maxObservationCharacters,
		maxMemoryCharacters: config.recipe.maxMemoryCharacters,
		maxContextCharacters: config.recipe.maxContextCharacters,
	})
	const capabilities = new Map<string, unknown>([[LEARNING_MODEL_CAPABILITY, model]])
	const executions: unknown[] = []
	const inputs: unknown[] = []
	for (const caseId of config.cases) {
		const suppliedCase = dataset.cases.find((candidate) => candidate.id === caseId)
		if (suppliedCase === undefined) throw new Error(`configured case ${caseId} is absent from the dataset`)
		if (suppliedCase.recipe !== 'narrative') throw new Error(`case ${caseId} is not a narrative case`)
		if (suppliedCase.currentMemory === undefined) throw new Error(`case ${caseId} requires currentMemory`)
		activeCaseId = suppliedCase.id
		const lens = suppliedCase.lens ?? config.lens
		const observations = observationsFor(suppliedCase.id, suppliedCase.observations, config.roots.observedAt)
		const processedInputIds = suppliedCase.processedInputIds ?? []
		const memory: TextMemorySnapshot = {
			id: config.roots.memoryId, revision: config.revisions.memory,
			text: suppliedCase.currentMemory, processedInputIds,
		}
		const roots = {
			lens: { schema: learningLensValueSchema, value: lens },
			memory: { schema: textMemorySnapshotValueSchema, value: memory },
			observations: { schema: learningObservationsValueSchema, value: observations },
			processedInputIds: { schema: stringArrayValueSchema, value: processedInputIds },
		}
		const planningInput = {
			recipe: config.recipes.narrative, roots, memoryType: 'text' as const,
			availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
			revisions: config.revisions, limits: config.planning,
		}
		inputs.push({ case: suppliedCase, lens, memory, observations, planningInput: {
			...planningInput, roots: { lens, memory, observations, processedInputIds },
			availableCapabilities: [...planningInput.availableCapabilities],
		} })
		writeJson(resolve(directory, 'raw-input.partial.json'), {
			config, dataset: { provenance: dataset.provenance, policy: dataset.policy }, cases: inputs,
		})
		const plan = planRecipe(registry, planningInput)
		const claims: BudgetClaim[] = []
		const execution = await runRecipe(plan, {
			signal: new AbortController().signal,
			capabilities: { has: (id) => capabilities.has(id), get: <T>(id: string) => capabilities.get(id) as T | undefined },
			budget: {
				claim(claim) {
					if (claims.length >= config.execution.maxClaims) return false
					claims.push(claim)
					return true
				},
				snapshot: () => ({ claims: [...claims] }),
			},
		})
		executions.push({ caseId: suppliedCase.id, execution })
		writeJson(resolve(directory, 'raw-output.partial.json'), { executions })
		writeFileSync(resolve(directory, 'raw-output.partial.inspect.txt'), exactInspect({ executions }))
	}

	writeJson(resolve(directory, 'raw-input.json'), { config, dataset: { provenance: dataset.provenance, policy: dataset.policy }, cases: inputs })
	writeJson(resolve(directory, 'raw-output.json'), { executions })
	writeFileSync(resolve(directory, 'raw-output.inspect.txt'), exactInspect({ executions }))
	writeJson(resolve(directory, 'metadata.json'), {
		timestamp: new Date().toISOString(), script: 'evals/scripts/learning-recipes-eval.ts',
		configPath, datasetPath, model: config.model, grading: null,
	})
	console.log(directory)
}

main().catch((error: unknown) => {
	if (failureDirectory !== undefined) {
		mkdirSync(failureDirectory, { recursive: true })
		writeFileSync(resolve(failureDirectory, 'raw-failure.inspect.txt'), exactInspect(error))
	}
	console.error(error)
	process.exitCode = 1
})
