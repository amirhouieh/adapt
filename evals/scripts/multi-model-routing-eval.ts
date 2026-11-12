/**
 * Eval: multi-model routing across slots
 *
 * Verifies — by surfacing raw output for review — that a single Brain
 * with different models in different slots actually dispatches each call
 * to the right underlying model, and that quality holds when slots are
 * mixed across providers.
 *
 * Objectives:
 *   1. Slot routing is correct — init/blueprint/understand calls land
 *      on the default-slot model; query calls land on the query-slot
 *      model. Visible in the call attribution log.
 *   2. Restore preserves slot routing — after dispose + reopen, the
 *      registered factory is invoked with the right modelId per slot.
 *   3. Output quality holds across multi-provider configurations.
 *   4. Behavior is consistent across multiple combos and runs.
 *
 * Per combo we run a substantial pipeline:
 *   - Brain.create({ autoSetup: true })  — blueprint hits default
 *   - 3× inject batches                  — understand hits default
 *   - 3× ask                             — query hits query-slot
 *   - dispose
 *   - Brain.restore (fresh store)
 *   - 2× ask after restore
 * Repeated TWICE per combo.
 *
 * Combos are derived from selected presets (see MODELS env / _presets.ts).
 * Default behavior with no MODELS filter: pick the first two presets with
 * distinct env keys, run (A,B) and (B,A). With MODELS=foo,bar: that exact
 * pair, run (A,B) and (B,A).
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/multi-model-routing-eval.ts
 *   MODELS=openai-gpt-4o-mini,google-gemini-2.5-flash npx tsx evals/scripts/multi-model-routing-eval.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { Brain, createAiSdkLLM } from '../../src'
import type { AiSdkProviderFactory } from '../../src'
import { SQLiteBrainStore } from '../../src/sqlite'
import {
	type Preset,
	type PresetBuild,
	handleListMode,
	selectPresets,
} from './_presets'

interface CallLog {
	slot: 'A' | 'B' | '?'
	provider: string
	modelId: string
	phaseHint: string
}

const RUNS_PER_COMBO = 2

const INJECTS: string[][] = [
	[
		'We chose better-sqlite3 over node:sqlite for synchronous, faster reads in short-lived processes.',
		'Standardized on biome over eslint+prettier — single tool, faster, fewer configs.',
	],
	[
		'Migrated CI from CircleCI to GitHub Actions to consolidate platforms; cost was the trigger.',
		'v0.0.5 ships behind a flag for one week before the global flip-on.',
	],
	[
		'Adopted Effect for the new pipeline rewrite — explicit error channels worth the learning curve.',
		'Postgres row-level security replaces the bespoke authorization layer in analytics.',
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

function wrapLiveModel(model: LanguageModel, log: CallLog[], slot: 'A' | 'B'): LanguageModel {
	const m = model as unknown as LanguageModelV3
	const provider = m.provider ?? '?'
	const modelId = m.modelId ?? '?'
	const wrapped: LanguageModelV3 = {
		specificationVersion: m.specificationVersion,
		provider,
		modelId,
		supportedUrls: m.supportedUrls,
		async doGenerate(opts: LanguageModelV3CallOptions) {
			log.push({ slot, provider, modelId, phaseHint: phaseFromOpts(opts) })
			return m.doGenerate(opts)
		},
		async doStream(opts: LanguageModelV3CallOptions) {
			log.push({ slot, provider, modelId, phaseHint: phaseFromOpts(opts) + ':stream' })
			return m.doStream(opts)
		},
	}
	return wrapped as unknown as LanguageModel
}

function phaseFromOpts(opts: LanguageModelV3CallOptions): string {
	const text = JSON.stringify(opts.prompt ?? '').slice(0, 800)
	if (text.includes('customizing cognitive skill prompts')) return 'understand-skills'
	if (text.includes('You are analyzing a user-authored prompt')) return 'prompt-decomp'
	if (text.includes('decomposition') || text.includes('Decompose')) return 'blueprint'
	if (text.includes('synthesize') || text.includes('Synthesize')) return 'understand'
	if (text.includes('querySpecialist') || text.includes('relevance')) return 'query-tool'
	if (text.includes('insight') && text.includes('synthesis')) return 'synthesis'
	return 'unknown'
}

function startTimer() {
	const t0 = Date.now()
	return () => ((Date.now() - t0) / 1000).toFixed(1)
}

interface Slot {
	preset: Preset
	build: PresetBuild
}

async function buildSlot(preset: Preset): Promise<Slot> {
	const apiKey = process.env[preset.envVar]
	if (!apiKey) throw new Error(`${preset.envVar} not set`)
	return { preset, build: await preset.build(apiKey) }
}

interface Combo {
	a: Slot
	b: Slot
}

function pickPair(presets: Preset[]): [Preset, Preset] {
	if (presets.length < 2) {
		throw new Error(
			'Need at least 2 selectable presets. Set more env keys or pass MODELS=<a>,<b>.',
		)
	}
	// If MODELS was explicit, use first two as given.
	if (process.env.MODELS) return [presets[0], presets[1]]
	// Otherwise prefer two presets with distinct env keys (cross-provider).
	const seen = new Set<string>()
	const distinct: Preset[] = []
	for (const p of presets) {
		if (!seen.has(p.envVar)) {
			seen.add(p.envVar)
			distinct.push(p)
			if (distinct.length === 2) return [distinct[0], distinct[1]]
		}
	}
	return [presets[0], presets[1]]
}

async function runCombo(combo: Combo, runIndex: number) {
	const elapsed = startTimer()
	const callLog: CallLog[] = []

	const aLabel = `${combo.a.preset.id}`
	const bLabel = `${combo.b.preset.id}`
	console.log(`\n${'━'.repeat(72)}`)
	console.log(`Combo: A=${aLabel}  B=${bLabel}  run #${runIndex + 1}/${RUNS_PER_COMBO}`)
	console.log(`${'━'.repeat(72)}`)

	const liveA = wrapLiveModel(combo.a.build.model, callLog, 'A')
	const liveB = wrapLiveModel(combo.b.build.model, callLog, 'B')

	const wrapFactory = (raw: AiSdkProviderFactory, slot: 'A' | 'B'): AiSdkProviderFactory =>
		((id, config) => {
			const m = raw(id, config)
			return wrapLiveModel(m as LanguageModel, callLog, slot) as unknown as ReturnType<AiSdkProviderFactory>
		}) as AiSdkProviderFactory

	const providers: Record<string, AiSdkProviderFactory> = {}
	providers[combo.a.build.providerKey] = wrapFactory(combo.a.build.factory, 'A')
	if (combo.b.build.providerKey !== combo.a.build.providerKey) {
		providers[combo.b.build.providerKey] = wrapFactory(combo.b.build.factory, 'B')
	}
	const llm = createAiSdkLLM({ providers })

	const tmp = mkdtempSync(join(tmpdir(), 'adapt-routing-'))
	const brainPath = join(tmp, 'brain.db')

	try {
		console.log(`\n[1] Brain.create({ autoSetup: true })  [t=${elapsed()}s]`)
		const brain = await Brain.create({
			prompt:
				'Track engineering decisions across tooling, CI, runtime libraries, ' +
				'and architectural choices, including the rationale for each.',
			model: liveA,
			query: { model: liveB },
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
		console.log(`  [t=${elapsed()}s] blueprint produced ${neuronList.length} neuron(s)`)
		for (const n of neuronList) {
			console.log(`    - ${n.id}  type=${n.type}  name="${n.name}"`)
		}
		dumpCalls(callLog, '[1] calls so far')

		for (let i = 0; i < INJECTS.length; i++) {
			console.log(`\n[2.${i + 1}] inject batch  [t=${elapsed()}s]`)
			for (const item of INJECTS[i]) console.log(`  → ${item}`)
			await brain.inject(INJECTS[i])
		}
		console.log(`\n  Understanding snapshots  [t=${elapsed()}s]`)
		for (const n of brain.getNeurons()) {
			const u = await n.getUnderstanding()
			console.log(`  --- ${n.id} ---`)
			console.log(typeof u === 'string' ? u : JSON.stringify(u, null, 2))
		}
		dumpCalls(callLog, '[2] calls so far')

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
		dumpCalls(callLog, '[3] calls so far')

		await brain.dispose()
		console.log(`\n[4] disposed  [t=${elapsed()}s]`)

		console.log(`\n[5] Brain.restore (fresh SQLiteBrainStore)  [t=${elapsed()}s]`)
		const restored = await Brain.restore(new SQLiteBrainStore(brainPath), { llm })
		console.log(`  config.model:        ${JSON.stringify(restored.config.model)}`)
		console.log(`  config.query.model:  ${JSON.stringify(restored.config.query?.model)}`)

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

		console.log(`\n[7] full call attribution  [t=${elapsed()}s]`)
		const totals = callLog.reduce<Record<string, number>>((acc, c) => {
			const k = `${c.slot}  ${c.provider}/${c.modelId}  ${c.phaseHint}`
			acc[k] = (acc[k] ?? 0) + 1
			return acc
		}, {})
		for (const [k, v] of Object.entries(totals).sort()) {
			console.log(`  ${String(v).padStart(3)}  ${k}`)
		}
		const slotCounts = callLog.reduce<Record<string, number>>((acc, c) => {
			acc[c.slot] = (acc[c.slot] ?? 0) + 1
			return acc
		}, {})
		console.log(`\n  slot totals: A=${slotCounts.A ?? 0}  B=${slotCounts.B ?? 0}  ?=${slotCounts['?'] ?? 0}`)
	} catch (err) {
		console.log(`\n[error] combo crashed at t=${elapsed()}s:`)
		console.log(err instanceof Error ? `${err.message}\n${err.stack}` : String(err))
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

function dumpCalls(log: CallLog[], label: string) {
	const totals = log.reduce<Record<string, number>>((acc, c) => {
		const k = `${c.slot}  ${c.provider}/${c.modelId}  ${c.phaseHint}`
		acc[k] = (acc[k] ?? 0) + 1
		return acc
	}, {})
	console.log(`\n  ${label}:`)
	for (const [k, v] of Object.entries(totals).sort()) {
		console.log(`    ${String(v).padStart(3)}  ${k}`)
	}
}

async function main() {
	if (handleListMode()) return

	const presets = selectPresets({ require: 2 })
	const [aPreset, bPreset] = pickPair(presets)

	console.log('Eval: multi-model routing')
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Slot A: ${aPreset.id}    Slot B: ${bPreset.id}`)
	console.log(`Runs per combo: ${RUNS_PER_COMBO}`)

	const slotA = await buildSlot(aPreset)
	const slotB = await buildSlot(bPreset)

	const combos: Combo[] = [
		{ a: slotA, b: slotB },
		{ a: slotB, b: slotA },
	]

	for (const combo of combos) {
		for (let i = 0; i < RUNS_PER_COMBO; i++) {
			await runCombo(combo, i)
		}
	}

	console.log('\nDone.')
}

main().catch((err) => {
	console.error('Eval crashed:', err)
})
