/**
 * Diagnostic only: replay captured system/user content through LM Studio's
 * native chat API with reasoning off versus on.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'

const configSchema = z.object({
	nativeChatUrl: z.string().url(),
	model: z.string().min(1),
	outputRoot: z.string().min(1),
	requestTimeoutMs: z.number().int().positive(),
	contextLength: z.number().int().positive(),
	maxOutputTokens: z.number().int().positive(),
	temperature: z.number().finite(),
	reasoningModes: z.array(z.enum(['off', 'on'])).min(1),
	appendCapturedOutputSchema: z.boolean(),
	outputSchemaPrefix: z.string().min(1),
	scenarios: z.array(z.object({
		id: z.string().min(1),
		sourceRequestPath: z.string().min(1),
	}).strict()).min(1),
}).strict()

const capturedRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.tuple([
		z.object({ role: z.literal('system'), content: z.string() }).strict(),
		z.object({ role: z.literal('user'), content: z.string() }).strict(),
	]),
	response_format: z.object({
		json_schema: z.object({ schema: z.unknown() }).passthrough(),
	}).passthrough(),
}).passthrough()

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
	const config = configSchema.parse(JSON.parse(readFileSync(resolve(configPath), 'utf8')))
	const startedAt = new Date().toISOString()
	const directory = resolve(config.outputRoot, startedAt.split(':').join('-'))
	mkdirSync(directory, { recursive: true })

	const suppliedInputs: unknown[] = []
	const results: unknown[] = []
	for (const scenario of config.scenarios) {
		const originalRequestText = readFileSync(resolve(scenario.sourceRequestPath), 'utf8')
		const originalRequest = capturedRequestSchema.parse(JSON.parse(originalRequestText))
		const capturedSchema = originalRequest.response_format.json_schema.schema
		const systemPrompt = config.appendCapturedOutputSchema
			? `${originalRequest.messages[0].content}\n\n${config.outputSchemaPrefix}\n${JSON.stringify(capturedSchema)}`
			: originalRequest.messages[0].content
		const shared = {
			model: config.model,
			input: originalRequest.messages[1].content,
			system_prompt: systemPrompt,
			stream: false,
			store: false,
			context_length: config.contextLength,
			max_output_tokens: config.maxOutputTokens,
			temperature: config.temperature,
		}
		suppliedInputs.push({ scenario, originalRequestText, originalRequest, nativeSharedRequest: shared })

		for (const reasoning of config.reasoningModes) {
			const request = { ...shared, reasoning }
			const requestBody = JSON.stringify(request)
			const prefix = `${scenario.id}-reasoning-${reasoning}`
			writeFileSync(resolve(directory, `${prefix}-request-body.raw.txt`), requestBody)
			try {
				const response = await fetch(config.nativeChatUrl, {
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
					reasoning,
					responseStatus: response.status,
					responseHeaders: Object.fromEntries(response.headers.entries()),
				}
				writeFileSync(resolve(directory, `${prefix}-transport.json`), JSON.stringify(transport, null, 2))
				results.push(transport)
			} catch (failure) {
				writeFileSync(resolve(directory, `${prefix}-failure.inspect.txt`), exact(failure))
				results.push({ scenarioId: scenario.id, reasoning, failure })
			}
		}
	}

	writeFileSync(resolve(directory, 'raw-input.inspect.txt'), exact({ configPath, config, suppliedInputs }))
	writeFileSync(resolve(directory, 'raw-output.inspect.txt'), exact(results))
	writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify({
		startedAt,
		completedAt: new Date().toISOString(),
		configPath,
		reasoningModesRun: config.reasoningModes,
		capturedSystemModification: config.appendCapturedOutputSchema
			? 'appended captured response_format JSON schema with supplied generic prefix'
			: 'none',
		nativeRequestConfiguration: {
			endpoint: config.nativeChatUrl,
			model: config.model,
			contextLength: config.contextLength,
			maxOutputTokens: config.maxOutputTokens,
			temperature: config.temperature,
			store: false,
			seed: 'omitted because it is not a documented native field',
			responseFormat: 'omitted because it is not a documented native field',
			reasoningModes: config.reasoningModes,
			appendCapturedOutputSchema: config.appendCapturedOutputSchema,
		},
		grading: null,
	}, null, 2))
	console.log(directory)
}

await main()
