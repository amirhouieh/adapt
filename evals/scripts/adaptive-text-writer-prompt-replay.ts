/**
 * Causal replay of saved adaptive-text writer prompts.
 *
 * Reads exact saved AI SDK system/user prompt pairs and replays them through
 * the production Adapt AI SDK path under one shared runtime profile. It saves
 * source bytes, constructed calls, wire exchanges, SDK inputs/results/errors,
 * and Adapt results/errors without grading or expected-output comparison.
 *
 * Run:
 *   npx tsx evals/scripts/adaptive-text-writer-prompt-replay.ts <config-path>
 *
 * Validate sources without inference:
 *   npx tsx evals/scripts/adaptive-text-writer-prompt-replay.ts <config-path> --validate-only
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { z } from 'zod'

import { createAiSdkLLM, generate } from '../../src/llm'

const positiveInteger = z.number().int().positive()
const nonnegativeInteger = z.number().int().nonnegative()
const sourceSchema = z
	.object({
		label: z.string().min(1),
		artifactRoot: z.string().min(1),
		repetition: positiveInteger,
		sdkCallIndex: positiveInteger,
		caseIds: z.array(z.string().min(1)).min(1).readonly(),
	})
	.strict()
	.readonly()
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
			.strict()
			.readonly(),
		settings: z
			.object({
				temperature: z.number(),
				maxOutputTokens: positiveInteger,
				maxRetries: nonnegativeInteger,
				timeoutMs: positiveInteger,
				loadedContextTokens: positiveInteger,
			})
			.strict()
			.readonly(),
		sources: z.array(sourceSchema).min(2).readonly(),
		outputRoot: z.string().min(1),
		repetitions: positiveInteger,
	})
	.strict()
	.readonly()

const sdkInputSchema = z
	.object({
		prompt: z
			.array(
				z.union([
					z
						.object({ role: z.literal('system'), content: z.string() })
						.passthrough(),
					z
						.object({
							role: z.literal('user'),
							content: z
								.array(
									z
										.object({ type: z.literal('text'), text: z.string() })
										.passthrough(),
								)
								.min(1),
						})
						.passthrough(),
				]),
			)
			.min(2),
	})
	.passthrough()

type ReplayConfig = z.infer<typeof configSchema>
type ReplaySource = z.infer<typeof sourceSchema>

interface SavedPrompt {
	readonly sourcePath: string
	readonly sourceText: string
	readonly sourceSha256: string
	readonly system: string
	readonly prompt: string
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function exactInspect(value: unknown): string {
	return inspect(value, {
		depth: null,
		maxArrayLength: null,
		maxStringLength: null,
		getters: true,
	})
}

function replacer(_key: string, value: unknown): unknown {
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

function writeEvidence(directory: string, stem: string, value: unknown): void {
	writeFileSync(
		resolve(directory, `${stem}.raw.json`),
		`${JSON.stringify(value, replacer, 2)}\n`,
	)
	writeFileSync(
		resolve(directory, `${stem}.raw.inspect.txt`),
		`${exactInspect(value)}\n`,
	)
}

function runId(): string {
	return new Date().toISOString().split(':').join('-')
}

function sourceInputPath(source: ReplaySource, caseId: string): string {
	const index = String(source.sdkCallIndex).padStart(3, '0')
	return resolve(
		source.artifactRoot,
		`repetition-${source.repetition}`,
		caseId,
		'sdk',
		`${index}-input.raw.json`,
	)
}

function readSavedPrompt(source: ReplaySource, caseId: string): SavedPrompt {
	const sourcePath = sourceInputPath(source, caseId)
	const sourceText = readFileSync(sourcePath, 'utf8')
	const parsed = sdkInputSchema.parse(JSON.parse(sourceText))
	const systems = parsed.prompt.filter(
		(entry): entry is Extract<(typeof parsed.prompt)[number], { role: 'system' }> =>
			entry.role === 'system',
	)
	const users = parsed.prompt.filter(
		(entry): entry is Extract<(typeof parsed.prompt)[number], { role: 'user' }> =>
			entry.role === 'user',
	)
	if (systems.length !== 1 || users.length !== 1) {
		throw new Error('saved writer request must contain one system and one user message')
	}
	return {
		sourcePath,
		sourceText,
		sourceSha256: digest(sourceText),
		system: systems[0].content,
		prompt: users[0].content.map(({ text }) => text).join(''),
	}
}

function observedModel(
	config: ReplayConfig,
	caseDirectory: string,
): LanguageModel {
	const apiKey =
		config.provider.apiKeyEnv === undefined
			? undefined
			: process.env[config.provider.apiKeyEnv]
	const wireDirectory = resolve(caseDirectory, 'wire')
	const sdkDirectory = resolve(caseDirectory, 'sdk')
	mkdirSync(wireDirectory, { recursive: true })
	mkdirSync(sdkDirectory, { recursive: true })
	let wireIndex = 0
	const observedFetch: typeof fetch = async (input, init) => {
		wireIndex += 1
		const stem = String(wireIndex).padStart(3, '0')
		const request = new Request(input, init)
		writeFileSync(
			resolve(wireDirectory, `${stem}-request-body.raw.txt`),
			await request.clone().text(),
		)
		writeEvidence(wireDirectory, `${stem}-request-metadata`, {
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(request.headers.entries()),
		})
		try {
			const response = await fetch(request)
			writeFileSync(
				resolve(wireDirectory, `${stem}-response-body.raw.txt`),
				await response.clone().text(),
			)
			writeEvidence(wireDirectory, `${stem}-response-metadata`, {
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			})
			return response
		} catch (error) {
			writeEvidence(wireDirectory, `${stem}-error`, error)
			throw error
		}
	}
	const provider = createOpenAICompatible({
		name: config.provider.name,
		baseURL: config.provider.baseUrl,
		...(apiKey === undefined ? {} : { apiKey }),
		fetch: observedFetch,
	})
	const model = provider(config.provider.modelId)
	let sdkIndex = 0
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property !== 'doGenerate')
				return Reflect.get(target, property, receiver)
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

async function replayCase(
	config: ReplayConfig,
	source: ReplaySource,
	caseId: string,
	caseDirectory: string,
): Promise<void> {
	mkdirSync(caseDirectory, { recursive: true })
	const saved = readSavedPrompt(source, caseId)
	writeFileSync(
		resolve(caseDirectory, 'source-sdk-input.raw.json'),
		saved.sourceText,
	)
	writeEvidence(caseDirectory, 'constructed-input', {
		source: {
			label: source.label,
			caseId,
			path: saved.sourcePath,
			sha256: saved.sourceSha256,
		},
		request: {
			system: saved.system,
			prompt: saved.prompt,
			model: {
				plugin: 'ai-sdk',
				provider: config.provider.name,
				id: config.provider.modelId,
			},
			settings: config.settings,
		},
	})
	const model = observedModel(config, caseDirectory)
	const llm = createAiSdkLLM({
		providers: { [config.provider.name]: () => model },
	})
	try {
		const result = await generate({
			llm,
			model: {
				plugin: 'ai-sdk',
				provider: config.provider.name,
				id: config.provider.modelId,
			},
			system: saved.system,
			prompt: saved.prompt,
			temperature: config.settings.temperature,
			maxOutputTokens: config.settings.maxOutputTokens,
			maxRetries: config.settings.maxRetries,
			timeout: config.settings.timeoutMs,
		})
		writeEvidence(caseDirectory, 'adapt-result', result)
	} catch (error) {
		writeEvidence(caseDirectory, 'adapt-error', error)
		throw error
	}
}

function validateSources(config: ReplayConfig): readonly {
	readonly label: string
	readonly caseId: string
	readonly sourcePath: string
	readonly sourceSha256: string
}[] {
	return config.sources.flatMap((source) =>
		source.caseIds.map((caseId) => {
			const saved = readSavedPrompt(source, caseId)
			return {
				label: source.label,
				caseId,
				sourcePath: saved.sourcePath,
				sourceSha256: saved.sourceSha256,
			}
		}),
	)
}

async function main(): Promise<void> {
	const configArgument = process.argv[2]
	if (configArgument === undefined) throw new Error('provide a replay config path')
	const configPath = resolve(configArgument)
	const configText = readFileSync(configPath, 'utf8')
	const config = configSchema.parse(JSON.parse(configText))
	const inventory = validateSources(config)
	if (process.argv.includes('--validate-only')) {
		console.log(
			JSON.stringify(
				{
					configPath,
					model: config.provider.modelId,
					loadedContextTokens: config.settings.loadedContextTokens,
					requestsPerRepetition: inventory.length,
					repetitions: config.repetitions,
					inventory,
				},
				null,
				2,
			),
		)
		return
	}
	const directory = resolve(config.outputRoot, runId())
	mkdirSync(directory, { recursive: true })
	writeFileSync(resolve(directory, 'supplied-config.raw.json'), configText)
	writeEvidence(directory, 'metadata', {
		script: 'evals/scripts/adaptive-text-writer-prompt-replay.ts',
		timestamp: new Date().toISOString(),
		configPath,
		model: config.provider.modelId,
		loadedContextTokens: config.settings.loadedContextTokens,
		inventory,
	})
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		for (const source of config.sources) {
			for (const caseId of source.caseIds) {
				const caseDirectory = resolve(
					directory,
					`repetition-${repetition}`,
					source.label,
					caseId,
				)
				try {
					await replayCase(config, source, caseId, caseDirectory)
				} catch (error) {
					mkdirSync(caseDirectory, { recursive: true })
					writeEvidence(caseDirectory, 'execution-error', error)
				}
			}
		}
	}
	console.log(directory)
}

main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
