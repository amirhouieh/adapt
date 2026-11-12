/**
 * Runs the fixed grounded-query corpus through the production query boundary and
 * required local model. This records raw evidence for human review and performs
 * no grading, expected-output comparison, or acceptance assertion.
 *
 * Run:
 *   npx tsx evals/scripts/grounded-query-eval.ts <config-path>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'

import {
	createModelQueryCandidateSelector,
	runGroundedQuery,
} from '../../src/brain/query/index'
import { createLocalLearningModel } from '../../src/learning/recipes/provider'
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
	type LocalRawAttempt,
} from '../../src/llm/local/index'

const modelSchema = z.object({
	plugin: z.literal('local'),
	provider: z.string().min(1),
	id: z.string().min(1),
	options: z.object({
		temperature: z.number(),
		maxOutputTokens: z.number().int().positive(),
		seed: z.number().int(),
	}),
})

const policySchema = z.object({
	instructions: z.string().min(1),
	maxCandidates: z.number().int().positive(),
	maxSelectedCandidates: z.number().int().positive(),
	maxCandidateCharacters: z.number().int().positive(),
	maxContextCharacters: z.number().int().positive(),
	maxRequestCharacters: z.number().int().positive(),
	maxAnswerCharacters: z.number().int().positive(),
}).strict()

const configSchema = z.object({
	chatCompletionsUrl: z.string().min(1),
	providerId: z.string().min(1),
	model: modelSchema,
	scheduler: z.object({
		maxConcurrent: z.number().int().positive(),
		maxQueued: z.number().int().nonnegative(),
	}).strict(),
	retry: z.object({
		maxAttempts: z.number().int().positive(),
		maxAttemptsCeiling: z.number().int().positive(),
		initialDelayMs: z.number().int().nonnegative(),
		maxDelayMs: z.number().int().nonnegative(),
		backoff: z.enum(['fixed', 'exponential']),
	}).strict(),
	requestTimeoutMs: z.number().int().positive(),
	defaultMaxOutputTokens: z.number().int().positive(),
	priority: z.enum(['query', 'foreground', 'background']),
	networkPolicy: z.object({
		allowedProbeUrl: z.string().min(1),
		deniedProbeUrl: z.string().min(1),
		probeTimeoutMs: z.number().int().positive(),
	}).strict(),
	datasetPath: z.string().min(1),
	outputRoot: z.string().min(1),
	evaluatedAt: z.string().min(1),
	policy: policySchema,
	cases: z.array(z.string().min(1)).min(1),
}).strict()

const registryEntrySchema = z.object({
	memoryId: z.string().min(1),
	lensId: z.string().min(1),
	memoryRevision: z.number().int().nonnegative(),
	configurationRevision: z.number().int().nonnegative(),
}).strict()

const memorySchema = registryEntrySchema.extend({
	registryRevision: z.string().min(1),
	purpose: z.string().min(1),
	memoryType: z.string().min(1),
	content: z.json(),
}).strict()

const snapshotSchema = z.object({
	registry: z.object({
		revision: z.string().min(1),
		entries: z.array(registryEntrySchema),
	}).strict(),
	memories: z.array(memorySchema),
	pendingLearning: z.array(z.object({
		id: z.string().min(1),
		lensId: z.string().min(1),
		memoryId: z.string().min(1),
		inputIds: z.array(z.string().min(1)),
		reason: z.string().min(1),
	}).strict()),
}).strict()

const caseSchema = z.object({
	id: z.string().min(1),
	category: z.enum(['positive', 'negative', 'ambiguous', 'long', 'adversarial']),
	question: z.string().min(1),
	userConstraints: z.string(),
	expected: z.string().min(1),
	unacceptable: z.string().min(1),
	snapshot: snapshotSchema,
}).strict()

const datasetSchema = z.object({
	provenance: z.string().min(1),
	cases: z.array(caseSchema),
}).strict()

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function exactInspect(value: unknown): string {
	return inspect(value, {
		depth: null,
		maxArrayLength: null,
		maxStringLength: null,
	})
}

async function networkProbe(url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(timeoutMs),
		})
		return { url, status: response.status, body: await response.text() }
	} catch (error) {
		return { url, error: exactInspect(error) }
	}
}

let failureDirectory: string | undefined

async function main(): Promise<void> {
	const suppliedPath = process.argv[2]
	if (suppliedPath === undefined) throw new Error('provide a grounded-query eval config path')
	const configPath = resolve(suppliedPath)
	const configRaw = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configRaw) as unknown)
	const datasetPath = resolve(config.datasetPath)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = datasetSchema.parse(JSON.parse(datasetRaw) as unknown)
	const directory = resolve(config.outputRoot, runId())
	failureDirectory = directory
	const transportDirectory = resolve(directory, 'transport')
	mkdirSync(transportDirectory, { recursive: true })
	writeFileSync(resolve(directory, 'config.input.raw.json'), configRaw)
	writeFileSync(resolve(directory, 'dataset.input.raw.json'), datasetRaw)

	writeJson(resolve(directory, 'network-probes.json'), {
		allowedLocalhost: await networkProbe(
			config.networkPolicy.allowedProbeUrl,
			config.networkPolicy.probeTimeoutMs,
		),
		deniedExternal: await networkProbe(
			config.networkPolicy.deniedProbeUrl,
			config.networkPolicy.probeTimeoutMs,
		),
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
		defaultPriority: config.priority,
		exchangeObserver(attempt: LocalRawAttempt) {
			exchangeIndex += 1
			const prefix = `${String(exchangeIndex).padStart(2, '0')}-${activeCaseId}-attempt-${attempt.attempt}`
			writeFileSync(
				resolve(transportDirectory, `${prefix}-request-body.raw.txt`),
				attempt.request.body,
			)
			if (attempt.response !== undefined) {
				writeFileSync(
					resolve(transportDirectory, `${prefix}-response-body.raw.txt`),
					attempt.response.body,
				)
			}
			if (attempt.failure !== undefined) {
				writeFileSync(
					resolve(transportDirectory, `${prefix}-failure.inspect.txt`),
					exactInspect(attempt.failure),
				)
			}
			writeJson(resolve(transportDirectory, `${prefix}-metadata.json`), {
				caseId: activeCaseId,
				attempt: attempt.attempt,
				requestUrl: attempt.request.url,
				responseStatus: attempt.response?.status,
				responseHeaders: attempt.response?.headers,
			})
		},
	})
	const model = createLocalLearningModel({
		llm,
		model: config.model,
		priority: config.priority,
	})
	const selector = createModelQueryCandidateSelector(model)
	const suppliedInputs: unknown[] = []
	const results: unknown[] = []
	for (const caseId of config.cases) {
		const suppliedCase = dataset.cases.find((candidate) => candidate.id === caseId)
		if (suppliedCase === undefined) throw new Error(`configured case ${caseId} is absent from the dataset`)
		activeCaseId = suppliedCase.id
		const input = {
			snapshot: suppliedCase.snapshot,
			question: suppliedCase.question,
			userConstraints: suppliedCase.userConstraints,
			policy: config.policy,
			model,
			selector,
			clock: { now: () => config.evaluatedAt },
			signal: new AbortController().signal,
		}
		suppliedInputs.push({
			case: suppliedCase,
			policy: config.policy,
			evaluatedAt: config.evaluatedAt,
		})
		try {
			results.push({ caseId, result: await runGroundedQuery(input) })
		} catch (error) {
			results.push({ caseId, failure: error })
		}
	}

	writeJson(resolve(directory, 'raw-input.json'), {
		provenance: dataset.provenance,
		inputs: suppliedInputs,
	})
	writeJson(resolve(directory, 'raw-output.json'), { results })
	writeFileSync(
		resolve(directory, 'raw-output.inspect.txt'),
		exactInspect({ results }),
	)
	writeJson(resolve(directory, 'metadata.json'), {
		timestamp: new Date().toISOString(),
		script: 'evals/scripts/grounded-query-eval.ts',
		configPath,
		datasetPath,
		model: config.model,
		grading: null,
	})
	console.log(directory)
}

main().catch((error: unknown) => {
	if (failureDirectory !== undefined) {
		mkdirSync(failureDirectory, { recursive: true })
		writeFileSync(
			resolve(failureDirectory, 'raw-failure.inspect.txt'),
			exactInspect(error),
		)
	}
	console.error(error)
	process.exitCode = 1
})
