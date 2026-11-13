/**
 * Eval: ai-sdk plugin shapes (full Brain pipeline per preset)
 *
 * Exercises the full Brain lifecycle against every selected preset,
 * surfacing raw output for semantic review.
 *
 * Objectives:
 *   1. Structured JSON output works for each preset — blueprint
 *      decomposition (autoSetup), observer init, understand.
 *   2. Tool-call / query path works — ToolBasedMethod + direct synthesis.
 *   3. Persist + restore round-trip works — AdaptModelConfig rehydrates
 *      via the AI SDK plugin's provider factory.
 *   4. Output quality is comparable across providers — understandings and
 *      query insights should reference the injected facts.
 *   5. Behavior is reasonably consistent across multiple injects/asks.
 *
 * Per preset we run:
 *   - Brain.create({ autoSetup: true })  — blueprint LLM call
 *   - 3× inject batches                  — understand cycles
 *   - 3× ask queries                     — synthesis
 *   - dispose
 *   - Brain.restore (fresh store handle) — factory invocation
 *   - 2× ask after restore
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/llm-plugin-shapes-eval.ts
 *
 * Filter / list / add presets — see evals/scripts/_presets.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brain, createAiSdkLLM } from '../../src'
import { SQLiteBrainStore } from '../../src/sqlite'
import { type Preset, handleListMode, selectPresets } from './_presets'

const INJECTS: string[][] = [
	[
		'We chose better-sqlite3 over node:sqlite because it is faster and synchronous, fitting our short-lived in-process workloads.',
		'The team standardized on biome over eslint+prettier — single tool, faster, fewer config files.',
	],
	[
		'We are migrating CI from CircleCI to GitHub Actions to consolidate on one platform; CircleCI cost was the trigger.',
		'Decision: ship the v0.0.5 release behind a flag for one week before flipping it on for everyone.',
	],
	[
		'Adopted Effect for the new pipeline rewrite — explicit error channels and structured concurrency outweigh the learning curve.',
		'Postgres row-level security will replace the bespoke authorization layer in the analytics service.',
	],
]

const QUESTIONS = [
	'Which SQLite library was picked and why?',
	'Summarize the recent tooling and CI decisions.',
	'What direction is the team taking for error handling and authorization?',
]

const POST_RESTORE_QUESTIONS = [
	'Restate the SQLite decision in your own words, including the rationale.',
	'Which decisions involved a deliberate one-week soak / staged rollout?',
]

function startTimer() {
	const t0 = Date.now()
	return () => ((Date.now() - t0) / 1000).toFixed(1)
}

function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

async function runForPreset(preset: Preset, apiKey: string) {
	const elapsed = startTimer()
	console.log(`\n${'━'.repeat(72)}`)
	console.log(`Preset: ${preset.id}`)
	console.log(`${'━'.repeat(72)}`)

	const built = await preset.build(apiKey)
	console.log(
		`  built model: provider="${(built.model as { provider?: string }).provider}" modelId="${(built.model as { modelId?: string }).modelId}"`,
	)

	const llm = createAiSdkLLM({ providers: { [built.providerKey]: built.factory } })

	const tmp = mkdtempSync(join(tmpdir(), `adapt-shapes-${safeId(preset.id)}-`))
	const brainPath = join(tmp, 'brain.db')

	try {
		console.log(`\n[1] Brain.create({ autoSetup: true })  [t=${elapsed()}s]`)
		const brain = await Brain.create({
			prompt:
				'Track engineering decisions across tooling, CI, runtime libraries, ' +
				'and architectural choices, including the rationale for each.',
			model: built.model,
			llm,
			autoSetup: true,
			store: new SQLiteBrainStore(brainPath),
			internalNeurons: {
				globalUnderstanding: false,
				globalQueryUnderstanding: false,
				injectionGaps: false,
				queryGaps: false,
			},
			evolution: { enabled: false },
			learning: { understand: { thresholds: { maxObservations: 2 } } },
		})

		const neuronList = brain.getNeurons()
		console.log(`  [t=${elapsed()}s] blueprint produced ${neuronList.length} neuron(s):`)
		for (const n of neuronList) {
			console.log(`    - ${n.id}  name="${n.name}"`)
		}

		const events: Array<{ t: string; payload: unknown }> = []
		brain.on((event) => {
			events.push({ t: event.type, payload: event.payload })
		})

		for (let i = 0; i < INJECTS.length; i++) {
			console.log(`\n[2.${i + 1}] inject batch ${i + 1}  [t=${elapsed()}s]`)
			for (const item of INJECTS[i]) console.log(`  → ${item}`)
			await brain.inject(INJECTS[i])
		}

		console.log(`\n  Understanding snapshots after all injects  [t=${elapsed()}s]`)
		for (const n of brain.getNeurons()) {
			const u = await n.getUnderstanding()
			const text = typeof u === 'string' ? u : JSON.stringify(u, null, 2)
			console.log(`  --- ${n.id} ---`)
			console.log(text)
		}

		console.log(`\n[3] Ask cycle  [t=${elapsed()}s]`)
		for (const q of QUESTIONS) {
			console.log(`\n  Q: ${q}`)
			const ans = await brain.ask(q)
			console.log(`  A [t=${elapsed()}s]: ${ans.insight}`)
			console.log(
				`     sources: ${ans.sources.map((s) => `${s.neuronId}(rel=${s.relevance.toFixed(2)},conf=${s.confidence.toFixed(2)})`).join(', ')}`,
			)
			if (ans.gaps.length > 0) console.log(`     gaps: ${ans.gaps.join(' | ')}`)
		}

		await brain.dispose()
		console.log(`\n[4] disposed  [t=${elapsed()}s]`)

		console.log(`\n[5] Brain.restore (fresh SQLiteBrainStore)  [t=${elapsed()}s]`)
		const restored = await Brain.restore(new SQLiteBrainStore(brainPath), { llm })
		console.log(`  restored neurons: ${restored.getNeurons().map((n) => n.id).join(', ')}`)
		console.log(`  config.model: ${JSON.stringify(restored.config.model)}`)

		console.log(`\n[6] Ask after restore  [t=${elapsed()}s]`)
		for (const q of POST_RESTORE_QUESTIONS) {
			console.log(`\n  Q: ${q}`)
			const ans = await restored.ask(q)
			console.log(`  A [t=${elapsed()}s]: ${ans.insight}`)
			console.log(
				`     sources: ${ans.sources.map((s) => `${s.neuronId}(rel=${s.relevance.toFixed(2)},conf=${s.confidence.toFixed(2)})`).join(', ')}`,
			)
			if (ans.gaps.length > 0) console.log(`     gaps: ${ans.gaps.join(' | ')}`)
		}

		await restored.dispose()

		const eventCounts = events.reduce<Record<string, number>>((acc, e) => {
			acc[e.t] = (acc[e.t] ?? 0) + 1
			return acc
		}, {})
		console.log(`\n[7] event counts  [t=${elapsed()}s]`)
		for (const [type, count] of Object.entries(eventCounts).sort()) {
			console.log(`  ${type.padEnd(40)} ${count}`)
		}

		console.log(`\n[done] ${preset.id} total elapsed: ${elapsed()}s`)
	} catch (err) {
		console.log(`\n[error] ${preset.id} crashed at t=${elapsed()}s:`)
		console.log(err instanceof Error ? `${err.message}\n${err.stack}` : String(err))
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

async function main() {
	if (handleListMode()) return

	const presets = selectPresets()
	if (presets.length === 0) {
		console.log('No presets selected. Set provider env keys or use MODELS=list.')
		return
	}

	console.log('Eval: ai-sdk plugin shapes (full Brain pipeline per preset)')
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Selected: ${presets.map((p) => p.id).join(', ')}`)

	for (const preset of presets) {
		const apiKey = process.env[preset.envVar]
		if (!apiKey) continue
		await runForPreset(preset, apiKey)
	}

	console.log('\nDone.')
}

main().catch((err) => {
	console.error('Eval crashed:', err)
})
