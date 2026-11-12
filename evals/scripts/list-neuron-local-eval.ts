/**
 * Eval: list neuron records on a local model
 *
 * Objectives:
 *   1. Can the existing ListNeuron (observe, then a tool loop that adds,
 *      updates, and removes items) keep per-item records current on a local
 *      model: owners, dates, regions, cards, identities, temporary roles?
 *   2. Do corrections replace the old value instead of adding a second item?
 *   3. Do same-named people stay separate items?
 *
 * Raw output only. The reviewer compares the saved items at each checkpoint
 * with the record-type expectations in the stream's reviewer key (see
 * evals/datasets/adaptive-text-learning/expectation-types.json).
 *
 * Run (load the model in LM Studio first):
 *   MODEL=qwen/qwen3.5-2b STREAM=project-commitments npx tsx evals/scripts/list-neuron-local-eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { createAiSdkLLM } from '../../src/llm'
import { ListNeuron } from '../../src/neurons/list'
import { MemoryNeuronStore } from '../../src/stores'

const MODEL = process.env.MODEL ?? 'qwen/qwen3.5-2b'
const STREAM = process.env.STREAM ?? 'project-commitments'
const BATCH = Number(process.env.BATCH ?? '8')
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1'

interface StreamInput {
	deliveryId: string
	text: string
}

const itemSchema = {
	type: 'object',
	properties: {
		key: {
			type: 'string',
			description:
				'Short unique key naming the item and what is tracked, for example "Atlas - owner" or "Alex Rowan (Cedar Labs) - badge".',
		},
		subject: {
			type: 'string',
			description: 'The named project, person with organization, service, or event.',
		},
		attribute: {
			type: 'string',
			description: 'What is tracked, for example owner, date, region, badge, role, scope, or status.',
		},
		value: { type: 'string', description: 'The current value.' },
		status: {
			type: 'string',
			enum: ['confirmed', 'tentative', 'temporary', 'ended'],
			description: 'Whether the value is confirmed, tentative, temporary, or no longer current.',
		},
	},
	required: ['key', 'subject', 'attribute', 'value', 'status'],
	additionalProperties: false,
}

async function main() {
	const root = resolve(import.meta.dirname, '..')
	const stream = JSON.parse(
		readFileSync(resolve(root, `datasets/adaptive-text-learning/stream-${STREAM}.json`), 'utf8'),
	) as { lens: { purpose: string; developerInstructions: string[] }; inputs: StreamInput[]; checkpoints: number[] }
	const runId = new Date().toISOString().replaceAll(':', '-')
	const out = resolve(root, `.data/list-neuron-local/${MODEL.replaceAll('/', '_')}/${STREAM}/${runId}`)
	mkdirSync(out, { recursive: true })

	console.log('Eval: list neuron records on a local model')
	console.log(`Model: ${MODEL}  Stream: ${STREAM}  Batch: ${BATCH}`)
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Output: ${out}`)

	const provider = createOpenAICompatible({ name: 'lmstudio', baseURL: BASE_URL, supportsStructuredOutputs: true })
	const model = provider(MODEL)
	const llm = createAiSdkLLM({ providers: { lmstudio: provider } })

	const instructions = [
		`Keep the current records for this purpose: ${stream.lens.purpose}`,
		'Track named items: owners, dates, regions, cards or badges, roles, scopes, and statuses.',
		'When a value changes, update the existing item instead of adding another one.',
		'Keep people with the same name as separate items, distinguished by organization.',
		...stream.lens.developerInstructions,
	].join('\n')

	const calls: unknown[] = []
	const neuron = await ListNeuron.create({
		model,
		llm,
		store: new MemoryNeuronStore(),
		instructions,
		observationSchema: { type: 'string' },
		understandingSchema: itemSchema,
		onEvent: (event) => calls.push(event),
	} as Parameters<typeof ListNeuron.create>[0])

	const seen = new Set<string>()
	let pending: string[] = []
	const started = Date.now()
	for (const [index, input] of stream.inputs.entries()) {
		const position = index + 1
		if (!seen.has(input.deliveryId)) {
			seen.add(input.deliveryId)
			pending.push(input.text)
		}
		const checkpoint = stream.checkpoints.includes(position)
		if (pending.length >= BATCH || (checkpoint && pending.length > 0)) {
			const result = await neuron.learn(pending, { forceSynthesize: true })
			console.log(`after input ${position}: learn status ${(result as { status?: string }).status}`)
			pending = []
		}
		if (checkpoint) {
			const items = await neuron.getUnderstanding()
			writeFileSync(resolve(out, `checkpoint-${String(position).padStart(3, '0')}.items.json`), `${JSON.stringify(items, null, 2)}\n`)
			console.log(`\n===== checkpoint ${position}: ${items.length} items =====`)
			for (const item of items) console.log(`  ${JSON.stringify((item as { data?: unknown }).data ?? item)}`)
		}
	}
	writeFileSync(resolve(out, 'events.json'), `${JSON.stringify(calls, null, 2)}\n`)
	console.log(`\nWall seconds: ${((Date.now() - started) / 1000).toFixed(1)}`)
	await neuron.dispose()
}

main().catch((error) => {
	console.error('Eval crashed:', error)
	process.exit(1)
})
