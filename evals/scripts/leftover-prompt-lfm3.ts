/**
 * Leftover prompt test: can LFM3 find what in a batch no neuron kept?
 *
 * For each case: every neuron runs the real extract step on the batch. Then
 * one leftover call gets the data plus the notes the neurons kept and must
 * reply with the data lines that are not in the notes, or NONE.
 * Two forms: one entry per call, and a chunk of all entries in one call.
 * Expected leftovers are written below, before any run. No LLM judge.
 *
 * Run: export OPENROUTER_API_KEY=... && npx tsx evals/scripts/leftover-prompt-lfm3.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import { leftoverPrompt, leftoverSystemPrompt } from '../../src/brain/evolution'
import { twoStepPrompts, TWO_STEP_NOTHING_RELEVANT } from '../../src/learning/text-procedures/two-step'

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const RUNS = Number(process.env.RUNS ?? 2)
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')
const model = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey })(MODEL)

const NEURONS = {
	coding: 'Track my coding preferences, tools and practices.',
	food: 'Track my food habits and diet.',
} as const
type NeuronId = keyof typeof NEURONS

interface Case {
	id: string
	neurons: NeuronId[]
	data: string[]
	expected: string
}
const cases: Case[] = [
	{
		id: 'mixed-one-left',
		neurons: ['coding', 'food'],
		data: ['I always use strict TypeScript and avoid any.', 'Dinner last night: vegetarian ramen, loved it.', 'Weather tomorrow: rain in Amsterdam, 12 degrees.'],
		expected: 'rain in Amsterdam only',
	},
	{
		id: 'mixed-two-left',
		neurons: ['coding'],
		data: ['I always use strict TypeScript and avoid any.', 'Dinner last night: vegetarian ramen, loved it.', 'Weather tomorrow: rain in Amsterdam, 12 degrees.'],
		expected: 'ramen and rain',
	},
	{
		id: 'all-kept',
		neurons: ['coding', 'food'],
		data: ['I always use strict TypeScript and avoid any.', 'Dinner last night: vegetarian ramen, loved it.', 'Breakfast is usually oats with banana.'],
		expected: 'NONE',
	},
	{
		id: 'six-lines',
		neurons: ['coding'],
		data: [
			'I always use strict TypeScript and avoid any.',
			'Our team formats code with Biome.',
			'Had sushi with friends on Friday, salmon only.',
			'I prefer early returns over nested ifs.',
			'Trying to eat less meat; mostly vegetarian now.',
			'The 8:15 train to Utrecht was delayed again.',
		],
		expected: 'sushi, less meat, train',
	},
]

const SINGLE_SYSTEM = `Here is some data, and the notes that were already taken from it.
Our job is to find what in the data is not in the notes.

Reply with those parts of the data only, copied as they are, in plain text. If everything in the data is in the notes, reply with exactly: ${TWO_STEP_NOTHING_RELEVANT}`

const calls: Array<{ kind: string; system: string; prompt: string; output: string }> = []
async function call(kind: string, system: string, prompt: string): Promise<string> {
	const { text } = await generateText({ model, system, prompt })
	calls.push({ kind, system, prompt, output: text.trim() })
	return text.trim()
}

const lens = (instructions: string) => ({
	purpose: instructions,
	developerInstructions: [],
	instructionPrecedence: [],
	incomingTextRole: 'data-only' as const,
})

async function notesFor(c: Case): Promise<string> {
	const kept: string[] = []
	for (const id of c.neurons) {
		const out = await call(
			`extract:${id}`,
			twoStepPrompts.extractSystem(lens(NEURONS[id])),
			twoStepPrompts.extractPrompt(
				c.data.map((text, i) => ({ deliveryId: `${c.id}-${i}`, text, observedAt: new Date(0).toISOString() })),
			),
		)
		if (out !== TWO_STEP_NOTHING_RELEVANT) kept.push(out)
	}
	return kept.join('\n') || '(none)'
}

const entry = (data: string[], notes: string) => `Data:\n${data.join('\n')}\n\nNotes already taken:\n${notes}`

const out = resolve(import.meta.dirname, '../.data/leftover-prompt-lfm3', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const lines: string[] = [`# Leftover prompt, ${MODEL}, ${RUNS} runs\n`]

for (let run = 1; run <= RUNS; run++) {
	lines.push(`## Run ${run}\n`)
	const notes: string[] = []
	for (const c of cases) {
		const n = await notesFor(c)
		notes.push(n)
		const left = await call(`leftover:${c.id}`, SINGLE_SYSTEM, entry(c.data, n))
		lines.push(`### ${c.id} (neurons: ${c.neurons.join(', ')})\n`, `Expected: ${c.expected}\n`, 'Notes kept:', '```text', n, '```', 'Leftover (single):', '```text', left, '```\n')
		console.log(`[run ${run}] ${c.id}: ${left.replaceAll('\n', ' | ').slice(0, 160)}`)
	}
	const chunk = leftoverPrompt(cases.map((c, i) => entry(c.data, notes[i])))
	const chunkOut = await call('leftover:chunk', leftoverSystemPrompt, chunk)
	lines.push(`### Chunk of all ${cases.length} entries in one call\n`, `Expected: ${cases.map((c, i) => `Entry ${i + 1}: ${c.expected}`).join('; ')}\n`, '```text', chunkOut, '```\n')
	console.log(`[run ${run}] chunk: ${chunkOut.replaceAll('\n', ' | ').slice(0, 300)}`)
}

writeFileSync(resolve(out, 'answers.md'), `${lines.join('\n')}\n`)
writeFileSync(resolve(out, 'calls.json'), `${JSON.stringify(calls, null, 2)}\n`)
console.log(`\nSaved: ${out} (${calls.length} calls)`)
