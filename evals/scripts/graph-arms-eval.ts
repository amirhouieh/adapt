/**
 * Graph arms eval, arm 0: text neurons only, as today.
 *
 * A Brain with two text neurons (kitchen, household) gets the inputs of
 * evals/datasets/graph-arms.json in order, in batches of 3. Then every question
 * is asked once with brain.ask. Every model call is logged. No LLM judge: read
 * the answers in answers.md against `expected` and `wrong`.
 *
 * Run: export OPENROUTER_API_KEY=... && npx tsx evals/scripts/graph-arms-eval.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { type AdaptLLMPlugin, Brain, createAiSdkLLM, MemoryBrainStore } from '../../src'
import { estimateTokens } from '../../src/neurons/text/strategies'

interface Dataset {
	neurons: Array<{ topic: string; purpose: string }>
	inputs: Array<{ id: string; topic: string; text: string }>
	questions: Array<{ id: string; scenarios: number[]; question: string; expected: string; wrong: string[] }>
}

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const BATCH = 3
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')

const dataset = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '../datasets/graph-arms.json'), 'utf8'),
) as Dataset

const provider = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey,
	supportsStructuredOutputs: true,
})
const baseLLM = createAiSdkLLM({ providers: { openrouter: provider } })

interface Call {
	phase: 'learn' | 'ask'
	system: string
	prompt: string
	output: string
	seconds: number
}
const calls: Call[] = []
let phase: Call['phase'] = 'learn'

const textOf = (content: unknown): string =>
	typeof content === 'string' ? content : JSON.stringify(content)

const llm = {
	...baseLLM,
	async call(request) {
		const started = Date.now()
		const result = await baseLLM.call(request)
		calls.push({
			phase,
			system: request.system ?? '',
			prompt: request.messages.map((m) => textOf(m.content)).join('\n'),
			output: result.text ?? '',
			seconds: (Date.now() - started) / 1000,
		})
		return result
	},
} as AdaptLLMPlugin

const out = resolve(
	import.meta.dirname,
	'../.data/graph-arms',
	`arm0-${new Date().toISOString().replaceAll(':', '-')}`,
)
mkdirSync(out, { recursive: true })
const started = Date.now()
const t = () => ((Date.now() - started) / 1000).toFixed(0)

const brain = await Brain.create({
	prompt: 'Track my kitchen renovation and my household admin.',
	model: provider(MODEL),
	llm,
	store: new MemoryBrainStore(),
	autoSetup: false,
	neurons: dataset.neurons.map((n) => ({
		id: n.topic,
		type: 'text' as const,
		name: n.topic,
		description: n.purpose,
		instructions: `Track: ${n.purpose}`,
	})),
	evolution: { enabled: false },
	ingest: { batchSize: BATCH },
})

const texts = dataset.inputs.map((i) => i.text)
for (let i = 0; i < texts.length; i += BATCH) {
	await brain.inject(texts.slice(i, i + BATCH))
	console.log(`[${t()}s] injected ${Math.min(i + BATCH, texts.length)}/${texts.length}`)
}

const memories: Record<string, string> = {}
for (const n of brain.getNeurons()) memories[n.id] = String(await n.getUnderstanding())
const learnCalls = calls.length

phase = 'ask'
const answers: Array<{ id: string; question: string; answer: string; sources: unknown }> = []
for (const q of dataset.questions) {
	try {
		const r = await brain.ask(q.question)
		answers.push({ id: q.id, question: q.question, answer: r.insight, sources: r.sources })
	} catch (error) {
		answers.push({ id: q.id, question: q.question, answer: `ERROR: ${String(error)}`, sources: [] })
	}
	console.log(`[${t()}s] ${q.id}: ${answers.at(-1)?.answer.slice(0, 120)}`)
}
await brain.dispose()

const summary = {
	arm: 0,
	model: MODEL,
	batch: BATCH,
	calls: { learn: learnCalls, ask: calls.length - learnCalls },
	memoryTokens: Object.fromEntries(Object.entries(memories).map(([k, v]) => [k, estimateTokens(v)])),
	seconds: (Date.now() - started) / 1000,
}

const md = [
	`# Arm 0 answers (${MODEL})\n`,
	'```json', JSON.stringify(summary, null, 2), '```\n',
	...dataset.questions.flatMap((q) => [
		`## ${q.id} [scenarios ${q.scenarios.join(', ')}] ${q.question}\n`,
		`- Expected: ${q.expected}`,
		`- Wrong: ${q.wrong.join(' | ')}`,
		`- Answer: ${answers.find((a) => a.id === q.id)?.answer.trim()}\n`,
	]),
	...Object.entries(memories).flatMap(([id, text]) => [`## Memory: ${id}\n`, '```text', text.trim(), '```\n']),
].join('\n')

writeFileSync(resolve(out, 'answers.md'), md)
writeFileSync(resolve(out, 'result.json'), `${JSON.stringify({ summary, answers, memories, calls }, null, 2)}\n`)
console.log(`\n${JSON.stringify(summary)}\nSaved: ${out}`)
