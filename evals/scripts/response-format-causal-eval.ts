/** Diagnostic only: replay captured requests through configured wire transforms. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const requestOverridesSchema = z.object({
	temperature: z.number().optional(),
	seed: z.number().int().optional(),
	max_tokens: z.number().int().positive().optional(),
}).strict()

const armSchema = z.object({
	id: z.string().min(1),
	omitRequestFields: z.array(z.string().min(1)).default([]),
	requestOverrides: requestOverridesSchema.optional(),
}).strict()

const armsSchema = z.array(armSchema)
	.min(1)
	.refine((arms) => new Set(arms.map((arm) => arm.id)).size === arms.length, 'arm ids must be unique')

const configSchema = z.object({
	chatCompletionsUrl: z.string().url(),
	outputRoot: z.string().min(1),
	requestTimeoutMs: z.number().int().positive(),
	repetitions: z.number().int().positive().default(1),
	scenarios: z.array(z.object({
		id: z.string().min(1),
		sourceRequestPath: z.string().min(1),
		arms: armsSchema.optional(),
	}).strict()).min(1),
}).strict()

const requestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(z.unknown()).min(1),
	stream: z.literal(false).optional(),
	response_format: z.unknown(),
}).passthrough()

type Request = z.infer<typeof requestSchema>
type Arm = z.infer<typeof armSchema>

const defaultArms: readonly Arm[] = [
	{ id: 'structured', omitRequestFields: [] },
	{ id: 'plain', omitRequestFields: ['response_format'] },
]

function parseRequest(value: unknown): Request {
	requestSchema.parse(value)
	return value as Request
}

function transformRequest(request: Request, arm: Arm): Record<string, unknown> {
	const transformed: Record<string, unknown> = { ...request }
	for (const field of arm.omitRequestFields) delete transformed[field]
	return { ...transformed, ...(arm.requestOverrides ?? {}) }
}

function exact(value: unknown): string {
	return inspect(value, {
		depth: null,
		maxArrayLength: null,
		maxStringLength: null,
		breakLength: 100,
	})
}

async function main(): Promise<void> {
	const configPath = process.argv[2]
	if (!configPath) throw new Error('config path argument is required')
	const configRaw = readFileSync(resolve(configPath), 'utf8')
	const config = configSchema.parse(JSON.parse(configRaw))
	const startedAt = new Date().toISOString()
	const directory = resolve(config.outputRoot, startedAt.split(':').join('-'))
	mkdirSync(directory, { recursive: true })
	writeFileSync(resolve(directory, 'supplied-config.raw.json'), configRaw)

	const suppliedInputs: unknown[] = []
	const results: unknown[] = []
	for (const scenario of config.scenarios) {
		const originalRequestText = readFileSync(resolve(scenario.sourceRequestPath), 'utf8')
		const originalRequest = parseRequest(JSON.parse(originalRequestText))
		const arms = scenario.arms ?? defaultArms
		writeFileSync(resolve(directory, `${scenario.id}-source-request-body.raw.txt`), originalRequestText)
		suppliedInputs.push({ scenario, originalRequestText, originalRequest })

		for (const arm of arms) {
			const request = transformRequest(originalRequest, arm)
			for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
				const requestBody = JSON.stringify(request)
				const repetitionSuffix = config.repetitions === 1 ? '' : `-repeat-${String(repetition).padStart(3, '0')}`
				const prefix = `${scenario.id}-${arm.id}${repetitionSuffix}`
				writeFileSync(resolve(directory, `${prefix}-request-body.raw.txt`), requestBody)
				try {
					const response = await fetch(config.chatCompletionsUrl, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: requestBody,
						redirect: 'error',
						signal: AbortSignal.timeout(config.requestTimeoutMs),
					})
					const responseBody = await response.text()
					writeFileSync(resolve(directory, `${prefix}-response-body.raw.txt`), responseBody)
					const transport = {
						scenarioId: scenario.id,
						arm: arm.id,
						repetition,
						responseStatus: response.status,
						responseHeaders: Object.fromEntries(response.headers.entries()),
					}
					writeFileSync(resolve(directory, `${prefix}-transport.json`), JSON.stringify(transport, null, 2))
					results.push(transport)
				} catch (failure) {
					writeFileSync(resolve(directory, `${prefix}-failure.inspect.txt`), exact(failure))
					results.push({ scenarioId: scenario.id, arm: arm.id, repetition, failure })
				}
			}
		}
	}

	writeFileSync(resolve(directory, 'raw-input.inspect.txt'), exact({ configPath, config, suppliedInputs }))
	writeFileSync(resolve(directory, 'raw-output.inspect.txt'), exact(results))
	writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify({
		startedAt,
		completedAt: new Date().toISOString(),
		configPath,
		requestTransform: 'configured field omission and numeric overrides; messages are unchanged',
		grading: null,
	}, null, 2))
	console.log(directory)
}

export const responseFormatCausalSupport = { configSchema, requestSchema, parseRequest, transformRequest, defaultArms }

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) await main()
