/**
 * Eval: ai-sdk plugin smoke test (lean per-provider compatibility check)
 *
 * Strip the brain pipeline out. Three minimal LLM calls per preset that
 * collectively exercise every Zod feature and tool-calling pattern Adapt
 * uses anywhere in src/:
 *
 *   A. Schema breadth — one "kitchen-sink" structured-output schema that is
 *      a SUPERSET of every Output.object schema in Adapt.
 *   B. Tool-calling breadth — multiple tools with varied input shapes,
 *      run in a `toolChoice: 'required'` loop.
 *   C. Combo — schema breadth call wrapped in providerOptions strict-off
 *      (only honored by @ai-sdk/openai; skipped on every other preset).
 *
 * If A + B + C all pass, every real schema/tool in Adapt will pass on this
 * preset.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/llm-plugin-smoke-eval.ts
 *
 * Filter / list / add presets — see evals/scripts/_presets.ts.
 */

import { generateObject, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import {
	type Preset,
	handleListMode,
	selectPresets,
} from './_presets'

// ─── Eval A: kitchen-sink structured output schema ─────────────────────────
export const kitchenSinkSchema = z.object({
	id: z.string().describe('Unique identifier'),
	score: z.number().min(0).max(1).describe('Score between 0 and 1'),
	count: z.number().int().min(1).describe('Positive integer count'),
	flag: z.boolean().describe('Boolean flag'),
	tagline: z.string().nullable().describe('Optional tagline (null if none)'),
	status: z.enum(['active', 'paused', 'done']).describe('Discrete status'),
	tags: z.array(z.string()).describe('Array of string tags'),
	meta: z
		.object({
			author: z.string().describe('Author name'),
			revision: z.number().int().describe('Revision number'),
		})
		.describe('Nested metadata'),
	items: z
		.array(
			z.object({
				name: z.string().describe('Item name'),
				kind: z.enum(['a', 'b', 'c']).describe('Item kind'),
				note: z.string().nullable().describe('Optional note (null if none)'),
			}),
		)
		.min(2)
		.describe('Array of 2 or more items'),
})

// ─── Eval B: kitchen-sink tool-calling ─────────────────────────────────────
export function buildTools() {
	const log: string[] = []
	const tools = {
		ping: tool({
			description: 'Ping the system. Use once at the start.',
			inputSchema: z.object({}),
			execute: async () => {
				log.push('ping')
				return { ok: true }
			},
		}),
		echo: tool({
			description: 'Echo a string. Use once after ping.',
			inputSchema: z.object({
				text: z.string().describe('Text to echo'),
			}),
			execute: async ({ text }) => {
				log.push(`echo:${text}`)
				return { echoed: text }
			},
		}),
		classify: tool({
			description: 'Classify with a level. Use once after echo.',
			inputSchema: z.object({
				level: z.enum(['low', 'medium', 'high']),
				note: z.string().nullable().describe('Optional note (null if none)'),
			}),
			execute: async ({ level, note }) => {
				log.push(`classify:${level}:${note ?? 'null'}`)
				return { classified: level }
			},
		}),
		complete: tool({
			description: 'Call when done with the sequence above.',
			inputSchema: z.object({
				summary: z.string().describe('Brief summary'),
				severity: z.enum(['routine', 'notable', 'critical']),
			}),
		}),
	}
	return { tools, log }
}

// ─── Eval D: size-scaled structured output ────────────────────────────────
//
// Mirrors the size of brainDecompositionSchema — array.min(N) of objects with
// long `instructions` strings. Catches providers (e.g. Together DeepSeek-V3.1)
// that accept a schema in principle but truncate output once the payload grows.

export const sizedSchema = z.object({
	neurons: z
		.array(
			z.object({
				id: z.string().describe('kebab-case id'),
				name: z.string().describe('Human-readable display name'),
				description: z
					.string()
					.describe(
						'Brief description of what this neuron tracks, used for query routing',
					),
				instructions: z
					.string()
					.describe(
						'Multi-paragraph instructions: a core understanding directive, ' +
							'a Watch-for list of 3+ specific conditions, and a Track-answers-to ' +
							'list of 3+ questions. At least 8 sentences total — long enough ' +
							'that a provider with weak output enforcement might truncate.',
					),
				focus: z.string().nullable().describe('Optional focus area (null if none)'),
				type: z.enum(['text']).describe('Neuron type'),
			}),
		)
		.min(3)
		.describe('Three or more neuron configs'),
})

// ─── Eval E: stateful tool flow ────────────────────────────────────────────
//
// Mirrors ToolBasedMethod's contract: model MUST call generateResponse first
// (its `response` field is the answer the host extracts), THEN complete.
// If the model skips generateResponse and goes straight to complete, the host
// has no answer. This catches the gpt-4o-mini case the pipeline eval surfaced.

export function buildStatefulTools() {
	let captured: string | null = null
	const tools = {
		generateResponse: tool({
			description:
				'Formulate the answer. Call this BEFORE complete. ' +
				'Your `response` field is the actual answer — complete carries no answer.',
			inputSchema: z.object({
				response: z.string().describe('The answer to the question'),
			}),
			execute: async ({ response }) => {
				captured = response
				return { ok: true }
			},
		}),
		complete: tool({
			description:
				'Finalize the query. Call this AFTER generateResponse. ' +
				'Provides metadata only — no answer text here.',
			inputSchema: z.object({
				confidence: z.number().min(0).max(1).describe('Confidence 0..1'),
			}),
			// no execute — terminal
		}),
	}
	return { tools, getCaptured: () => captured }
}

// ─── Cases ─────────────────────────────────────────────────────────────────

interface Result {
	preset: string
	a: { status: 'pass' | 'fail' | 'skip'; detail?: string }
	b: { status: 'pass' | 'fail' | 'skip'; detail?: string }
	c: { status: 'pass' | 'fail' | 'skip'; detail?: string }
	d: { status: 'pass' | 'fail' | 'skip'; detail?: string }
	e: { status: 'pass' | 'fail' | 'skip'; detail?: string }
}

async function runPreset(preset: Preset, apiKey: string): Promise<Result> {
	console.log(`\n${'━'.repeat(72)}`)
	console.log(`Preset: ${preset.id}`)
	console.log('━'.repeat(72))

	const { model } = await preset.build(apiKey)
	const result: Result = {
		preset: preset.id,
		a: { status: 'skip' },
		b: { status: 'skip' },
		c: { status: 'skip' },
		d: { status: 'skip' },
		e: { status: 'skip' },
	}

	console.log('\n[A] kitchen-sink structured output')
	try {
		const t0 = Date.now()
		const { object } = await generateObject({
			model,
			schema: kitchenSinkSchema,
			prompt:
				'Produce an example object: id="abc", score=0.7, count=3, flag=true, tagline=null, status=active, ' +
				'tags=["x","y"], meta with author "alice" and revision 2, items=[{name=foo,kind=a,note=null},{name=bar,kind=b,note="hi"}].',
		})
		console.log(`  ✓ pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
		console.log(`  output: ${JSON.stringify(object).slice(0, 200)}…`)
		result.a = { status: 'pass' }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.log(`  ✗ FAIL: ${msg.slice(0, 200)}`)
		result.a = { status: 'fail', detail: msg.slice(0, 200) }
	}

	console.log('\n[B] kitchen-sink tool-calling')
	try {
		const t0 = Date.now()
		const { tools, log } = buildTools()
		await generateText({
			model,
			tools,
			toolChoice: 'required',
			stopWhen: stepCountIs(8),
			prompt:
				'Run this sequence: call ping, then echo with text="ok", then classify with level=medium and note=null, ' +
				'then complete with summary="done" and severity="routine".',
		})
		console.log(`  ✓ pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
		console.log(`  tool calls: ${log.join(' → ')} → complete`)
		result.b = { status: 'pass' }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.log(`  ✗ FAIL: ${msg.slice(0, 200)}`)
		result.b = { status: 'fail', detail: msg.slice(0, 200) }
	}

	if (!preset.supportsStrictOff) {
		console.log('\n[C] strictJsonSchema:false — n/a (OpenAI-only)')
		result.c = { status: 'skip' }
	} else {
		console.log('\n[C] structured output with strictJsonSchema:false (OpenAI escape hatch)')
		try {
			const t0 = Date.now()
			const { object } = await generateObject({
				model,
				schema: kitchenSinkSchema,
				prompt:
					'Produce a different example object — any valid values that match the schema.',
				providerOptions: { openai: { strictJsonSchema: false } },
			})
			console.log(`  ✓ pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
			console.log(`  output: ${JSON.stringify(object).slice(0, 200)}…`)
			result.c = { status: 'pass' }
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			console.log(`  ✗ FAIL: ${msg.slice(0, 200)}`)
			result.c = { status: 'fail', detail: msg.slice(0, 200) }
		}
	}

	console.log('\n[D] size-scaled structured output (mirrors brainDecompositionSchema)')
	try {
		const t0 = Date.now()
		const { object } = await generateObject({
			model,
			schema: sizedSchema,
			prompt:
				'Decompose this prompt into 3 specialized neurons: ' +
				'"Track engineering decisions across tooling, CI, runtime libraries, and architectural ' +
				'choices, including the rationale for each." Each neuron must include a multi-paragraph ' +
				'instructions field with at least 8 sentences (a core directive, a Watch-for list with ' +
				'3+ specific conditions, and a Track-answers-to list with 3+ questions).',
		})
		const total = JSON.stringify(object).length
		console.log(`  ✓ pass (${((Date.now() - t0) / 1000).toFixed(1)}s, ${total} bytes)`)
		const minInstr = Math.min(
			...(object as { neurons: Array<{ instructions: string }> }).neurons.map(
				(n) => n.instructions.length,
			),
		)
		console.log(`  shortest instructions: ${minInstr} chars`)
		result.d = { status: 'pass' }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.log(`  ✗ FAIL: ${msg.slice(0, 200)}`)
		result.d = { status: 'fail', detail: msg.slice(0, 200) }
	}

	console.log('\n[E] stateful tool flow (generateResponse → complete contract)')
	// System prompt mirrors ToolBasedMethod's real wording: it nudges the
	// model to "answer" and "call complete when done" — but does NOT
	// explicitly enforce the generateResponse-then-complete order. The
	// model must infer that order from the tool descriptions alone.
	try {
		const t0 = Date.now()
		const { tools, getCaptured } = buildStatefulTools()
		await generateText({
			model,
			tools,
			toolChoice: 'required',
			stopWhen: stepCountIs(4),
			system:
				'You are a specialist. Your domain: "general knowledge". ' +
				'Read the question, then answer it. ' +
				'Acknowledge uncertainty. Don\'t invent. ' +
				'Call complete when done.',
			prompt:
				'Question: What is the capital of France? Answer based on what you know.',
		})
		const captured = getCaptured()
		if (typeof captured === 'string' && captured.trim().length > 0) {
			console.log(`  ✓ pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
			console.log(`  captured response: "${captured.slice(0, 80)}…"`)
			result.e = { status: 'pass' }
		} else {
			console.log(`  ✗ FAIL: model called complete without first calling generateResponse`)
			result.e = {
				status: 'fail',
				detail: 'no response captured — model skipped generateResponse',
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		console.log(`  ✗ FAIL: ${msg.slice(0, 200)}`)
		result.e = { status: 'fail', detail: msg.slice(0, 200) }
	}

	return result
}

async function main() {
	if (handleListMode()) return

	const presets = selectPresets()
	if (presets.length === 0) {
		console.log('No presets selected. Set provider env keys or use MODELS=list.')
		return
	}

	console.log('Eval: ai-sdk plugin smoke test')
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Selected: ${presets.map((p) => p.id).join(', ')}`)

	const results: Result[] = []
	for (const preset of presets) {
		const apiKey = process.env[preset.envVar]
		if (!apiKey) continue
		results.push(await runPreset(preset, apiKey))
	}

	console.log(`\n${'═'.repeat(72)}`)
	console.log('Summary')
	console.log('═'.repeat(72))
	const longest = Math.max(...results.map((r) => r.preset.length), 8)
	console.log(`  ${'preset'.padEnd(longest)}  A       B       C       D       E`)
	for (const r of results) {
		const tag = (s: 'pass' | 'fail' | 'skip') =>
			s === 'pass' ? '✓ pass' : s === 'fail' ? '✗ FAIL' : '↷ skip'
		console.log(
			`  ${r.preset.padEnd(longest)}  ${tag(r.a.status)}  ${tag(r.b.status)}  ${tag(r.c.status)}  ${tag(r.d.status)}  ${tag(r.e.status)}`,
		)
	}
}

// Only run when invoked directly — this file is also imported by
// llm-plugin-stream-smoke-eval.ts for shared schemas/tools.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error('Eval crashed:', err)
	})
}
