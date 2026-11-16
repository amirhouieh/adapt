/**
 * Learning eval, cases 1 and 2 (internal C verdict, "smallest first experiment").
 *
 * Generator: a 30-day stream of dated notes. Truth is known by code.
 *   case 1  coffee  -> coffee on 2, 8 or 22 mornings, never called a habit
 *   case 2  sushi   -> sushi dinner on 1 or 10 days
 * Unrelated notes (1-2 per day) are mixed in. Each run uses its own seed (days, wording, order of options).
 *
 * Arms (same model, same question text):
 *   adapt  Brain.create(autoSetup) -> inject(all notes, in date order) -> flush every neuron -> brain.ask(question)
 *   full   one chat call: all notes + the same question (recall ceiling for a short stream)
 *
 * Scoring: forced choice, options shuffled per run, answer = the letter. Exact match. No LLM judge.
 * Chance is 1/options. Raw logs: evals/.data/learning-eval-cases-1-2/<timestamp>/.
 *
 * Run: npx tsx evals/scripts/learning-eval-cases-1-2.ts   (LM Studio at localhost:1234, model lfm3-1.7b)
 * Env: RUNS=4, ONLY=<cell id>, ARMS=adapt,full, CLOUD=1 (OpenRouter liquid/lfm-3-1.7b; key from OPENROUTER_API_KEY)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Brain, createAiSdkLLM, MemoryBrainStore } from '../../src'

// ---------- generator ----------

/** small deterministic PRNG (mulberry32) */
function rng(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
type Rand = () => number
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
function shuffle<T>(r: Rand, xs: readonly T[]): T[] {
	const a = [...xs]
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1))
		;[a[i], a[j]] = [a[j], a[i]]
	}
	return a
}
/** k distinct day indexes out of n */
const chooseDays = (r: Rand, n: number, k: number) => new Set(shuffle(r, [...Array(n).keys()]).slice(0, k))

const COFFEE = [
	'Made a pour-over before opening email.',
	'Flat white from the corner cafe on the way in.',
	'Espresso at the kitchen counter, then the train.',
	'Had a cappuccino while reading the news.',
	'French press coffee, then a call with the design team.',
	'Grabbed an oat latte before standup.',
	'Coffee and toast, then off to the office.',
]
const SUSHI = [
	'Dinner: sushi from the place near the station.',
	'Ordered salmon nigiri and a tuna roll for dinner.',
	'Sushi takeaway tonight, eaten on the balcony.',
	'Went out for sushi with Lena after work.',
	'Dinner was a sushi platter, too much wasabi.',
]
const MORNING_FILLER = [
	'Morning run along the canal, 5 km.',
	'Slept badly, the neighbours were loud.',
	'Fixed the flaky login test first thing.',
	'Train was 15 minutes late.',
	'Walked the long way to the office, nice weather.',
	'Read two chapters of the sleep book in bed.',
	'Stretching and a quick shower, then work.',
]
const DAY_FILLER = [
	'Lunch: chicken salad at my desk.',
	'Planning meeting ran over by half an hour.',
	'Paid the water bill, higher than usual.',
	'Code review for the billing service took all afternoon.',
	'Called mom, she wants to visit in December.',
	'Booked the dentist for the 14th.',
	'Bought new running shoes.',
	'Rainy all afternoon, stayed inside.',
	'Wrote the quarterly report draft.',
	'Gym after work: legs and core.',
	'Fixed the bike light.',
	'Long call with the payments vendor.',
]
const DINNER_FILLER = [
	'Dinner: lentil soup and bread.',
	'Made pasta with tomato sauce for dinner.',
	'Dinner was a burrito bowl from the Mexican place.',
	'Cooked a vegetable curry tonight.',
	'Pizza night with friends.',
	'Dinner: grilled chicken and rice.',
]

const START = Date.UTC(2026, 9, 5) // Mon 2026-10-05
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function stamp(day: number, time: string) {
	const d = new Date(START + day * 86_400_000)
	return `${WEEKDAY[d.getUTCDay()]} ${d.toISOString().slice(0, 10)} ${time}`
}

interface Option {
	key: string
	text: string
}
interface Cell {
	id: string
	caseNo: 1 | 2
	target: 'coffee' | 'sushi'
	days: number
	question: string
	options: Option[]
	gold: string
}

const COFFEE_OPTIONS: Option[] = [
	{ key: 'never', text: 'never' },
	{ key: 'rarely', text: 'rarely (a few times a month or less)' },
	{ key: 'sometimes', text: 'sometimes (one to three days a week)' },
	{ key: 'most', text: 'most days' },
	{ key: 'unknown', text: 'not known' },
]
const SUSHI_OPTIONS: Option[] = [
	{ key: 'regular', text: 'I eat it regularly' },
	{ key: 'once', text: 'I tried it once' },
	{ key: 'never', text: 'sushi is never mentioned' },
]

const CELLS: Cell[] = [
	...([2, 8, 22] as const).map((days) => ({
		id: `coffee-${days}`,
		caseNo: 1 as const,
		target: 'coffee' as const,
		days,
		question: 'How often do I have coffee in the morning?',
		options: COFFEE_OPTIONS,
		gold: days === 2 ? 'rarely' : days === 8 ? 'sometimes' : 'most',
	})),
	...([1, 10] as const).map((days) => ({
		id: `sushi-${days}`,
		caseNo: 2 as const,
		target: 'sushi' as const,
		days,
		question: 'Sushi: which is true?',
		options: SUSHI_OPTIONS,
		gold: days === 1 ? 'once' : 'regular',
	})),
]

/** 30 days of dated notes; target on `cell.days` distinct days. */
function generateStream(cell: Cell, seed: number): string[] {
	const r = rng(seed)
	const targetDays = chooseDays(r, 30, cell.days)
	const notes: string[] = []
	for (let day = 0; day < 30; day++) {
		const morning = cell.target === 'coffee' && targetDays.has(day)
		const dinner = cell.target === 'sushi' && targetDays.has(day)
		if (morning) notes.push(`${stamp(day, '07:40')}: ${pick(r, COFFEE)}`)
		else if (r() < 0.5) notes.push(`${stamp(day, '07:40')}: ${pick(r, MORNING_FILLER)}`)
		notes.push(`${stamp(day, '13:15')}: ${pick(r, DAY_FILLER)}`)
		if (dinner) notes.push(`${stamp(day, '19:30')}: ${pick(r, SUSHI)}`)
		else if (r() < 0.5) notes.push(`${stamp(day, '19:30')}: ${pick(r, DINNER_FILLER)}`)
	}
	return notes
}

const LETTERS = 'ABCDE'
function buildQuestion(cell: Cell, seed: number) {
	const order = shuffle(rng(seed * 7 + 1), cell.options)
	const lines = order.map((o, i) => `${LETTERS[i]}) ${o.text}`)
	const text = `${cell.question}\n${lines.join('\n')}\nAnswer with the letter only.`
	return { text, order }
}

/** First standalone letter A-E; else a unique option text in the reply. Null = unparsed (scored wrong). */
function parseChoice(reply: string, order: Option[]): string | null {
	const m = reply.match(/\b([A-E])\b(?:\)|\.|:|\s|$)/)
	if (m) {
		const i = LETTERS.indexOf(m[1])
		if (i < order.length) return order[i].key
	}
	const hits = order.filter((o) => reply.toLowerCase().includes(o.text.toLowerCase()))
	return hits.length === 1 ? hits[0].key : null
}

// ---------- runner ----------

const CLOUD = process.env.CLOUD === '1'
const RUNS = Number(process.env.RUNS ?? 4)
const ARMS = (process.env.ARMS ?? 'full,adapt').split(',')
const MODEL = CLOUD ? 'liquid/lfm-3-1.7b' : 'lfm3-1.7b'
const BASE_URL = CLOUD ? 'https://openrouter.ai/api/v1' : 'http://localhost:1234/v1'
const apiKey = process.env.OPENROUTER_API_KEY
if (CLOUD && !apiKey) throw new Error('OPENROUTER_API_KEY is required for CLOUD=1')
const providerName = CLOUD ? 'openrouter' : 'lmstudio'
const provider = createOpenAICompatible({ name: providerName, baseURL: BASE_URL, apiKey, supportsStructuredOutputs: true })

const BRAIN_PROMPT = 'Learn about my daily life from my notes.'
const FULL_SYSTEM = 'You answer questions about the user from their notes.'

/** Streamed, so a long reasoning phase does not hit Node's 300 s header timeout. */
async function fullContext(notes: string[], question: string) {
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(apiKey && CLOUD ? { authorization: `Bearer ${apiKey}` } : {}) },
		body: JSON.stringify({
			model: MODEL,
			stream: true,
			stream_options: { include_usage: true },
			messages: [
				{ role: 'system', content: FULL_SYSTEM },
				{ role: 'user', content: `My notes:\n${notes.join('\n')}\n\n${question}` },
			],
		}),
	})
	if (!res.ok || !res.body) return { reply: '', raw: { status: res.status, body: await res.text() } }
	let reply = ''
	let reasoning = ''
	let finish: string | null = null
	let usage: unknown = null
	let buffer = ''
	const errors: string[] = []
	const decoder = new TextDecoder()
	for await (const chunk of res.body) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true })
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) {
			const data = line.startsWith('data: ') ? line.slice(6).trim() : ''
			if (!data || data === '[DONE]') continue
			const ev = JSON.parse(data) as {
				error?: unknown
				usage?: unknown
				choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[]
			}
			if (ev.error) errors.push(JSON.stringify(ev.error))
			if (ev.usage) usage = ev.usage
			const c = ev.choices?.[0]
			reply += c?.delta?.content ?? ''
			reasoning += c?.delta?.reasoning_content ?? ''
			if (c?.finish_reason) finish = c.finish_reason
		}
	}
	return { reply, raw: { finish, usage, errors, reasoning } }
}

const out = resolve(import.meta.dirname, '../.data/learning-eval-cases-1-2', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(out, { recursive: true })
const started = Date.now()
const t = () => ((Date.now() - started) / 1000).toFixed(0)

const summary: unknown[] = []
for (const cell of CELLS.filter((c) => !process.env.ONLY || c.id === process.env.ONLY)) {
	for (let run = 1; run <= RUNS; run++) {
		const seed = cell.days * 1000 + cell.caseNo * 100 + run
		const notes = generateStream(cell, seed)
		const q = buildQuestion(cell, seed)
		const notesBytes = Buffer.byteLength(notes.join('\n'))
		for (const arm of ARMS) {
			console.log(`[${t()}s] ${cell.id} run ${run} ${arm} (${notes.length} notes)`)
			const errors: string[] = []
			let reply = ''
			let raw: unknown = null
			const flushes: unknown[] = []
			let memories: Record<string, string> = {}
			const events: unknown[] = []
			const armStart = Date.now()
			if (arm === 'full') {
				try {
					;({ reply, raw } = await fullContext(notes, q.text))
				} catch (e) {
					errors.push(String(e))
				}
			} else {
				const brain = await Brain.create({
					prompt: BRAIN_PROMPT,
					model: provider(MODEL),
					llm: createAiSdkLLM({ providers: { [providerName]: provider } }),
					store: new MemoryBrainStore(),
					autoSetup: true,
					evolution: { enabled: false },
				})
				brain.on((event) => events.push(event))
				try {
					await brain.inject(notes)
				} catch (e) {
					errors.push(`inject: ${String(e)}`)
				}
				// later batches are queued for later; flush so every note is learned before ask
				for (const n of brain.getNeurons()) {
					try {
						flushes.push({ neuron: n.id, runs: (await n.flush()).runs })
					} catch (e) {
						errors.push(`flush ${n.id}: ${String(e)}`)
					}
				}
				for (const n of brain.getNeurons()) memories[n.id] = String(await n.getUnderstanding())
				try {
					reply = (await brain.ask(q.text)).insight
				} catch (e) {
					errors.push(`ask: ${String(e)}`)
				}
				await brain.dispose()
			}
			const choice = parseChoice(reply, q.order)
			const correct = choice === cell.gold
			const storedBytes = arm === 'full' ? notesBytes : Buffer.byteLength(Object.values(memories).join('\n'))
			const seconds = Math.round((Date.now() - armStart) / 1000)
			const row = { cell: cell.id, caseNo: cell.caseNo, days: cell.days, run, seed, arm, model: MODEL, provider: providerName, gold: cell.gold, choice, correct, chance: 1 / cell.options.length, reply, raw, flushes, question: q.text, order: q.order.map((o) => o.key), memories, storedBytes, notesBytes, errors, seconds, notes }
			summary.push({ cell: cell.id, run, arm, gold: cell.gold, choice, correct, storedBytes, seconds, errors: errors.length })
			writeFileSync(resolve(out, `${cell.id}-run${run}-${arm}.json`), `${JSON.stringify(row, null, 2)}\n`)
			if (events.length) writeFileSync(resolve(out, `${cell.id}-run${run}-${arm}-events.json`), `${JSON.stringify(events, null, 2)}\n`)
			writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
			console.log(`[${t()}s]   gold=${cell.gold} choice=${choice} correct=${correct} bytes=${storedBytes} ${seconds}s`)
		}
	}
}
console.log(`Saved: ${out}  (${t()}s)`)
