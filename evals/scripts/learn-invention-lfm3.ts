/**
 * Does the two-step learn step add claims nobody said? (LFM3 on OpenRouter)
 *
 * Two standalone Neurons (coding, food) learn a few short inputs with known
 * facts, 3 batches each, one noise line per batch. Every extract and update
 * call is logged raw, so each claim in the memory can be traced to an input,
 * or to the extract or update step that invented it. Scored by hand. No LLM
 * judge.
 *
 * Run: set -a; source ../adapt-memory/.env.local; set +a
 *      npx tsx evals/scripts/learn-invention-lfm3.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	type AdaptLLMPlugin,
	createAiSdkLLM,
	MemoryNeuronStore,
	Neuron,
} from '../../src'

const MODEL = process.env.MODEL ?? 'liquid/lfm-3-1.7b'
const RUN = process.env.RUN ?? ''
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')

const neurons = [
	{
		id: 'coding',
		instructions: 'Track how I like to write code.',
		batches: [
			[
				'I always use strict TypeScript and avoid any.',
				'I write tests with vitest.',
				'It rained all day.',
			],
			['I use pnpm, not npm.', 'I name files in kebab-case.', 'My train was late.'],
			['I stopped using classes; I write plain functions now.', 'Watched a movie tonight.'],
		],
	},
	{
		id: 'food',
		instructions: 'Track what I like to eat.',
		batches: [
			[
				'I had oats with banana for breakfast.',
				"I'm trying to eat less meat.",
				'It rained all day.',
			],
			['Dinner was vegetarian ramen.', 'I want to try sushi this week.', 'My train was late.'],
			["I don't like spicy food.", 'Watched a movie tonight.'],
		],
	},
]

const provider = createOpenAICompatible({
	name: 'openrouter',
	baseURL: 'https://openrouter.ai/api/v1',
	apiKey,
})
const model = provider(MODEL)
const baseLLM = createAiSdkLLM({ providers: { openrouter: provider } })

interface Call {
	kind: 'extract' | 'update' | 'other'
	output: string
}

function logged(calls: Call[]): AdaptLLMPlugin {
	return {
		...baseLLM,
		async call(request) {
			const result = await baseLLM.call(request)
			const system = request.system ?? ''
			calls.push({
				kind: system.startsWith('Here is some data')
					? 'extract'
					: system.startsWith('Here is information extracted')
						? 'update'
						: 'other',
				output: result.text ?? '',
			})
			return result
		},
	} as AdaptLLMPlugin
}

async function settle(neuron: Neuron): Promise<void> {
	for (let i = 0; i < 60; i++) {
		const state = await neuron.getLearningState()
		if (state.pendingDeliveryIds.length === 0 && state.runningRunIds.length === 0) return
		await new Promise((r) => setTimeout(r, 2000))
		await neuron.flush()
	}
	throw new Error('learning did not settle')
}

async function run(spec: (typeof neurons)[number]): Promise<string> {
	const calls: Call[] = []
	const neuron = await Neuron.create({
		model,
		llm: logged(calls),
		instructions: spec.instructions,
		store: new MemoryNeuronStore(),
	})
	const lines = [`# ${spec.id}: ${spec.instructions}\n`]
	for (const [i, batch] of spec.batches.entries()) {
		const before = calls.length
		const result = await neuron.learn(batch)
		if (result.status === 'managed') await settle(neuron)
		lines.push(`## Batch ${i + 1} (${result.status})\n`, ...batch.map((x) => `- ${x}`), '')
		for (const c of calls.slice(before)) {
			lines.push(`### ${c.kind}\n`, '```text', c.output.trim(), '```', '')
		}
		console.log(`[${spec.id}] batch ${i + 1}: ${calls.slice(before).map((c) => c.kind).join('+')}`)
	}
	lines.push('## Final memory\n', '```text', (await neuron.getUnderstanding()).trim(), '```', '')
	await neuron.dispose()
	return lines.join('\n')
}

const out = resolve(
	import.meta.dirname,
	'../.data/learn-invention-lfm3',
	`${new Date().toISOString().replaceAll(':', '-')}${RUN}`,
)
mkdirSync(out, { recursive: true })
const reports = await Promise.all(neurons.map(run))
writeFileSync(resolve(out, 'report.md'), `Model: ${MODEL}\n\n${reports.join('\n')}`)
console.log(`Saved: ${out}/report.md`)
