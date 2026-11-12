/**
 * Runs the fixed Narrative cases through the detached v1 TextNeuron path with
 * the supplied local model settings. It records raw evidence and performs no
 * grading or semantic assertions.
 *
 * Run:
 *   npx tsx evals/scripts/learning-narrative-v1-eval.ts <config-path>
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'

const lensSchema = z.object({
	purpose: z.string().min(1),
	developerConstraints: z.string(),
	identityRules: z.string().optional(),
}).strict()
const configSchema = z.object({
	baselineRoot: z.string().min(1),
	baselineRevision: z.string().min(1),
	baseUrl: z.string().min(1),
	providerName: z.string().min(1),
	model: z.object({
		id: z.string().min(1), temperature: z.number(),
		maxOutputTokens: z.number().int().positive(), seed: z.number().int(),
	}).strict(),
	requestTimeoutMs: z.number().int().positive(),
	maxRetries: z.number().int().nonnegative(),
	datasetPath: z.string().min(1),
	outputRoot: z.string().min(1),
	networkPolicy: z.object({
		allowedProbeUrl: z.string().min(1), deniedProbeUrl: z.string().min(1),
		probeTimeoutMs: z.number().int().positive(),
	}).strict(),
	lens: lensSchema,
	limits: z.object({
		maxObservations: z.number().int().positive(),
		maxObservationCharacters: z.number().int().positive(),
		maxObservationTokens: z.number().int().positive(),
		maxMemoryCharacters: z.number().int().positive(),
		maxMemoryTokens: z.number().int().positive(),
		minImportance: z.number().min(0).max(1),
	}).strict(),
	cases: z.array(z.string().min(1)).min(1),
}).strict()
const observationSchema = z.union([
	z.string(),
	z.object({ id: z.string().min(1).optional(), text: z.string() }).strict(),
])
const caseSchema = z.object({
	id: z.string().min(1), category: z.string().min(1), recipe: z.string().min(1),
	lens: z.object({
		purpose: z.string().min(1), memoryType: z.string().min(1), schema: z.json(),
		developerConstraints: z.string(), identityRules: z.string().optional(),
	}).strict().optional(),
	currentMemory: z.string().optional(),
	observations: z.array(observationSchema),
	expected: z.string(), unacceptable: z.string(),
}).passthrough()
const datasetSchema = z.object({
	provenance: z.string().min(1), policy: z.record(z.string(), z.string()),
	cases: z.array(caseSchema),
}).strict()

interface BaselineModelRequest {
	readonly settings?: Readonly<Record<string, unknown>>
	readonly [key: string]: unknown
}

interface BaselineLlm {
	readonly id: string
	readonly model: unknown
	call(request: BaselineModelRequest): Promise<unknown>
	readonly [key: string]: unknown
}

interface BaselineNeuron {
	learn(batch: unknown[], options: { forceSynthesize: boolean }): Promise<unknown>
	setUnderstanding(value: string): Promise<void>
	getUnderstanding(): Promise<string>
	getObserveSystemPrompt(): string | null
	getUnderstandSystemPrompt(): string | null
	getUnderstandIdentity(): unknown
	dispose(): Promise<void>
}

interface BaselineModule {
	TextNeuron: {
		create(config: Readonly<Record<string, unknown>>): Promise<BaselineNeuron>
	}
	MemoryNeuronStore: new () => unknown
	createAiSdkLLM(): BaselineLlm
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function exactInspect(value: unknown): string {
	return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null })
}

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

async function networkProbe(url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
		return { url, status: response.status, body: await response.text() }
	} catch (error) {
		return { url, error: exactInspect(error) }
	}
}

function instructionsFor(lens: z.infer<typeof lensSchema>): string {
	return [
		lens.purpose,
		`Developer constraints:\n${lens.developerConstraints}`,
		...(lens.identityRules === undefined ? [] : [`Identity rules:\n${lens.identityRules}`]),
	].join('\n\n')
}

let failureDirectory: string | undefined

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2]
	if (suppliedConfigPath === undefined) throw new Error('provide a v1 Narrative comparison config path')
	const configPath = resolve(suppliedConfigPath)
	const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')) as unknown)
	const baselineRoot = resolve(config.baselineRoot)
	const baselineRevision = execFileSync('git', ['-C', baselineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
	if (baselineRevision !== config.baselineRevision) throw new Error('supplied v1 baseline revision does not match its checkout')
	const baseline = await import(pathToFileURL(resolve(baselineRoot, 'src/index.ts')).href) as BaselineModule
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
	const observedFetch: typeof fetch = async (input, init) => {
		exchangeIndex += 1
		const attempt = exchangeIndex
		const prefix = `${String(attempt).padStart(2, '0')}-${activeCaseId}`
		const request = new Request(input, init)
		writeFileSync(resolve(transportDirectory, `${prefix}-request-body.raw.txt`), await request.clone().text())
		writeJson(resolve(transportDirectory, `${prefix}-request-metadata.json`), {
			caseId: activeCaseId, requestUrl: request.url, method: request.method,
			headers: Object.fromEntries(request.headers.entries()),
		})
		try {
			const response = await fetch(request)
			writeFileSync(resolve(transportDirectory, `${prefix}-response-body.raw.txt`), await response.clone().text())
			writeJson(resolve(transportDirectory, `${prefix}-response-metadata.json`), {
				caseId: activeCaseId, status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			})
			return response
		} catch (error) {
			writeFileSync(resolve(transportDirectory, `${prefix}-failure.inspect.txt`), exactInspect(error))
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: config.providerName,
		baseURL: config.baseUrl,
		fetch: observedFetch,
		supportsStructuredOutputs: true,
	})
	const model = provider(config.model.id)
	const baseLlm = baseline.createAiSdkLLM()
	const llm: BaselineLlm = {
		...baseLlm,
		async call(request) {
			return baseLlm.call({
				...request,
				settings: {
					...(request.settings ?? {}),
					temperature: config.model.temperature,
					maxOutputTokens: config.model.maxOutputTokens,
					seed: config.model.seed,
					maxRetries: config.maxRetries,
					timeout: config.requestTimeoutMs,
				},
			})
		},
	}

	const inputs: unknown[] = []
	const executions: unknown[] = []
	for (const caseId of config.cases) {
		const suppliedCase = dataset.cases.find((candidate) => candidate.id === caseId)
		if (suppliedCase === undefined) throw new Error(`configured case ${caseId} is absent from the dataset`)
		if (suppliedCase.recipe !== 'narrative') throw new Error(`case ${caseId} is not a narrative case`)
		if (suppliedCase.currentMemory === undefined) throw new Error(`case ${caseId} requires currentMemory`)
		activeCaseId = suppliedCase.id
		const suppliedLens = suppliedCase.lens ?? config.lens
		const lens = {
			purpose: suppliedLens.purpose,
			developerConstraints: suppliedLens.developerConstraints,
			...(suppliedLens.identityRules === undefined ? {} : { identityRules: suppliedLens.identityRules }),
		}
		const observations = suppliedCase.observations.map((value) => typeof value === 'string' ? value : value.text)
		const neuronInput = {
			id: `v1-${suppliedCase.id}`,
			name: suppliedCase.id,
			instructions: instructionsFor(lens),
			model,
			llm,
			store: new baseline.MemoryNeuronStore(),
			governance: { strategy: 'continuous', maxTokens: config.limits.maxMemoryTokens },
			understand: { thresholds: {
				maxObservations: config.limits.maxObservations,
				maxTokens: config.limits.maxObservationTokens,
				minImportance: config.limits.minImportance,
			} },
		}
		inputs.push({ case: suppliedCase, lens, observations, neuronInput: {
			...neuronInput, model: { provider: config.providerName, id: config.model.id },
			llm: { id: llm.id }, store: { type: 'MemoryNeuronStore' },
		} })
		writeJson(resolve(directory, 'raw-input.partial.json'), {
			config, baselineRevision,
			dataset: { provenance: dataset.provenance, policy: dataset.policy },
			cases: inputs,
		})
		let neuron: BaselineNeuron | undefined
		try {
			neuron = await baseline.TextNeuron.create(neuronInput)
			await neuron.setUnderstanding(suppliedCase.currentMemory)
			const prompts = {
				observe: neuron.getObserveSystemPrompt(), understand: neuron.getUnderstandSystemPrompt(),
				identity: neuron.getUnderstandIdentity(),
			}
			const result = await neuron.learn(observations, { forceSynthesize: true })
			executions.push({
				caseId: suppliedCase.id, prompts, result,
				understanding: await neuron.getUnderstanding(),
			})
		} catch (error) {
			executions.push({ caseId: suppliedCase.id, error })
		} finally {
			await neuron?.dispose()
		}
		writeJson(resolve(directory, 'raw-output.partial.json'), { executions })
		writeFileSync(
			resolve(directory, 'raw-output.partial.inspect.txt'),
			exactInspect({ executions }),
		)
	}

	writeJson(resolve(directory, 'raw-input.json'), {
		config, baselineRevision, dataset: { provenance: dataset.provenance, policy: dataset.policy }, cases: inputs,
	})
	writeJson(resolve(directory, 'raw-output.json'), { executions })
	writeFileSync(resolve(directory, 'raw-output.inspect.txt'), exactInspect({ executions }))
	writeJson(resolve(directory, 'metadata.json'), {
		timestamp: new Date().toISOString(), script: 'evals/scripts/learning-narrative-v1-eval.ts',
		configPath, datasetPath, baselineRoot, baselineRevision,
		model: config.model,
		settingsPolicy: 'supplied settings override v1 per-call settings through the injected provider boundary',
		limitsComparison: {
			appliedByV1: ['maxObservations', 'maxObservationTokens', 'minImportance', 'maxMemoryTokens'],
			recordedButNotAppliedByV1: ['maxObservationCharacters', 'maxMemoryCharacters'],
			schemaPolicy: 'the original v1 TextNeuron generates and uses its standard text observation and understand schemas',
		},
		grading: null,
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
