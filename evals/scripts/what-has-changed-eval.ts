/**
 * Eval: when a neuron's memory is rewritten, does it keep "used to X, now Y"?
 *
 * 5 cases, one fact changes midway through a short stream. Per case and run:
 * Brain.create (autoSetup) -> 3 inject calls (before / change / after) -> every neuron's
 * final memory + ask('What changed about <topic>?'). Measured by substring: does the final
 * memory contain the old value, the new value, both. No LLM judge; read the raw logs.
 *
 * Run: npx tsx evals/scripts/what-has-changed-eval.ts   (LM Studio at localhost:1234, model lfm3-1.7b)
 * Env: RUNS=2, ONLY=<case id>, CLOUD=1 (OpenRouter liquid/lfm-3-1.7b, NOT on-device; key from OPENROUTER_API_KEY)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Brain, createAiSdkLLM, MemoryBrainStore } from '../../src'

interface Case {
	id: string
	prompt: string
	topic: string
	oldValue: string
	newValue: string
	/** three inject calls: before the change, the change, after the change */
	steps: [string[], string[], string[]]
}

const cases: Case[] = [
	{
		id: 'editor',
		prompt: 'Remember my coding tools and habits.',
		topic: 'my code editor',
		oldValue: 'Vim',
		newValue: 'Zed',
		steps: [
			['I have been using Vim for ten years and my keybindings are muscle memory.', 'Lunch was a chicken salad, nothing special.', 'Reminder: dentist appointment on the 14th.'],
			['Switched my editor from Vim to Zed this week, the multiplayer features won me over.', 'Train to Utrecht was delayed by 20 minutes again.'],
			['Zed starts faster than anything I used before.', 'Need to book flights for the conference in March.', 'Weather looks rainy all weekend.'],
		],
	},
	{
		id: 'diet',
		prompt: 'Track my health and eating habits.',
		topic: 'my diet',
		oldValue: 'vegetarian',
		newValue: 'fish',
		steps: [
			['I have been vegetarian for three years now.', 'Had lentil soup for dinner, very good.', 'My laptop battery is dying fast lately.'],
			['Doctor suggested more protein, so I eat fish again: salmon twice a week.', 'Parking near the office is getting impossible.'],
			['Grilled salmon tonight, tastes better than I remembered.', 'Call mom on Sunday.', 'Reading a book about sleep.'],
		],
	},
	{
		id: 'owner',
		prompt: 'Keep track of our team projects and who owns what.',
		topic: 'who owns the billing project',
		oldValue: 'Sara',
		newValue: 'Tom',
		steps: [
			['Sara owns the billing project and runs the weekly sync.', 'The office coffee machine is broken again.', 'Design review for the landing page is done.'],
			['Update: Sara moved to the mobile team. Tom is now the owner of the billing project.', 'Lunch order for Friday: pizza.'],
			['Tom set the billing launch date for December 3.', 'New laptops arrive next week.', 'Tom asked for a risk list by Wednesday.'],
		],
	},
	{
		id: 'meeting',
		prompt: 'Help me keep my calendar and recurring meetings straight.',
		topic: 'the weekly planning meeting day',
		oldValue: 'Monday',
		newValue: 'Thursday',
		steps: [
			['Weekly planning meeting is every Monday at 10:00.', 'Gym membership renews next month.', 'Flight to Berlin booked for the 22nd.'],
			['Planning meeting moved from Monday to Thursday, same time, starting next week.', 'Birthday dinner for Lena on Saturday.'],
			['Thursday planning meeting agenda: roadmap and hiring.', 'Water bill was higher than usual.', 'Bring the slides to Thursday planning.'],
		],
	},
	{
		id: 'language',
		prompt: 'Learn my programming preferences.',
		topic: 'my preferred programming language',
		oldValue: 'Python',
		newValue: 'Rust',
		steps: [
			['Python is my go-to language for everything, scripts and services.', 'Bought new running shoes today.', 'The cafe on Main Street closes at 6.'],
			['I rewrote my scraper in Rust and I now prefer Rust over Python for anything serious.', 'Dentist moved my appointment to the 16th.'],
			['Rust compile errors are annoying but they catch real bugs.', 'Tomorrow is trash day.', 'Planning a hiking weekend in the Alps.'],
		],
	},
]

const CLOUD = process.env.CLOUD === '1'
const RUNS = Number(process.env.RUNS ?? 2)
const MODEL = CLOUD ? 'liquid/lfm-3-1.7b' : 'lfm3-1.7b'
const apiKey = process.env.OPENROUTER_API_KEY
if (CLOUD && !apiKey) throw new Error('OPENROUTER_API_KEY is required for CLOUD=1')

const provider = CLOUD
	? createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey, supportsStructuredOutputs: true })
	: createOpenAICompatible({ name: 'lmstudio', baseURL: 'http://localhost:1234/v1', supportsStructuredOutputs: true })
const providerName = CLOUD ? 'openrouter' : 'lmstudio'

const out = resolve(import.meta.dirname, '../.data/what-has-changed', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const started = Date.now()
const t = () => ((Date.now() - started) / 1000).toFixed(0)
const has = (text: string, value: string) => text.toLowerCase().includes(value.toLowerCase())

const summary: unknown[] = []
for (const c of cases.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
	for (let run = 1; run <= RUNS; run++) {
		console.log(`[${t()}s] ${c.id} run ${run}`)
		const log: unknown[] = []
		const store = new MemoryBrainStore()
		const brain = await Brain.create({
			prompt: c.prompt,
			model: provider(MODEL),
			llm: createAiSdkLLM({ providers: { [providerName]: provider } }),
			store,
			autoSetup: true,
			evolution: { enabled: false },
		})
		brain.on((event) => log.push(event))
		const errors: string[] = []
		for (const [i, step] of c.steps.entries()) {
			try {
				await brain.inject(step)
			} catch (e) {
				errors.push(`inject ${i}: ${String(e)}`)
			}
			console.log(`[${t()}s]   inject ${i + 1}/3 done`)
		}
		const memories: Record<string, string> = {}
		for (const n of brain.getNeurons()) memories[n.id] = String(await n.getUnderstanding())
		let answer: unknown = null
		try {
			answer = await brain.ask(`What changed about ${c.topic}?`)
		} catch (e) {
			errors.push(`ask: ${String(e)}`)
		}
		const all = Object.values(memories).join('\n')
		const hasOld = has(all, c.oldValue)
		const hasNew = has(all, c.newValue)
		const row = { case: c.id, run, model: MODEL, cloud: CLOUD, oldValue: c.oldValue, newValue: c.newValue, hasOld, hasNew, both: hasOld && hasNew, memories, answer, errors, steps: c.steps, seconds: Number(t()) }
		summary.push({ case: c.id, run, hasOld, hasNew, both: hasOld && hasNew })
		writeFileSync(resolve(out, `${c.id}-run${run}.json`), `${JSON.stringify(row, null, 2)}\n`)
		writeFileSync(resolve(out, `${c.id}-run${run}-events.json`), `${JSON.stringify(log, null, 2)}\n`)
		console.log(`[${t()}s]   old=${hasOld} new=${hasNew} both=${hasOld && hasNew}`)
		await brain.dispose()
	}
}
writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(`Saved: ${out}  (${t()}s)`)
