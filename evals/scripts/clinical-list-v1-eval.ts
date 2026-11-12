/**
 * Eval: v1 list neuron on the clinical-dimensions streams
 *
 * Objective:
 *   What does Seren's current clinical-dimensions neuron (a v1 ListNeuron with
 *   Seren's own instructions, schemas, and governance) produce on the same
 *   streams and local models as field revision? This is the v1 comparator.
 *
 * Runs ListNeuron from this repository, which is the v1 code plus the tool
 * input validation fix, so v1 gets its best chance. Inputs are learned in the
 * same batches as the field-revision eval, and synthesis is forced after each
 * batch. Raw output only: items at every checkpoint, neuron events, timing.
 * Scoring takes the most recent item per dimension at each checkpoint.
 *
 * Run (load the model in LM Studio first):
 *   MODEL=qwen/qwen3.5-2b STREAM=clinical-dimensions npx tsx evals/scripts/clinical-list-v1-eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { createAiSdkLLM } from '../../src/llm'
import { ListNeuron } from '../../src/neurons/list'
import { MemoryNeuronStore } from '../../src/stores'

const MODEL = process.env.MODEL ?? 'qwen/qwen3.5-2b'
const STREAM = process.env.STREAM ?? 'clinical-dimensions'
const BATCH = Number(process.env.BATCH ?? '4')
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1'

interface StreamInput {
	deliveryId: string
	text: string
}

async function main() {
	const root = resolve(import.meta.dirname, '..')
	const stream = JSON.parse(
		readFileSync(resolve(root, `datasets/structured-text-learning/stream-${STREAM}.json`), 'utf8'),
	) as { inputs: StreamInput[]; checkpoints: number[] }
	const seren = JSON.parse(
		readFileSync(resolve(root, 'config/structured-text-learning/seren-v1-clinical-dimensions.json'), 'utf8'),
	) as {
		neuron: {
			id: string
			name: string
			description: string
			instructions: string
			governance: Record<string, unknown>
			observationSchema: Record<string, unknown>
			understandingSchema: Record<string, unknown>
		}
	}
	const runId = new Date().toISOString().replaceAll(':', '-')
	const out = resolve(root, `.data/clinical-list-v1/${MODEL.replaceAll('/', '_')}/${STREAM}/${runId}`)
	mkdirSync(out, { recursive: true })

	console.log('Eval: v1 list neuron on the clinical-dimensions streams')
	console.log(`Model: ${MODEL}  Stream: ${STREAM}  Batch: ${BATCH}`)
	console.log(`Output: ${out}`)

	const provider = createOpenAICompatible({ name: 'lmstudio', baseURL: BASE_URL, supportsStructuredOutputs: true })
	const model = provider(MODEL)
	const llm = createAiSdkLLM({ providers: { lmstudio: provider } })

	const events: unknown[] = []
	const neuron = await ListNeuron.create({
		model,
		llm,
		store: new MemoryNeuronStore(),
		id: seren.neuron.id,
		name: seren.neuron.name,
		description: seren.neuron.description,
		instructions: seren.neuron.instructions,
		governance: seren.neuron.governance,
		observationSchema: seren.neuron.observationSchema,
		understandingSchema: seren.neuron.understandingSchema,
		onEvent: (event) => events.push(event),
	} as Parameters<typeof ListNeuron.create>[0])

	const seen = new Set<string>()
	let pending: string[] = []
	const started = Date.now()
	const outcomes: { afterInput: number; status: string | undefined; seconds: number }[] = []
	for (const [index, input] of stream.inputs.entries()) {
		const position = index + 1
		if (!seen.has(input.deliveryId)) {
			seen.add(input.deliveryId)
			pending.push(input.text)
		}
		const checkpoint = stream.checkpoints.includes(position)
		if (pending.length >= BATCH || (checkpoint && pending.length > 0)) {
			const batchStarted = Date.now()
			let status: string | undefined
			try {
				const result = await neuron.learn(pending, { forceSynthesize: true })
				status = (result as { status?: string }).status
			} catch (error) {
				status = `error: ${error instanceof Error ? error.message : String(error)}`
			}
			outcomes.push({ afterInput: position, status, seconds: (Date.now() - batchStarted) / 1000 })
			console.log(`after input ${position}: ${status}`)
			pending = []
		}
		if (checkpoint) {
			const items = await neuron.getUnderstanding()
			writeFileSync(
				resolve(out, `checkpoint-${String(position).padStart(3, '0')}.items.json`),
				`${JSON.stringify(items, null, 2)}\n`,
			)
			console.log(`===== checkpoint ${position}: ${items.length} items`)
		}
	}
	writeFileSync(resolve(out, 'events.json'), `${JSON.stringify(events, null, 2)}\n`)
	writeFileSync(
		resolve(out, 'summary.json'),
		`${JSON.stringify({ outcomes, wallSeconds: (Date.now() - started) / 1000 }, null, 2)}\n`,
	)
	console.log(`Wall seconds: ${((Date.now() - started) / 1000).toFixed(1)}`)
	await neuron.dispose()
}

main().catch((error) => {
	console.error('Eval crashed:', error)
	process.exit(1)
})
