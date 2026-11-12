/**
 * Dedicated real-model eval for bounded Attention routing and discovery.
 *
 * Objectives: exercise positive, negative, ambiguous, partial, large-registry,
 * adversarial-content, and paused-lens routing through the production local
 * adapter. The supplied corpus is synthetic. Expected and unacceptable
 * outcomes are fixed in the dataset before execution and are recorded without
 * assertions, comparisons, scores, or grading.
 *
 * Run: tsx evals/scripts/attention-routing-eval.ts <config-path>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'
import {
	createBoundedCandidateSelector,
	createLiteralMetadataCandidateSelector,
	retainDiscoveryBuffer,
	routeAttention,
	type AttentionCandidateSelector,
	type AttentionLens,
	type AttentionRoutingInput,
	type AttentionRoutingResult,
} from '../../src/brain/attention'
import { createLocalLearningModel } from '../../src/learning'
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
	type LocalRawAttempt,
} from '../../src/llm/local'

const portionSchema = z.object({
	id: z.string().min(1), inputId: z.string().min(1),
	sourceId: z.string().min(1), text: z.string(), observedAt: z.string().min(1),
	eventAt: z.string().optional(),
})
const lensSchema = z.object({
	id: z.string().min(1), revision: z.number().int().nonnegative(),
	description: z.string(), routingInstructions: z.string(),
	metadata: z.object({ routingTerms: z.array(z.string()) }).passthrough(),
	learningStatus: z.enum(['active', 'paused']),
})
const ruleSchema = z.object({
	id: z.string().min(1), priority: z.number().int(),
	match: z.object({
		portionIds: z.array(z.string().min(1)).optional(),
		sourceIds: z.array(z.string().min(1)).optional(),
	}),
	includeLensIds: z.array(z.string().min(1)),
	excludeLensIds: z.array(z.string().min(1)),
	coverage: z.enum(['complete', 'partial']),
})
const policySchema = z.object({
	maxPortions: z.number().int().positive(),
	maxPortionCharacters: z.number().int().positive(),
	maxRequestContextCharacters: z.number().int().positive(),
	maxCandidateLenses: z.number().int().positive(),
	maxDestinationsPerPortion: z.number().int().positive(),
	maxProviderCalls: z.number().int().positive(),
	maxUncoveredSpans: z.number().int().positive(),
	maxDiscoveryActions: z.number().int().positive(),
	maxRecheckActions: z.number().int().positive(),
})
const datasetSchema = z.object({
	metadata: z.object({ name: z.string(), source: z.string() }).passthrough(),
	lenses: z.array(lensSchema),
	scenarios: z.array(z.object({
		id: z.string().min(1), portion: portionSchema,
		lensIds: z.array(z.string().min(1)),
		selector: z.enum(['bounded', 'literal_metadata']),
		maxCandidateLenses: z.number().int().positive().optional(),
		rules: z.array(ruleSchema).optional(),
		expectedOutcome: z.string(), unacceptableOutcome: z.string(),
	})),
})
const configSchema = z.object({
	chatCompletionsUrl: z.string().min(1), providerId: z.string().min(1),
	model: z.object({
		plugin: z.literal('local'), provider: z.string().min(1), id: z.string().min(1),
		options: z.object({
			temperature: z.number(), maxOutputTokens: z.number().int().positive(),
			seed: z.number().int(),
		}),
	}),
	scheduler: z.object({
		maxConcurrent: z.number().int().positive(), maxQueued: z.number().int().nonnegative(),
	}),
	retry: z.object({
		maxAttempts: z.number().int().positive(), maxAttemptsCeiling: z.number().int().positive(),
		initialDelayMs: z.number().nonnegative(), maxDelayMs: z.number().nonnegative(),
		backoff: z.enum(['fixed', 'exponential']),
	}),
	requestTimeoutMs: z.number().int().positive(),
	defaultMaxOutputTokens: z.number().int().positive(),
	defaultPriority: z.enum(['query', 'foreground', 'background']),
	datasetPath: z.string().min(1), outputRoot: z.string().min(1),
	networkPolicy: z.object({
		sandboxPolicy: z.string().min(1), allowedProbeUrl: z.string().min(1),
		deniedProbeUrl: z.string().min(1), probeTimeoutMs: z.number().int().positive(),
	}),
	policy: policySchema,
	discoveryBuffer: z.object({
		now: z.string().min(1),
		policy: z.object({
			maxItems: z.number().int().positive(),
			maxCharacters: z.number().int().positive(),
			maxAgeMs: z.number().int().positive(),
			overflowPolicy: z.enum(['evict_oldest', 'reject_new']),
		}),
	}),
})

const inspectOptions = {
	depth: null,
	maxArrayLength: null,
	maxStringLength: null,
} as const

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

function safeSegment(value: string): string {
	const allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
	if ([...value].some((character) => !allowed.includes(character))) {
		throw new Error('scenario id contains a character unsafe for an artifact path')
	}
	return value
}

async function probe(url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await fetch(url, {
			redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
		})
		return { url, status: response.status, body: await response.text() }
	} catch (error) {
		return { url, error: inspect(error, inspectOptions) }
	}
}

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2] ?? process.env.ADAPT_ATTENTION_EVAL_CONFIG
	if (!suppliedConfigPath) {
		throw new Error('Pass config path as argv[2] or ADAPT_ATTENTION_EVAL_CONFIG')
	}
	const configPath = resolve(suppliedConfigPath)
	const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')))
	const datasetPath = resolve(config.datasetPath)
	const dataset = datasetSchema.parse(JSON.parse(readFileSync(datasetPath, 'utf8')))
	const directory = resolve(config.outputRoot, runId())
	const transportDirectory = resolve(directory, 'transport')
	mkdirSync(transportDirectory, { recursive: true })
	const startedAt = new Date().toISOString()
	let exchangeIndex = 0
	let currentScenarioId = 'setup'
	const failures: unknown[] = []
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
			const prefix = `${String(exchangeIndex).padStart(2, '0')}-${safeSegment(currentScenarioId)}-attempt-${attempt.attempt}`
			writeFileSync(
				resolve(transportDirectory, `${prefix}-request-body.raw.txt`),
				attempt.request.body,
			)
			if (attempt.response) {
				writeFileSync(
					resolve(transportDirectory, `${prefix}-response-body.raw.txt`),
					attempt.response.body,
				)
			}
			if (attempt.failure !== undefined) {
				writeFileSync(
					resolve(transportDirectory, `${prefix}-failure.raw.txt`),
					inspect(attempt.failure, inspectOptions),
				)
			}
			writeJson(resolve(transportDirectory, `${prefix}-metadata.json`), {
				attempt: attempt.attempt,
				requestUrl: attempt.request.url,
				responseStatus: attempt.response?.status,
				responseHeaders: attempt.response?.headers,
			})
		},
	})
	const model = createLocalLearningModel({
		llm, model: config.model, priority: config.defaultPriority,
	})
	const lensById = new Map(dataset.lenses.map((lens) => [lens.id, lens]))
	const results: Record<string, unknown> = {}
	const routingResults: AttentionRoutingResult[] = []

	writeJson(resolve(directory, 'eval-definition.json'), {
		provenance: dataset.metadata,
		scenarios: dataset.scenarios,
		lenses: dataset.lenses,
	})
	writeFileSync(
		resolve(directory, 'eval-definition.raw.txt'),
		inspect({ provenance: dataset.metadata, scenarios: dataset.scenarios, lenses: dataset.lenses }, inspectOptions),
	)
	writeJson(resolve(directory, 'network-probes.json'), {
		allowedLocalhost: await probe(
			config.networkPolicy.allowedProbeUrl,
			config.networkPolicy.probeTimeoutMs,
		),
		deniedExternal: await probe(
			config.networkPolicy.deniedProbeUrl,
			config.networkPolicy.probeTimeoutMs,
		),
	})

	for (const scenario of dataset.scenarios) {
		currentScenarioId = safeSegment(scenario.id)
		const lenses = scenario.lensIds.map((id) => {
			const found = lensById.get(id)
			if (!found) throw new Error(`scenario references missing lens ${id}`)
			return found as AttentionLens
		})
		const input: AttentionRoutingInput = {
			portions: [scenario.portion], lenses,
			rules: scenario.rules ?? [],
			policy: {
				...config.policy,
				...(scenario.maxCandidateLenses === undefined
					? {}
					: { maxCandidateLenses: scenario.maxCandidateLenses }),
			},
		}
		const selector: AttentionCandidateSelector =
			scenario.selector === 'literal_metadata'
				? createLiteralMetadataCandidateSelector((value) => {
					const parsed = lensSchema.shape.metadata.parse(value)
					return { routingTerms: parsed.routingTerms }
				})
				: createBoundedCandidateSelector()
		writeJson(resolve(directory, `${currentScenarioId}-input.json`), input)
		writeFileSync(
			resolve(directory, `${currentScenarioId}-input.raw.txt`),
			inspect(input, inspectOptions),
		)
		try {
			const result = await routeAttention(input, {
				model, candidateSelector: selector, signal: new AbortController().signal,
			})
			results[scenario.id] = result
			routingResults.push(result)
			writeJson(resolve(directory, `${currentScenarioId}-output.json`), result)
			writeFileSync(
				resolve(directory, `${currentScenarioId}-output.raw.txt`),
				inspect(result, inspectOptions),
			)
		} catch (error) {
			failures.push(error)
			writeFileSync(
				resolve(directory, `${currentScenarioId}-error.raw.txt`),
				inspect(error, inspectOptions),
			)
		}
	}
	const discoveryBufferInput = {
		existing: [],
		additions: routingResults.flatMap(({ actions }) => actions),
		policy: config.discoveryBuffer.policy,
		now: config.discoveryBuffer.now,
	}
	writeJson(resolve(directory, 'discovery-buffer-input.json'), discoveryBufferInput)
	writeFileSync(
		resolve(directory, 'discovery-buffer-input.raw.txt'),
		inspect(discoveryBufferInput, inspectOptions),
	)
	const discoveryBufferOutput = retainDiscoveryBuffer(
		discoveryBufferInput.existing,
		discoveryBufferInput.additions,
		discoveryBufferInput.policy,
		discoveryBufferInput.now,
	)
	writeJson(resolve(directory, 'discovery-buffer-output.json'), discoveryBufferOutput)
	writeFileSync(
		resolve(directory, 'discovery-buffer-output.raw.txt'),
		inspect(discoveryBufferOutput, inspectOptions),
	)

	writeJson(resolve(directory, 'result.json'), results)
	writeFileSync(resolve(directory, 'result.raw.txt'), inspect(results, inspectOptions))
	writeJson(resolve(directory, 'metadata.json'), {
		startedAt,
		completedAt: new Date().toISOString(),
		configPath,
		datasetPath,
		config,
		runtime: {
			node: process.version,
			platform: platform(),
			architecture: arch(),
			osRelease: release(),
			offlineSandbox: process.env.ADAPT_EVAL_OFFLINE_SANDBOX === '1',
		},
		exchangeCount: exchangeIndex,
		failureCount: failures.length,
	})
	console.log(directory)
	if (failures.length > 0) {
		throw new AggregateError(failures, 'One or more attention eval scenarios failed')
	}
}

await main()
