/**
 * Real-model eval for the registered Graph relationship-learning recipe.
 *
 * Objectives: exercise initial shared-target learning, one relationship
 * correction, ambiguous identity abstention, bounded querying, and missing
 * evidence through the production local adapter. The dataset is synthetic and
 * contains no claims about a real person or project. Expected and unacceptable
 * outcomes are fixed in that dataset before execution. This script records
 * evidence without grading or asserting semantic success.
 *
 * Run: tsx evals/scripts/graph-learning-eval.ts <config-path>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'
import {
	LEARNING_ID_CAPABILITY,
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	createLocalLearningModel,
	planRecipe,
	runRecipe,
	type BudgetClaim,
	type LearningObservation,
} from '../../src/learning'
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
	type LocalRawAttempt,
} from '../../src/llm/local'
import {
	GRAPH_RELATIONSHIP_RECIPE,
	answerGraphRelationship,
	applyGraphPatch,
	graphRoot,
	registerGraphLearning,
	type GraphLearningInput,
	type GraphPatch,
	type GraphSnapshot,
} from '../../src/neurons/graph'

const observationSchema = z.object({
	id: z.string(), text: z.string(),
	observedAt: z.string(), eventAt: z.string().optional(),
})
const datasetSchema = z.object({
	metadata: z.object({ name: z.string(), source: z.string() }),
	observations: z.array(observationSchema),
	expectedOutcomes: z.record(z.string(), z.string()),
	unacceptableOutcomes: z.record(z.string(), z.string()),
})
const configSchema = z.object({
	chatCompletionsUrl: z.string(), providerId: z.string(),
	model: z.object({
		plugin: z.literal('local'), provider: z.string(), id: z.string(),
		options: z.object({ temperature: z.number(), maxOutputTokens: z.number().int().positive(), seed: z.number().int() }),
	}),
	scheduler: z.object({ maxConcurrent: z.number().int().positive(), maxQueued: z.number().int().nonnegative() }),
	retry: z.object({
		maxAttempts: z.number().int().positive(), maxAttemptsCeiling: z.number().int().positive(),
		initialDelayMs: z.number().nonnegative(), maxDelayMs: z.number().nonnegative(),
		backoff: z.enum(['fixed', 'exponential']),
	}),
	requestTimeoutMs: z.number().int().positive(), defaultMaxOutputTokens: z.number().int().positive(),
	defaultPriority: z.enum(['query', 'foreground', 'background']),
	budgetMaxClaims: z.number().int().positive(),
	datasetPath: z.string(), outputRoot: z.string(),
	networkPolicy: z.object({ sandboxPolicy: z.string(), allowedProbeUrl: z.string(), deniedProbeUrl: z.string(), probeTimeoutMs: z.number().int().positive() }),
	revisions: z.object({ memory: z.number().int().nonnegative(), configuration: z.number().int().nonnegative(), registry: z.string() }),
	planningLimits: z.object({ maxNodes: z.number().int().positive(), maxCollectionItems: z.number().int().positive(), maxOperations: z.number().int().positive() }),
	policy: z.object({
		maxObservations: z.number().int().positive(), maxObservationChars: z.number().int().positive(),
		maxExtractedRelations: z.number().int().positive(), maxIdentityCandidates: z.number().int().positive(),
		maxContextEntities: z.number().int().positive(), maxContextEdges: z.number().int().positive(),
		maxContextCharacters: z.number().int().positive(),
	}),
	traversalPolicy: z.object({ maxDepth: z.number().int().positive(), maxEntities: z.number().int().positive(), maxEdges: z.number().int().positive() }),
	lens: z.object({ memoryType: z.string().min(1), purpose: z.string().min(1), developerConstraints: z.string(), identityRules: z.string().optional() }),
	graphSchema: z.object({
		lensId: z.string().min(1), entityTypes: z.array(z.string().min(1)).min(1),
		relations: z.array(z.object({
			id: z.string().min(1), description: z.string().min(1), extractionInstructions: z.string().min(1),
			sourceEntityTypes: z.array(z.string().min(1)).min(1), targetEntityTypes: z.array(z.string().min(1)).min(1),
			directed: z.boolean(), allowSelf: z.boolean(),
		})).min(1),
		identity: z.object({ exactNormalizedLabel: z.enum(['same', 'decision']), allowModelDeclaredNew: z.boolean() }),
	}),
	stages: z.array(z.object({ id: z.string().min(1), observationIds: z.array(z.string().min(1)).min(1) })).min(1),
	queries: z.object({
		boundedStartEntityLabel: z.string().min(1), noOutgoingStartEntityLabel: z.string().min(1),
		relationIds: z.array(z.string().min(1)), direction: z.enum(['outgoing', 'incoming', 'both']),
	}),
})

const inspectOptions = { depth: null, maxArrayLength: null, maxStringLength: null } as const
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const runId = () => new Date().toISOString().split(':').join('-')

async function probe(url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
		return { url, status: response.status, body: await response.text() }
	} catch (error) {
		return { url, error: inspect(error, inspectOptions) }
	}
}

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2] ?? process.env.ADAPT_GRAPH_EVAL_CONFIG
	if (!suppliedConfigPath) throw new Error('Pass config path as argv[2] or ADAPT_GRAPH_EVAL_CONFIG')
	const configPath = resolve(suppliedConfigPath)
	const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')))
	const dataset = datasetSchema.parse(JSON.parse(readFileSync(resolve(config.datasetPath), 'utf8')))
	const directory = resolve(config.outputRoot, runId())
	const transportDirectory = resolve(directory, 'transport')
	mkdirSync(transportDirectory, { recursive: true })
	let exchangeIndex = 0
	const startedAt = new Date().toISOString()
	const scheduler = createBoundedDeviceScheduler(config.scheduler)
	const llm = createLocalLLM({
		chatCompletionsUrl: config.chatCompletionsUrl, providerId: config.providerId,
		scheduler, retry: config.retry, requestTimeoutMs: config.requestTimeoutMs,
		defaultMaxOutputTokens: config.defaultMaxOutputTokens, defaultPriority: config.defaultPriority,
		exchangeObserver(attempt: LocalRawAttempt) {
			exchangeIndex += 1
			const prefix = `${String(exchangeIndex).padStart(2, '0')}-attempt-${attempt.attempt}`
			writeFileSync(resolve(transportDirectory, `${prefix}-request-body.raw.txt`), attempt.request.body)
			if (attempt.response) writeFileSync(resolve(transportDirectory, `${prefix}-response-body.raw.txt`), attempt.response.body)
			if (attempt.failure !== undefined) writeFileSync(resolve(transportDirectory, `${prefix}-failure.raw.txt`), inspect(attempt.failure, inspectOptions))
			writeJson(resolve(transportDirectory, `${prefix}-metadata.json`), {
				attempt: attempt.attempt, requestUrl: attempt.request.url,
				responseStatus: attempt.response?.status, responseHeaders: attempt.response?.headers,
			})
		},
	})
	const registry = new LearningRegistry()
	registerGraphLearning(registry)
	let idCounter = 0
	const capabilities = new Map<string, unknown>([
		[LEARNING_MODEL_CAPABILITY, createLocalLearningModel({ llm, model: config.model, priority: config.defaultPriority })],
		[LEARNING_ID_CAPABILITY, { next: (kind: string) => `${kind}-${++idCounter}` }],
	])
	const resolver = { has: (id: string) => capabilities.has(id), get: <T>(id: string) => capabilities.get(id) as T | undefined }
	const claims: BudgetClaim[] = []
	const budget = { claim: (claim: BudgetClaim) => { claims.push(claim); return claims.length <= config.budgetMaxClaims }, snapshot: () => ({ claims: [...claims] }) }
	let snapshot: GraphSnapshot = { lensId: config.graphSchema.lensId, revision: 0, entities: [], edges: [], edgeHistory: [], processedInputIds: [] }
	const byId = new Map(dataset.observations.map((observation) => [observation.id, observation as LearningObservation]))
	const executionResults: Record<string, unknown> = {}
	const failures: unknown[] = []
	async function execute(name: string, observationIds: string[]): Promise<void> {
		const observations = observationIds.map((id) => {
			const value = byId.get(id)
			if (!value) throw new Error(`missing configured observation ${id}`)
			return value
		})
		const input: GraphLearningInput = {
			lens: { ...config.lens, schema: config.graphSchema }, schema: config.graphSchema, snapshot,
			observations, configurationRevision: config.revisions.configuration, policy: config.policy,
			contextMode: 'complete_snapshot',
		}
		writeJson(resolve(directory, `${name}-input.json`), input)
		writeFileSync(resolve(directory, `${name}-input.raw.txt`), inspect(input, inspectOptions))
		try {
			const plan = planRecipe(registry, {
				recipe: GRAPH_RELATIONSHIP_RECIPE, roots: { input: graphRoot(input) }, memoryType: 'graph',
				availableCapabilities: new Set(capabilities.keys()),
				revisions: { ...config.revisions, memory: snapshot.revision }, limits: config.planningLimits,
			})
			const execution = await runRecipe(plan, { capabilities: resolver, budget, signal: new AbortController().signal })
			executionResults[name] = execution
			writeFileSync(resolve(directory, `${name}-output.raw.txt`), inspect(execution, inspectOptions))
			if (execution.result.outcome === 'failure') {
				failures.push(new Error(`${name}: ${execution.result.reason}`))
			}
			if (execution.result.outcome === 'change') snapshot = applyGraphPatch(snapshot, execution.result.patch as GraphPatch, input.schema)
		} catch (error) {
			failures.push(error)
			writeFileSync(resolve(directory, `${name}-error.raw.txt`), inspect(error, inspectOptions))
		}
	}
	writeJson(resolve(directory, 'eval-definition.json'), {
		provenance: dataset.metadata, expectedOutcomes: dataset.expectedOutcomes,
		unacceptableOutcomes: dataset.unacceptableOutcomes, observations: dataset.observations,
	})
	writeJson(resolve(directory, 'network-probes.json'), {
		allowedLocalhost: await probe(config.networkPolicy.allowedProbeUrl, config.networkPolicy.probeTimeoutMs),
		deniedExternal: await probe(config.networkPolicy.deniedProbeUrl, config.networkPolicy.probeTimeoutMs),
	})
	for (const stage of config.stages) await execute(stage.id, stage.observationIds)
	const projectB = snapshot.entities.find(({ label }) => label === config.queries.boundedStartEntityLabel)
	const teamY = snapshot.entities.find(({ label }) => label === config.queries.noOutgoingStartEntityLabel)
	const queries = {
		bounded: projectB ? answerGraphRelationship(snapshot, config.graphSchema, { startEntityIds: [projectB.id], relationIds: config.queries.relationIds, direction: config.queries.direction, policy: config.traversalPolicy }) : { status: 'missing_start_entity' },
		noOutgoingRelationship: teamY ? answerGraphRelationship(snapshot, config.graphSchema, { startEntityIds: [teamY.id], relationIds: config.queries.relationIds, direction: config.queries.direction, policy: config.traversalPolicy }) : { status: 'missing_start_entity' },
	}
	writeJson(resolve(directory, 'result.json'), { executions: executionResults, snapshot, queries })
	writeFileSync(resolve(directory, 'result.raw.txt'), inspect({ executions: executionResults, snapshot, queries }, inspectOptions))
	writeJson(resolve(directory, 'metadata.json'), {
		startedAt, completedAt: new Date().toISOString(), configPath, config,
		runtime: { node: process.version, platform: platform(), architecture: arch(), osRelease: release(), offlineSandbox: process.env.ADAPT_EVAL_OFFLINE_SANDBOX === '1' },
		exchangeCount: exchangeIndex, failureCount: failures.length,
	})
	console.log(directory)
	if (failures.length > 0) throw new AggregateError(failures, 'One or more graph eval stages failed')
}

await main()
