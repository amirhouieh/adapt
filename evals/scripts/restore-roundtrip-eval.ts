/**
 * Eval: Brain & Neuron restore round-trip
 *
 * Per selected preset, exercises:
 *   1. Brain.create({...}) on a fresh SQLite path.
 *   2. Brain.create on a populated path — must throw "already exists".
 *   3. Brain.restore("path") + ask works WITHOUT re-passing a model.
 *   4. Brain.restore on an empty path — must throw "no brain found".
 *   5. TextNeuron standalone create → dispose → restore → query.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/restore-roundtrip-eval.ts
 *   MODELS=openai-gpt-4o-mini npx tsx evals/scripts/restore-roundtrip-eval.ts
 *
 * Filter / list / add presets — see evals/scripts/_presets.ts.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brain, TextNeuron, createAiSdkLLM } from '../../src'
import { SQLiteBrainStore, SQLiteNeuronStore } from '../../src/sqlite'
import { type Preset, handleListMode, selectPresets } from './_presets'

let totalPassed = 0
let totalFailed = 0

function check(cond: boolean, label: string) {
	if (cond) {
		totalPassed++
		console.log(`  ✓ ${label}`)
	} else {
		totalFailed++
		console.log(`  ✗ ${label}`)
	}
}

function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

async function runForPreset(preset: Preset) {
	const apiKey = process.env[preset.envVar]
	if (!apiKey) return

	const start = Date.now()
	const elapsed = () => ((Date.now() - start) / 1000).toFixed(1)

	console.log(`\n${'━'.repeat(72)}`)
	console.log(`Preset: ${preset.id}`)
	console.log(`${'━'.repeat(72)}`)

	const built = await preset.build(apiKey)
	const llm = createAiSdkLLM({ providers: { [built.providerKey]: built.factory } })

	const tmp = mkdtempSync(join(tmpdir(), `adapt-restore-${safeId(preset.id)}-`))
	const brainPath = join(tmp, 'brain.db')
	const neuronPath = join(tmp, 'standalone-neuron.db')

	try {
		// ── 1. Brain.create on fresh path ─────────────────────────────────
		console.log('\n[1] Brain.create — fresh')
		const brain = await Brain.create({
			prompt: 'Track engineering decisions and the rationale behind technical choices.',
			model: built.model,
			llm,
			autoSetup: false,
			store: new SQLiteBrainStore(brainPath),
			neurons: [
				{
					id: 'engineering-decisions',
					type: 'text',
					name: 'Engineering Decisions',
					description: 'Tracks technical decisions and tradeoffs.',
					instructions:
						'Track engineering decisions, runtime tradeoffs, and rationale for technical changes.',
					focus: null,
					skipObservation: true,
					observationSchema: { type: 'string' },
					understandingSchema: { type: 'string' },
				},
			],
			internalNeurons: {
				globalUnderstanding: false,
				globalQueryUnderstanding: false,
				injectionGaps: false,
				queryGaps: false,
			},
			evolution: { enabled: false },
			learning: { understand: { thresholds: { maxObservations: 1 } } },
		})
		console.log(`  [${elapsed()}s] created`)

		await brain.inject([
			'We chose runtime-specific SQLite adapters (better-sqlite3 for Node, bun:sqlite for Bun) so the core stays runtime-agnostic.',
		])
		console.log(`  [${elapsed()}s] injected`)

		const decisionRefs = /better[-\s]?sqlite3|bun:sqlite|runtime[-\s]?specific|runtime[-\s]?agnostic/i
		const firstAnswer = await brain.ask('What engineering decision was made about SQLite?')
		console.log(`  [${elapsed()}s] first ask: ${firstAnswer.insight.slice(0, 120)}...`)
		check(
			decisionRefs.test(firstAnswer.insight),
			'first ask references the actual injected decision',
		)

		await brain.dispose()
		console.log(`  [${elapsed()}s] disposed`)

		const expectedNeuronFile = join(tmp, 'brain.engineering-decisions.db')
		check(
			existsSync(expectedNeuronFile),
			`getNeuronStore created sibling file: ${expectedNeuronFile}`,
		)

		// ── 2. Brain.create on populated store throws ─────────────────────
		console.log('\n[2] Brain.create on populated store throws')
		let createOnPopulatedThrew = false
		try {
			await Brain.create({
				prompt: 'whatever',
				model: built.model,
				autoSetup: false,
				store: new SQLiteBrainStore(brainPath),
				neurons: [],
			})
		} catch (err) {
			createOnPopulatedThrew = /already exists/i.test(
				err instanceof Error ? err.message : String(err),
			)
		}
		check(createOnPopulatedThrew, 'Brain.create on populated store throws "already exists"')

		// ── 3. Brain.restore via path-string sugar ────────────────────────
		console.log('\n[3] Brain.restore("path") — path-string sugar')
		const restored = await Brain.restore(brainPath, { llm })
		console.log(`  [${elapsed()}s] restored`)

		check(
			restored.getNeurons().length === 1,
			`restored brain has 1 neuron (got ${restored.getNeurons().length})`,
		)
		check(
			restored.getNeuron('engineering-decisions') !== undefined,
			'restored neuron id matches',
		)

		const secondAnswer = await restored.ask('What engineering decision was made about SQLite?')
		console.log(`  [${elapsed()}s] second ask: ${secondAnswer.insight.slice(0, 120)}...`)
		check(
			decisionRefs.test(secondAnswer.insight),
			'restored brain references the actual persisted decision',
		)

		await restored.dispose()

		// ── 4. Brain.restore on empty store throws ────────────────────────
		console.log('\n[4] Brain.restore on empty store throws')
		const emptyDir = mkdtempSync(join(tmpdir(), 'adapt-empty-'))
		const emptyPath = join(emptyDir, 'empty.db')
		let restoreOnEmptyThrew = false
		try {
			await Brain.restore(emptyPath)
		} catch (err) {
			restoreOnEmptyThrew = /no brain found/i.test(
				err instanceof Error ? err.message : String(err),
			)
		}
		rmSync(emptyDir, { recursive: true, force: true })
		check(restoreOnEmptyThrew, 'Brain.restore on empty store throws "no brain found"')

		// ── 5. Standalone neuron restore round-trip ───────────────────────
		console.log('\n[5] TextNeuron.create → restore')
		const neuron = await TextNeuron.create({
			id: 'sqlite-decisions',
			name: 'SQLite Decisions',
			instructions: 'Track engineering decisions about SQLite usage.',
			model: built.model,
			llm,
			store: new SQLiteNeuronStore(neuronPath),
			understand: { thresholds: { maxObservations: 1 } },
		})
		console.log(`  [${elapsed()}s] standalone neuron created`)

		await neuron.learn([
			'We picked better-sqlite3 over node:sqlite because it is faster and synchronous.',
		])
		const neuronFirstAnswer = await neuron.query('Which SQLite library did we pick and why?')
		console.log(`  [${elapsed()}s] neuron first query: ${neuronFirstAnswer.insight.slice(0, 120)}...`)
		check(
			/better[-\s]?sqlite3/i.test(neuronFirstAnswer.insight),
			'standalone neuron answers from injected data',
		)

		await neuron.dispose()

		const restoredNeuron = await TextNeuron.restore(neuronPath, {
			id: 'sqlite-decisions',
			llm,
		})
		console.log(`  [${elapsed()}s] standalone neuron restored`)
		const neuronSecondAnswer = await restoredNeuron.query(
			'Which SQLite library did we pick and why?',
		)
		console.log(`  [${elapsed()}s] neuron second query: ${neuronSecondAnswer.insight.slice(0, 120)}...`)
		check(
			/better[-\s]?sqlite3/i.test(neuronSecondAnswer.insight),
			'restored standalone neuron answers same question',
		)

		await restoredNeuron.dispose()

		console.log(`\n[done] ${preset.id} total elapsed: ${elapsed()}s`)
	} catch (err) {
		console.log(`\n[error] ${preset.id} crashed at t=${elapsed()}s:`)
		console.log(err instanceof Error ? `${err.message}\n${err.stack}` : String(err))
		totalFailed++
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

	console.log('Eval: Brain & Neuron restore round-trip')
	console.log(`Time: ${new Date().toISOString()}`)
	console.log(`Selected: ${presets.map((p) => p.id).join(', ')}`)

	for (const preset of presets) {
		await runForPreset(preset)
	}

	console.log(`\n${'═'.repeat(72)}`)
	console.log(`restore-roundtrip: ${totalPassed} passed, ${totalFailed} failed`)
	if (totalFailed > 0) process.exit(1)
}

main().catch((err) => {
	console.error('Eval crashed:', err)
	process.exit(1)
})
