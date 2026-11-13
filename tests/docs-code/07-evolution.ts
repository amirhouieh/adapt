/**
 * Docs code test: 07-evolution.md
 *
 * Verifies every TypeScript code block from the Evolution guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/07-evolution.ts
 */

import { Brain } from '@unbody-io/adapt'
import { model } from '../../evals/helpers/provider'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
	if (condition) {
		passed++
		console.log(`  ✓ ${message}`)
	} else {
		failed++
		console.log(`  ✗ ${message}`)
	}
}

function section(title: string) {
	console.log(`\n━━━ ${title} ━━━`)
}

async function main() {
	// ── Evolution Config ──────────────────────────────────────────────────
	section('Evolution Config')

	const brain = await Brain.create({
		prompt: 'Track evolution patterns.',
		model,
		evolution: {
			enabled: true,
			model,
			evaluatorSignalThreshold: 5,
			autoEvaluate: true,
			coverageGap: {
				relevanceThreshold: 0.3,
				gapCountThreshold: 5,
				windowSize: 20,
			},
		},
	})
	assert(true, 'Brain with full evolution config initialized')

	// ── Manual Control — Signals ─────────────────────────────────────────
	section('Manual Control — Signals')

	// Inject custom signal
	brain.signal({
		source: 'analytics',
		description: 'Users asking about deployment patterns but no neuron covers it',
	})
	assert(true, 'signal() with source and description works')

	// Force immediate evaluation (bypass threshold)
	brain.signal({
		source: 'admin',
		description: 'Restructure neurons for new product direction',
		bypass: true,
	})
	assert(true, 'signal() with bypass works')

	// ── Manual Control — evaluateEvolution ────────────────────────────────
	section('Manual Control — evaluateEvolution')

	// Manually trigger evaluation
	const evalResult = await brain.evaluateEvolution()
	assert(Array.isArray(evalResult.decisions), 'evaluateEvolution() returns decisions array')

	// Dry run — see what the evaluator would decide without executing
	const dryRunResult = await brain.evaluateEvolution({ dryRun: true })
	assert(Array.isArray(dryRunResult.decisions), 'evaluateEvolution({ dryRun }) returns decisions')

	// ── Manual Control — Stream ──────────────────────────────────────────
	section('Manual Control — Stream')

	// Add a signal so the evaluator has something to process
	brain.signal({ source: 'test', description: 'Test signal for stream evaluation', bypass: true })

	const { stream, decisions } = await brain.evaluateEvolutionStream({ dryRun: true })

	let firstPartType: string | null = null
	for await (const part of stream.fullStream) {
		// See evaluator tool calls
		if (!firstPartType) {
			firstPartType = part.type
		}
	}
	assert(typeof firstPartType === 'string', `stream part has type: ${firstPartType}`)

	const resolved = await decisions
	assert(Array.isArray(resolved.decisions), 'stream decisions resolve to array')

	// ── Enable / Disable ─────────────────────────────────────────────────
	section('Enable / Disable Evolution')

	// Long-term brain: let it evolve
	const clientBrain = await Brain.create({
		prompt: 'Long-term tracking.',
		model,
		evolution: { enabled: true },
	})
	assert(clientBrain instanceof Brain, 'Brain with evolution enabled created')
	await clientBrain.dispose()

	// Session brain: fixed structure
	const sessionBrain = await Brain.create({
		prompt: 'Session-scoped extraction.',
		model,
		evolution: { enabled: false },
		autoSetup: false,
		neurons: [
			{ id: 'n1', name: 'N1', description: 'Test', instructions: 'Test neuron.' },
		],
	})
	assert(sessionBrain instanceof Brain, 'Brain with evolution disabled created')
	await sessionBrain.dispose()

	// ── Developer Signals (from concepts.md — Steering) ──────────────────
	section('Developer Signals')

	// Tell the brain about a domain shift
	brain.signal({ source: 'product', description: 'We pivoted from B2C to B2B — restructure accordingly' })
	assert(true, 'domain shift signal accepted')

	// Flag a gap from your analytics
	brain.signal({ source: 'analytics', description: 'Users keep asking about deployment but nothing covers it' })
	assert(true, 'analytics gap signal accepted')

	// Force immediate evaluation (bypass the signal threshold)
	brain.signal({ source: 'admin', description: 'Restructure now', bypass: true })
	assert(true, 'bypass signal accepted')

	await brain.dispose()

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`07-evolution: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
