/**
 * Eval: field revision on a local model
 *
 * Objectives:
 *   1. Does the field-revision procedure keep a fixed set of fields current
 *      across a growing stream, within the reviewer's acceptable ranges?
 *   2. Do ordered ratings move gradually, survive regressions, and ignore
 *      irrelevant and instruction-like inputs?
 *   3. Is every change recorded with the input's own date beside the current
 *      state, so history is available without living in the understanding?
 *
 * Runs the production procedure through the real Adapt AI SDK provider, with
 * memory carried forward across batches. Raw output only: every request and
 * outcome, the memory and change history at each checkpoint, and costs.
 * The reviewer compares checkpoints with the reviewer key by hand.
 *
 * Run (load the model in LM Studio first):
 *   npx tsx evals/scripts/field-revision-eval.ts evals/config/structured-text-learning/clinical-dimensions-qwen.json
 *
 * Options:
 *   --oracle <answers.json>   Replace the model with hand-written literal answers
 *                             to every question (perfect-answer test). No model
 *                             is called; the score is the ceiling of the design.
 *   --confirmations <n>       Override fieldRevision.confirmations for this run.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { createAiSdkLLM } from '../../src/llm'
import { createBoundedDeviceScheduler } from '../../src/llm/local/scheduler'
import { LearningRegistry } from '../../src/learning/registry'
import {
	createAdaptTextProcedureProvider,
	createConservativeByteTokenCounter,
	type ProcedurePorts,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	type TextInput,
	type TextLearningConfig,
} from '../../src/learning/text-procedures'

interface EvalConfig {
	provider: { name: string; baseUrl: string; modelId: string }
	settings: { temperature: number; maxOutputTokens: number; maxRetries: number; timeoutMs: number }
	streamPath: string
	reviewerKeyPath: string
	outputRoot: string
	batchSize: number
	tokenCounter: { requestTemplateOverheadTokens: number; textTemplateOverheadTokens: number }
	configuration: Omit<TextLearningConfig, 'lens'>
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface OracleAnswers {
	answers: Record<string, { irrelevant?: boolean; untrusted?: boolean; levels?: Record<string, string> }>
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Answers the procedure's questions from hand-written labels. The note is
 * found by its text inside the prompt; the question by its exact wording.
 */
function oracleProvider(
	labels: OracleAnswers,
	inputs: readonly TextInput[],
	fieldRevision: NonNullable<TextLearningConfig['fieldRevision']>,
): ProcedurePorts['provider'] {
	const levelsOf = (path: string) => {
		const node = (fieldRevision.schema as { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> })
			.properties[path.split('.')[0] ?? '']
		return node?.properties?.[path.split('.')[1] ?? '']?.enum ?? []
	}
	const questions = new Map<string, { group: string; option: string; path: string }>()
	for (const [path, byOption] of Object.entries(fieldRevision.indicators ?? {}))
		for (const [option, question] of Object.entries(byOption))
			questions.set(question, { group: path.split('.')[0] ?? path, option, path })
	const complete = (text: string) => ({ status: 'complete' as const, text, completion: { finishReason: 'stop' as const } })
	return {
		async generate(request) {
			const prompt = request.prompt
			const note = [...inputs]
				.filter((input) => prompt.includes(input.text))
				.sort((a, b) => b.text.length - a.text.length)[0]
			if (note === undefined) throw new Error(`oracle: no note found in prompt: ${prompt.slice(0, 120)}`)
			const label = labels.answers[note.deliveryId]
			if (label === undefined) throw new Error(`oracle: no answers for ${note.deliveryId}`)
			const levels = label.levels ?? {}
			if (request.system.includes('Answer UNTRUSTED')) return complete(label.untrusted ? 'UNTRUSTED' : 'OK')
			if (prompt.endsWith('Relevant? YES or NO:')) return complete(label.irrelevant || label.untrusted ? 'NO' : 'YES')
			const asked = prompt.match(/\n\nQuestion: ([\s\S]*)\n\nYES or NO:$/)?.[1]
			if (asked !== undefined) {
				const question = questions.get(asked)
				if (question === undefined) throw new Error(`oracle: unknown question: ${asked}`)
				const shown = levels[question.group]
				const scale = levelsOf(question.path)
				return complete(shown !== undefined && scale.indexOf(question.option) <= scale.indexOf(shown) ? 'YES' : 'NO')
			}
			const selected = prompt.match(/Does the note directly show something about (\w+)\? YES or NO:$/)?.[1]
			if (selected !== undefined) return complete(levels[selected] !== undefined ? 'YES' : 'NO')
			if (prompt.includes('Describe:')) return complete(note.text.replace(/^Session \d+\.\s*/, ''))
			throw new Error(`oracle: unrecognised request: ${prompt.slice(-160)}`)
		},
	}
}

async function main() {
	const root = resolve(import.meta.dirname, '..', '..')
	const configPath = resolve(process.argv[2] ?? '')
	const config = JSON.parse(readFileSync(configPath, 'utf8')) as EvalConfig
	const oraclePath = option('--oracle')
	const confirmations = option('--confirmations')
	if (confirmations !== undefined && config.configuration.fieldRevision !== undefined)
		config.configuration = {
			...config.configuration,
			fieldRevision: { ...config.configuration.fieldRevision, confirmations: Number(confirmations) },
		}
	if (oraclePath !== undefined) config.outputRoot = `${config.outputRoot}-oracle`
	const streamPath = resolve(root, config.streamPath)
	const stream = JSON.parse(readFileSync(streamPath, 'utf8')) as {
		lens: TextLearningConfig['lens']
		checkpoints: number[]
		inputs: TextInput[]
	}
	const runDirectory = resolve(root, config.outputRoot, new Date().toISOString().replaceAll(':', '-'))
	mkdirSync(resolve(runDirectory, 'calls'), { recursive: true })
	writeFileSync(resolve(runDirectory, 'supplied-config.raw.json'), readFileSync(configPath))
	writeFileSync(
		resolve(runDirectory, 'run-options.json'),
		`${JSON.stringify({ oracle: oraclePath ?? null, confirmations: config.configuration.fieldRevision?.confirmations ?? null }, null, 2)}\n`,
	)
	const sourceFiles = [
		'src/learning/text-procedures/field-revision.ts',
		'src/learning/text-procedures/line-revision.ts',
		'src/learning/text-procedures/run.ts',
		'src/llm/index.ts',
	]
	writeFileSync(
		resolve(runDirectory, 'source-identifiers.json'),
		`${JSON.stringify(
			{
				stream: { path: config.streamPath, sha256: sha256(streamPath) },
				reviewerKey: { path: config.reviewerKeyPath, sha256: sha256(resolve(root, config.reviewerKeyPath)), suppliedToModel: false },
				sources: sourceFiles.map((path) => ({ path, sha256: sha256(resolve(root, path)) })),
			},
			null,
			2,
		)}\n`,
	)

	console.log('Eval: field revision on a local model')
	console.log(`Model: ${oraclePath === undefined ? config.provider.modelId : `oracle (${oraclePath})`}`)
	console.log(`Output: ${runDirectory}`)

	const provider = createOpenAICompatible({ name: config.provider.name, baseURL: config.provider.baseUrl, supportsStructuredOutputs: true })
	const model = provider(config.provider.modelId)
	const llm = createAiSdkLLM({ providers: { [config.provider.name]: provider } })
	const procedureProvider = createAdaptTextProcedureProvider({
		llm,
		model,
		settings: config.settings,
		scheduler: createBoundedDeviceScheduler({ maxConcurrent: 1, maxQueued: 4 }),
		priority: 'background',
	})
	const fieldRevision = config.configuration.fieldRevision
	const answerer: ProcedurePorts['provider'] =
		oraclePath === undefined || fieldRevision === undefined
			? procedureProvider
			: oracleProvider(JSON.parse(readFileSync(resolve(root, oraclePath), 'utf8')) as OracleAnswers, stream.inputs, fieldRevision)
	let callIndex = 0
	const recorded: ProcedurePorts['provider'] = {
		async generate(request, signal) {
			const started = Date.now()
			const outcome = await answerer.generate(request, signal)
			callIndex += 1
			const usage = outcome.status === 'failure' ? undefined : outcome.completion.usage
			writeFileSync(
				resolve(runDirectory, 'calls', `${String(callIndex).padStart(6, '0')}.json`),
				`${JSON.stringify(
					{
						system: request.system,
						prompt: request.prompt,
						status: outcome.status,
						text: outcome.status === 'complete' ? outcome.text : undefined,
						code: outcome.status === 'failure' ? outcome.code : undefined,
						usage,
						ms: Date.now() - started,
					},
					null,
					2,
				)}\n`,
			)
			return outcome
		},
	}
	const registry = new LearningRegistry()
	registerAdaptiveTextProcedures(registry)
	const configuration: TextLearningConfig = { ...config.configuration, lens: stream.lens }
	const ports: ProcedurePorts = {
		registry,
		provider: recorded,
		tokens: createConservativeByteTokenCounter(config.tokenCounter),
		clock: { now: () => new Date().toISOString() },
	}

	let memory = ''
	let revision = 0
	const history: { runId: string; explanation: string }[] = []
	const outcomes: { runId: string; outcome: string; reason?: string; code?: string }[] = []
	const processed = new Set<string>()
	let pending: TextInput[] = []
	const started = Date.now()
	const flush = async () => {
		if (pending.length === 0) return
		const runId = `run-${String(outcomes.length + 1).padStart(3, '0')}`
		const proposal = await runTextProcedure(
			{
				runId,
				pins: {
					execution: { memory: revision, configuration: 0, registry: 'field-revision-eval' },
					neuron: { id: 'clinical-dimensions', incarnation: 'eval', ownershipRevision: 1 },
					procedure: configuration.activeProcedure,
					profile: { id: 'field-revision-eval-profile', version: '1' },
					model: configuration.model,
					learnedStateRevision: revision,
				},
				configuration,
				memory: { text: memory, revision },
				inputs: pending,
				signal: new AbortController().signal,
			},
			ports,
		)
		const result = proposal.result as {
			outcome: string
			reason?: string
			code?: string
			patch?: { text?: string }
			explanation?: string
		}
		outcomes.push({ runId, outcome: result.outcome, reason: result.reason, code: result.code })
		if (result.outcome === 'change' && typeof result.patch?.text === 'string') {
			memory = result.patch.text
			revision += 1
			if (result.explanation) history.push({ runId, explanation: result.explanation })
		}
		if (result.outcome !== 'defer') for (const input of pending) processed.add(input.deliveryId)
		console.log(`${runId}: ${result.outcome}${result.code ? ` (${result.code})` : ''} after ${pending.map(({ deliveryId }) => deliveryId).join(', ')}`)
		pending = []
	}
	for (const [index, input] of stream.inputs.entries()) {
		const position = index + 1
		if (!processed.has(input.deliveryId) && !pending.some(({ deliveryId }) => deliveryId === input.deliveryId)) pending.push(input)
		const checkpoint = stream.checkpoints.includes(position)
		if (pending.length >= config.batchSize || checkpoint) await flush()
		if (checkpoint) {
			writeFileSync(
				resolve(runDirectory, `checkpoint-${String(position).padStart(3, '0')}.json`),
				`${JSON.stringify({ afterInput: position, memory: memory.length === 0 ? {} : JSON.parse(memory), history }, null, 2)}\n`,
			)
			console.log(`\n===== checkpoint ${position} =====\n${memory}`)
		}
	}
	await flush()
	writeFileSync(
		resolve(runDirectory, 'summary.json'),
		`${JSON.stringify({ outcomes, calls: callIndex, wallSeconds: (Date.now() - started) / 1000, finalRevision: revision }, null, 2)}\n`,
	)
	console.log(`\nCalls: ${callIndex}  Wall seconds: ${((Date.now() - started) / 1000).toFixed(1)}`)
}

main().catch((error) => {
	console.error('Eval crashed:', error)
	process.exit(1)
})
