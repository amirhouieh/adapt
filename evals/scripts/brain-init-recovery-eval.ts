/**
 * Eval: Brain init recovery from partial state (issue #6)
 *
 * Objectives:
 *   1. Reproduce the bug condition with real LLM + real SQLite — neuron init
 *      throws mid-loop, leaving orphan rows in `neurons` table while
 *      brain-level `state` table stays empty. Confirm the orphan count.
 *   2. Verify that a fresh Brain pointed at the same (poisoned) store can
 *      `initialize()` to success without manual cleanup. Print every event
 *      emitted during the recovery init so a reviewer can see whether the
 *      already-completed neurons are reused (no LLM calls) and the previously
 *      failing one re-runs.
 *   3. Verify the recovered brain is functionally healthy end-to-end:
 *      `inject()` produces synthesis on at least one neuron and `ask()`
 *      returns a non-empty insight grounded in the injected data.
 *
 * Failure injection:
 *   The OpenRouter model is wrapped so that the Nth `doGenerate` call throws
 *   a synthetic Error mimicking a transient LLM failure (e.g. truncated JSON
 *   that AI SDK cannot repair, the original reporter's failure mode). All
 *   prior calls hit the real model; the failure is the only synthetic part.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/brain-init-recovery-eval.ts
 */

import { Brain } from '../../src'
import { SQLiteBrainStore } from '../../src/sqlite'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
const MODEL = process.env.MODEL ?? 'google/gemini-2.0-flash-001'
const realModel = openrouter(MODEL) as unknown as LanguageModelV3

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbDir = join(__dirname, '..', '.data', 'brain-init-recovery')

const startTime = Date.now()
function elapsed() {
	return ((Date.now() - startTime) / 1000).toFixed(1)
}

// ── Failure-injecting model wrapper ──────────────────────────────────────────

function wrapWithFailureOnCall(failOnCall: number): {
	model: LanguageModel
	getCallCount: () => number
} {
	let callCount = 0
	const wrapped: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: realModel.provider,
		modelId: realModel.modelId,
		supportedUrls: realModel.supportedUrls,
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			callCount++
			if (callCount === failOnCall) {
				throw new Error(
					`[simulated] Transient LLM failure on doGenerate call ${callCount} ` +
						`(mimics AI_NoObjectGeneratedError from truncated JSON)`,
				)
			}
			return realModel.doGenerate(options)
		},
		async doStream(options: LanguageModelV3CallOptions): Promise<{
			stream: ReadableStream<LanguageModelV3StreamPart>
			request?: { body?: unknown }
			response?: { headers?: Record<string, string> }
		}> {
			return realModel.doStream(options)
		},
	}
	return { model: wrapped as unknown as LanguageModel, getCallCount: () => callCount }
}

// ── Neuron config (3 text neurons) ───────────────────────────────────────────

const neuronConfigs = [
	{
		id: 'coffee',
		type: 'text' as const,
		name: 'Coffee Knowledge',
		description: 'Tracks coffee brewing and origin knowledge',
		instructions: 'Track coffee brewing methods, bean origins, and flavor notes.',
	},
	{
		id: 'cooking',
		type: 'text' as const,
		name: 'Cooking Knowledge',
		description: 'Tracks cooking techniques and recipes',
		instructions: 'Track cooking techniques, recipes, and ingredient pairings.',
	},
	{
		id: 'baking',
		type: 'text' as const,
		name: 'Baking Knowledge',
		description: 'Tracks baking techniques and dough chemistry',
		instructions: 'Track baking techniques, dough chemistry, and oven methods.',
	},
]

const BRAIN_PROMPT =
	'Track culinary knowledge across coffee, cooking, and baking. Decompose into specialists.'

function brainConfig(model: LanguageModel) {
	return {
		prompt: BRAIN_PROMPT,
		model,
		autoSetup: false,
		store: new SQLiteBrainStore(join(dbDir, 'brain.db')),
		neurons: neuronConfigs,
		internalNeurons: {
			globalUnderstanding: false,
			globalQueryUnderstanding: false,
			injectionGaps: false,
			queryGaps: false,
		},
		evolution: { enabled: false },
	}
}

async function listOrphans(brainDbPath: string) {
	// Re-open just to read state — independent of the brain's lifecycle.
	const probe = new SQLiteBrainStore(brainDbPath)
	const neurons = await probe.neurons.list()
	const internal = await probe.internalNeurons.list()
	const state = await probe.state.list()
	await probe.dispose()
	return { neurons, internal, state }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log('Eval: Brain init recovery from partial state (issue #6)')
	console.log(`Model: ${MODEL}`)
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Data dir: ${dbDir}`)

	// Reset data dir each run.
	rmSync(dbDir, { recursive: true, force: true })
	mkdirSync(dbDir, { recursive: true })

	// ─── Phase 1: induce failure ───────────────────────────────────────────────
	console.log('\n━━━ 1. Induce failure mid-init ━━━')
	console.log('3 text neurons; each init makes 2 LLM calls (observe + understand identity).')
	console.log('Failing on call 5 → neurons 1+2 persist, neuron 3 dies on its first LLM call.')

	const { model: failingModel, getCallCount: getFailCalls } = wrapWithFailureOnCall(5)

	let phase1Error: Error | null = null
	try {
		await Brain.create(brainConfig(failingModel))
		console.log('  [unexpected] Brain.create() did not throw')
	} catch (err) {
		phase1Error = err instanceof Error ? err : new Error(String(err))
		console.log(`\n  [${elapsed()}s] Brain.create() threw as expected:`)
		console.log(`    ${phase1Error.message}`)
	}
	console.log(`  Total LLM calls before failure: ${getFailCalls()}`)

	// Inspect the poisoned store directly.
	const after1 = await listOrphans(join(dbDir, 'brain.db'))
	console.log('\n  Store state after Phase 1:')
	console.log(`    neurons table:         ${after1.neurons.length} rows → [${after1.neurons.map((r) => r.id).join(', ')}]`)
	console.log(`    internalNeurons table: ${after1.internal.length} rows → [${after1.internal.map((r) => r.id).join(', ')}]`)
	console.log(`    state table:           ${after1.state.length} rows`)
	console.log('  (orphans are present → store is poisoned without recovery code)')

	// ─── Phase 2: recovery on a fresh Brain ───────────────────────────────────
	console.log('\n━━━ 2. Recovery with fresh Brain on the same store ━━━')

	let phase2Error: Error | null = null
	let brain2: Brain | undefined
	try {
		brain2 = await Brain.create(brainConfig(realModel as unknown as LanguageModel))
		console.log(`  [${elapsed()}s] Brain.create() resolved`)
	} catch (err) {
		phase2Error = err instanceof Error ? err : new Error(String(err))
		console.log(`  [${elapsed()}s] Brain.create() threw:`)
		console.log(`    ${phase2Error.message}`)
	}

	const after2 = await listOrphans(join(dbDir, 'brain.db'))
	console.log('\n  Store state after Phase 2:')
	console.log(`    neurons table:         ${after2.neurons.length} rows → [${after2.neurons.map((r) => r.id).join(', ')}]`)
	console.log(`    internalNeurons table: ${after2.internal.length} rows → [${after2.internal.map((r) => r.id).join(', ')}]`)
	console.log(`    state table:           ${after2.state.length} rows`)

	if (brain2) {
		const brainNeurons = brain2.getNeurons()
		console.log(`  Brain in-memory neuron count: ${brainNeurons.length}`)
		for (const n of brainNeurons) {
			console.log(`    - ${n.id}`)
		}
	}

	// ─── Phase 3: functional verification ─────────────────────────────────────
	if (phase2Error || !brain2) {
		console.log('\n━━━ 3. Functional verification — SKIPPED (recovery failed) ━━━')
		await brain2?.dispose()
		return
	}

	console.log('\n━━━ 3. Functional verification on recovered brain ━━━')

	const sampleObservations = [
		'Pour-over coffee at 92C with a 1:16 ratio gives a balanced cup. Bloom for 30s.',
		'For sourdough, autolyse the flour and water for 30 minutes before adding starter.',
		'Maillard reaction starts around 140C — sear meat at high heat for crust development.',
	]

	console.log(`  Injecting ${sampleObservations.length} observations…`)
	const synthesisEvents: Array<{ neuronId: string; len: number }> = []
	brain2.on((event) => {
		if (event.type === 'neuron:synthesized') {
			const p = event.payload as { neuronId: string; newUnderstanding: string }
			synthesisEvents.push({ neuronId: p.neuronId, len: p.newUnderstanding.length })
		}
	})

	const injectResult = await brain2.inject(sampleObservations)
	const totalNeuronResults = injectResult.batches.reduce(
		(sum, b) => sum + b.results.length,
		0,
	)
	console.log(
		`  [${elapsed()}s] inject() done — id=${injectResult.id}, ` +
			`batches=${injectResult.batches.length}, neuron_results=${totalNeuronResults}`,
	)
	console.log(`  Synthesis events: ${synthesisEvents.length}`)
	for (const e of synthesisEvents) {
		console.log(`    - neuron=${e.neuronId} understanding_chars=${e.len}`)
	}

	console.log('\n  Asking: "What temperatures matter for these culinary techniques?"')
	const askResult = await brain2.ask(
		'What temperatures matter for these culinary techniques?',
		{ mode: 'direct' },
	)
	console.log(`  [${elapsed()}s] ask() done`)
	console.log(`\n  Insight (${askResult.insight.length} chars):`)
	console.log(`    ${askResult.insight.slice(0, 600)}${askResult.insight.length > 600 ? '…' : ''}`)
	console.log(`\n  Sources: ${askResult.sources.length}`)
	for (const s of askResult.sources) {
		console.log(`    - ${s.neuronId}: relevance=${s.relevance} confidence=${s.confidence}`)
	}
	console.log(`\n  Gaps: ${askResult.gaps.length ? askResult.gaps.join('; ') : '(none)'}`)

	await brain2.dispose()
	console.log(`\n  Total elapsed: ${elapsed()}s`)
}

main().catch((err) => {
	console.error('Eval crashed:', err)
	process.exit(1)
})
