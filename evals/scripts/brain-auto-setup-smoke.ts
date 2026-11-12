/**
 * Smoke: Brain auto-setup on a real model. Brain designs its own neurons from
 * the prompt (decomposition with the neuron config schema), then learns the
 * same inputs as brain-two-step-smoke.ts and answers one question.
 * No LLM judge: read the printed neurons and memories against the inputs.
 *
 * Run: export OPENROUTER_API_KEY=... && npx tsx evals/scripts/brain-auto-setup-smoke.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Brain, createAiSdkLLM, MemoryBrainStore } from '../../src'
import { INTERNAL_NEURON_IDS } from '../../src/brain/internal-neurons'

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')

const inputs = [
	'I always use strict TypeScript and avoid any.',
	'Our team formats code with Prettier.',
	'Dinner last night: vegetarian ramen, loved it.',
	'Weather tomorrow: rain in Amsterdam, 12 degrees.',
	'The 8:15 train to Utrecht was delayed again.',
	'Watched an old western movie on Sunday.',
	'I prefer early returns over nested ifs.',
	'Trying to eat less meat; mostly vegetarian now.',
	'Breakfast is usually oats with banana.',
	'We dropped Prettier and switched to Biome for formatting.',
	'Integration tests matter more to me than unit tests.',
	'Had sushi with friends on Friday, salmon only.',
]

const provider = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey,
	supportsStructuredOutputs: true,
})
const model = provider(MODEL)
const llm = createAiSdkLLM({ providers: { openrouter: provider } })
const store = new MemoryBrainStore()
const out = resolve(import.meta.dirname, '../.data/brain-auto-setup-smoke', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const log: unknown[] = []
const started = Date.now()
const t = () => ((Date.now() - started) / 1000).toFixed(0)

const brain = await Brain.create({
	prompt: 'Track my coding preferences and my food habits.',
	model,
	llm,
	store,
	evolution: { enabled: false },
	ingest: { batchSize: 3 },
	onEvent: (event) => {
		if (event.type === 'brain:init:failed') console.log(`[${t()}s] init failed: ${JSON.stringify(event.payload).slice(0, 400)}`)
	},
})
for (const n of brain.getNeurons()) {
	console.log(`\n== neuron ${n.id} (${n.name}): ${n.description}\n${n.instructions}`)
}
brain.on((event) => {
	log.push(event)
	if (event.type === 'brain:inject:batch:completed') {
		const p = event.payload as { batchIndex: number; results: Array<{ neuronId: string; result: { status: string } }> }
		console.log(`[${t()}s] batch ${p.batchIndex}: ${p.results.map((r) => `${r.neuronId}=${r.result.status}`).join(', ')}`)
	}
	if (event.type === 'brain:signal:received') console.log(`[${t()}s] signal: ${JSON.stringify(event.payload).slice(0, 160)}`)
})
console.log(`[${t()}s] created; neurons: ${brain.getNeurons().map((n) => n.id).join(', ')}`)

for (let i = 0; i < inputs.length; i += 3) {
	await brain.inject(inputs.slice(i, i + 3))
}

const memories: Record<string, string> = {}
for (const n of brain.getNeurons()) memories[n.id] = String(await n.getUnderstanding())
for (const [key, id] of Object.entries(INTERNAL_NEURON_IDS)) {
	const record = await store.getNeuronStore(id).understanding.get('current')
	memories[`internal:${key}`] = typeof record?.data === 'string' ? record.data : ''
}
const answer = await brain.ask('Which formatter does my team use now, and what do I eat?')
console.log(`\n== ask\n${answer.insight}`)
const dismissed = await store.dismissedBatches.list()
for (const [id, text] of Object.entries(memories)) console.log(`\n== ${id}\n${text || '(empty)'}`)
console.log(`\n== dismissed batches: ${dismissed.length}`)
for (const d of dismissed) console.log(`- ${JSON.stringify(d.data)} gaps=${JSON.stringify(d.gaps)}`)
writeFileSync(resolve(out, 'result.json'), `${JSON.stringify({ model: MODEL, inputs, neurons: brain.getNeurons().map((n) => ({ id: n.id, name: n.name, description: n.description, instructions: n.instructions })), memories, answer: answer.insight, dismissed, seconds: (Date.now() - started) / 1000 }, null, 2)}\n`)
writeFileSync(resolve(out, 'events.json'), `${JSON.stringify(log, null, 2)}\n`)
console.log(`\nSaved: ${out}  (${t()}s)`)
await brain.dispose()
