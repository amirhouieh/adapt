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
			},
		},
	})
	assert(true, 'Brain with full evolution config initialized')

	// ── Manual Control — Signals ─────────────────────────────────────────
	section('Manual Control — Signals')

	// Add a signal
	brain.signal({
		source: 'analytics',
		description: 'Users asking about deployment patterns but no neuron covers it',
	})
	assert(true, 'signal() with source and description works')

	// ── Manual Control — evolve ──────────────────────────────────────────
	section('Manual Control — evolve')

	// Run evolution now
	const { changes, reasoning } = await brain.evolve()
	assert(Array.isArray(changes), 'evolve() returns changes array')
	assert(typeof reasoning === 'string', 'evolve() returns reasoning')

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
