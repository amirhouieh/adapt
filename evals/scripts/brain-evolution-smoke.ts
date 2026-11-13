/**
 * Smoke: the evolution loop on a real model.
 *
 * A: the brain prompt covers coding and food, but only a coding neuron exists.
 *    Food inputs (and some noise) are not taken, become gaps, and evolve()
 *    runs once. Expected: one food neuron is created; no neuron for weather,
 *    trains or movies; after the gap retry the food neuron holds ramen,
 *    vegetarian, oats and sushi.
 * B: three neurons, two of them overlap (coding, typescript-style) plus food.
 *    evolve() runs once. Expected: coding and typescript-style are merged, or
 *    nothing changes. Food is not removed.
 *
 * No LLM judge: read the printed changes and memories.
 * Run: export OPENROUTER_API_KEY=... && npx tsx evals/scripts/brain-evolution-smoke.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { type AdaptLLMPlugin, Brain, createAiSdkLLM, MemoryBrainStore } from '../../src'

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')

const provider = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey,
	supportsStructuredOutputs: true,
})
const baseLLM = createAiSdkLLM({ providers: { openrouter: provider } })
let calls = 0
const log: unknown[] = []
const llm = {
	...baseLLM,
	async call(request: Parameters<typeof baseLLM.call>[0]) {
		calls++
		const result = await baseLLM.call(request)
		const { raw: _raw, ...rest } = result as typeof result & { raw?: unknown }
		log.push({ system: request.system, messages: request.messages, result: rest })
		return result
	},
} as AdaptLLMPlugin

const out = resolve(import.meta.dirname, '../.data/brain-evolution-smoke', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const started = Date.now()
const t = () => ((Date.now() - started) / 1000).toFixed(0)
const report: Record<string, unknown> = { model: MODEL }

async function snapshot(brain: Brain) {
	const neurons = []
	for (const n of brain.getNeurons()) {
		neurons.push({ id: n.id, name: n.name, description: n.description, instructions: n.instructions, memory: String(await n.getUnderstanding()) })
	}
	return neurons
}

async function scenario(
	name: string,
	neurons: Array<{ id: string; name: string; description: string; instructions: string }>,
	inputs: string[],
) {
	const before = calls
	const events: unknown[] = []
	const brain = await Brain.create({
		prompt: 'Track my coding preferences and my food habits.',
		model: provider(MODEL),
		llm,
		store: new MemoryBrainStore(),
		autoSetup: false,
		neurons,
		evolution: { enabled: true, autoEvaluate: false },
		ingest: { batchSize: 3 },
	})
	brain.on((e) => {
		if (e.type.startsWith('evolution:')) {
			events.push(e)
			console.log(`[${t()}s] ${name} ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`)
		}
	})
	for (let i = 0; i < inputs.length; i += 3) await brain.inject(inputs.slice(i, i + 3))
	console.log(`[${t()}s] ${name}: injected ${inputs.length}`)
	let result: unknown
	try {
		result = await brain.evolve()
	} catch (error) {
		result = { error: String(error) }
	}
	const after = await snapshot(brain)
	console.log(`\n== ${name} result\n${JSON.stringify(result, null, 2)}`)
	for (const n of after) console.log(`\n-- ${n.id}: ${n.description}\n${n.memory || '(empty)'}`)
	report[name] = { result, neurons: after, events, calls: calls - before }
	await brain.dispose()
}

const only = process.env.SCENARIO
if (!only || only === 'A') await scenario(
	'A-create-from-gaps',
	[{ id: 'coding', name: 'Coding', description: 'Coding preferences and tools', instructions: 'Track my coding preferences, tools and practices.' }],
	[
		'I always use strict TypeScript and avoid any.',
		'Dinner last night: vegetarian ramen, loved it.',
		'Weather tomorrow: rain in Amsterdam, 12 degrees.',
		'Our team formats code with Biome.',
		'Trying to eat less meat; mostly vegetarian now.',
		'The 8:15 train to Utrecht was delayed again.',
		'Breakfast is usually oats with banana.',
		'I prefer early returns over nested ifs.',
		'Had sushi with friends on Friday, salmon only.',
	],
)

if (!only || only === 'B') await scenario(
	'B-overlap',
	[
		{ id: 'coding', name: 'Coding', description: 'Coding preferences and tools', instructions: 'Track my coding preferences, tools and practices.' },
		{ id: 'typescript-style', name: 'TypeScript style', description: 'How I write TypeScript', instructions: 'Track how I write TypeScript: style, strictness, patterns.' },
		{ id: 'food', name: 'Food', description: 'Food habits', instructions: 'Track my food habits and diet.' },
	],
	[
		'I always use strict TypeScript and avoid any.',
		'I prefer early returns over nested ifs.',
		'Dinner last night: vegetarian ramen, loved it.',
		'Our team formats code with Biome.',
		'Breakfast is usually oats with banana.',
		'Integration tests matter more to me than unit tests.',
	],
)

report.seconds = (Date.now() - started) / 1000
report.calls = calls
writeFileSync(resolve(out, 'calls.json'), `${JSON.stringify(log, null, 2)}\n`)
writeFileSync(resolve(out, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nSaved: ${out}  (${t()}s, ${calls} calls)`)
