/**
 * Memory strategies on a real model (LFM3 on OpenRouter).
 *
 * Three standalone TextNeurons learn the same 24 dated facts (kitchen
 * renovation, with changes over time) in batches of 4:
 * - continuous (control: no compression)
 * - cumulative (over maxTokens → seed)
 * - decay (at 80% of maxTokens → Current / Recent / Historical)
 *
 * maxTokens is small (default 300, env MAX_TOKENS) so the memory grows past it
 * and the strategies run. Every model call is logged per neuron, so the memory
 * right before a strategy call (= update output) and right after (= strategy
 * output) can be read against the inputs. No LLM judge.
 *
 * Run: export OPENROUTER_API_KEY=... && npx tsx evals/scripts/two-step-strategies-lfm3.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	type AdaptLLMPlugin,
	createAiSdkLLM,
	MemoryNeuronStore,
	TextNeuron,
} from '../../src'
import { estimateTokens, type Strategy } from '../../src/neurons/text/strategies'

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 300)
const RUN = process.env.RUN ?? ''
const BATCH = 4
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')

const inputs = [
	'2026-01-05: Kitchen renovation budget set at 18,000 euro.',
	'2026-01-07: Contractor chosen: Bouwbedrijf De Vries, contact person Pieter de Vries.',
	'2026-01-10: Cabinets will be white oak, made by a local carpenter, Sanne Bakker.',
	'2026-01-12: Countertop: grey quartz, 2,400 euro.',
	'2026-01-20: Demolition scheduled for 3 February.',
	'2026-01-22: Electrician is Mo Haddad; he will add 6 new sockets.',
	'2026-02-03: Demolition done on time.',
	'2026-02-05: Found water damage under the sink; repair costs 1,100 euro.',
	'2026-02-09: Budget raised to 19,500 euro because of the water damage.',
	'2026-02-14: Floor: grey tiles 60x60, 1,800 euro.',
	'2026-02-18: Countertop changed from grey quartz to black granite, 2,900 euro.',
	'2026-02-20: Plumber is Lotte Visser; she will move the sink 1 meter to the left.',
	'2026-02-25: Cabinet delivery delayed from 1 March to 15 March.',
	'2026-03-02: Oven: Bosch built-in, 950 euro.',
	'2026-03-05: Mo Haddad finished the electrical work: the 6 sockets plus 2 extra.',
	'2026-03-15: Cabinets delivered by Sanne Bakker.',
	'2026-03-18: Pieter de Vries is on leave; his colleague Ruud Smit is now our contact.',
	'2026-03-22: Black granite countertop installed.',
	'2026-03-25: Paint color chosen: warm white (RAL 9010).',
	'2026-03-28: Budget now 20,300 euro after the extra sockets and paint.',
	'2026-04-02: Fridge: Liebherr, 1,300 euro.',
	'2026-04-06: Final inspection set for 20 April.',
	'2026-04-10: Small crack found in one floor tile; Ruud Smit will replace it.',
	'2026-04-20: Final inspection passed. One open item: the cracked tile replacement.',
]

const provider = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey,
	supportsStructuredOutputs: true,
})
const model = provider(MODEL)
const baseLLM = createAiSdkLLM({ providers: { openrouter: provider } })

type Kind = 'extract' | 'update' | 'shorten' | 'other'
interface Call {
	kind: Kind
	prompt: string
	output: string
	seconds: number
}

function textOf(content: unknown): string {
	if (typeof content === 'string') return content
	return JSON.stringify(content)
}

function kindOf(system: string): Kind {
	if (system.startsWith('Here is some data')) return 'extract'
	if (system.startsWith('Here is information extracted')) return 'update'
	if (system.startsWith('Here is our understanding of this topic')) return 'shorten'
	return 'other'
}

/** Same plugin, but every call is written to `calls`. */
function logged(calls: Call[]): AdaptLLMPlugin {
	return {
		...baseLLM,
		async call(request) {
			const started = Date.now()
			const result = await baseLLM.call(request)
			const system = request.system ?? ''
			const prompt = request.messages.map((m) => textOf(m.content)).join('\n')
			calls.push({
				kind: kindOf(system),
				prompt,
				output: result.text ?? '',
				seconds: (Date.now() - started) / 1000,
			})
			return result
		},
	} as AdaptLLMPlugin
}

interface Step {
	batch: number
	inputs: string[]
	status: string
	calls: Call[]
	memory: string
	memoryTokens: number
}

async function settle(neuron: TextNeuron): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const state = await neuron.getLearningState()
		if (state.pendingDeliveryIds.length === 0 && state.runningRunIds.length === 0) return
		await new Promise((r) => setTimeout(r, 2000))
		await neuron.flush()
	}
	throw new Error('learning did not settle in 4 minutes')
}

async function run(strategy: Strategy): Promise<Step[]> {
	const calls: Call[] = []
	const neuron = await TextNeuron.create({
		model,
		llm: logged(calls),
		instructions:
			'Track my kitchen renovation: budget, people, choices, dates and problems.',
		store: new MemoryNeuronStore(),
		governance: { strategy, maxTokens: MAX_TOKENS },
	})
	const gov = neuron.getGovernance()
	if (gov.strategy !== strategy || gov.maxTokens !== MAX_TOKENS)
		throw new Error(`governance not set: ${JSON.stringify(gov)}`)
	const steps: Step[] = []
	for (let i = 0; i < inputs.length; i += BATCH) {
		const batch = inputs.slice(i, i + BATCH)
		const before = calls.length
		const result = await neuron.learn(batch)
		// A failed run is retried later; learn() then returns 'managed' and
		// queues. Wait until nothing is pending so every input is learned.
		if (result.status === 'managed') await settle(neuron)
		const memory = await neuron.getUnderstanding()
		const step: Step = {
			batch: i / BATCH + 1,
			inputs: batch,
			status: result.status,
			calls: calls.slice(before),
			memory,
			memoryTokens: estimateTokens(memory),
		}
		steps.push(step)
		console.log(
			`[${strategy}] batch ${step.batch}: ${step.status}, calls ${step.calls.map((c) => c.kind).join('+')}, memory ~${step.memoryTokens} tokens`,
		)
	}
	await neuron.dispose()
	return steps
}

function report(strategy: Strategy, steps: Step[]): string {
	const lines = [`# ${strategy}\n`]
	for (const s of steps) {
		lines.push(`## Batch ${s.batch} — ${s.status}, memory ~${s.memoryTokens} tokens\n`)
		lines.push('Inputs:', ...s.inputs.map((x) => `- ${x}`), '')
		for (const c of s.calls) {
			if (c.kind === 'extract') continue
			const label =
				c.kind === 'update'
					? 'Update output (memory before strategy)'
					: `${strategy} ${c.kind} output (memory after strategy)`
			lines.push(`### ${label}, ~${estimateTokens(c.output)} tokens, ${c.seconds.toFixed(0)}s\n`)
			lines.push('```text', c.output.trim(), '```', '')
		}
	}
	lines.push('## Final memory\n', '```text', steps.at(-1)?.memory.trim() ?? '', '```', '')
	return lines.join('\n')
}

const out = resolve(
	import.meta.dirname,
	'../.data/two-step-strategies-lfm3',
	`${new Date().toISOString().replaceAll(':', '-')}${RUN}`,
)
mkdirSync(out, { recursive: true })
const started = Date.now()
const strategies = (process.env.STRATEGIES ?? 'continuous,cumulative,decay').split(',') as Strategy[]
const results = await Promise.all(strategies.map(run))
for (const [i, strategy] of strategies.entries()) {
	writeFileSync(resolve(out, `${strategy}.md`), report(strategy, results[i]))
}
writeFileSync(
	resolve(out, 'result.json'),
	`${JSON.stringify({ model: MODEL, maxTokens: MAX_TOKENS, batch: BATCH, inputs, results: Object.fromEntries(strategies.map((s, i) => [s, results[i]])), seconds: (Date.now() - started) / 1000 }, null, 2)}\n`,
)
console.log(`\nSaved: ${out}  (${((Date.now() - started) / 1000).toFixed(0)}s)`)
