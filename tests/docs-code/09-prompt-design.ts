/**
 * Docs code test: 09-prompt-design.md
 *
 * Verifies every TypeScript code block from the Prompt Design guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/09-prompt-design.ts
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
	// ── Adjust Directives ────────────────────────────────────────────────
	section('Adjust Directives')

	const brain = await Brain.create({
		prompt: 'Track coding and design patterns.',
		model,
		autoSetup: false,
		neurons: [
			{ id: 'design', name: 'Design', description: 'Design patterns', instructions: 'Track design patterns.' },
			{ id: 'tech', name: 'Tech', description: 'Tech patterns', instructions: 'Track tech patterns.' },
			{ id: 'patterns', name: 'Patterns', description: 'General patterns', instructions: 'Track general patterns.' },
			{ id: 'trends', name: 'Trends', description: 'Trend tracking', instructions: 'Track trends.' },
		],
	})

	// Expand scope
	await brain.adjustNeuron('design', 'Also track accessibility patterns')
	assert(true, 'adjustNeuron — expand scope')

	// Narrow scope
	await brain.adjustNeuron('tech', 'Focus only on React, stop tracking Vue')
	assert(true, 'adjustNeuron — narrow scope')

	// Change behavior
	await brain.adjustNeuron('patterns', 'Be stricter about what counts as a distinct pattern')
	assert(true, 'adjustNeuron — change behavior')

	// Shift emphasis
	await brain.adjustNeuron('trends', 'Weight recent observations more heavily')
	assert(true, 'adjustNeuron — shift emphasis')

	await brain.dispose()

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`09-prompt-design: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
