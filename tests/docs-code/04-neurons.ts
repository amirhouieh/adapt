/**
 * Docs code test: 04-neurons.md
 *
 * Verifies every TypeScript code block from the Neurons guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/04-neurons.ts
 */

import { TextNeuron, MemoryNeuronStore } from '@unbody-io/adapt'
import { SQLiteNeuronStore } from '@unbody-io/adapt/sqlite'
import { model } from '../../evals/helpers/provider'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, '..', '.tmp-docs-04')

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
	rmSync(tmpDir, { recursive: true, force: true })
	mkdirSync(tmpDir, { recursive: true })
	try {
	// ── TextNeuron — Basic ────────────────────────────────────────────────
	section('TextNeuron — Basic')

	const textNeuron = await TextNeuron.create({
		model,
		instructions: 'Track product design principles and user research insights.',
		store: new MemoryNeuronStore(),
	})

	await textNeuron.learn([
		'User testing showed: 3-click navigation preferred over hamburger menu',
		'Design review: dark mode should be default for evening users',
	])

	const understanding = await textNeuron.getUnderstanding()
	assert(typeof understanding === 'string', 'TextNeuron getUnderstanding() returns string')

	const textResult = await textNeuron.query('What are the key design principles?')
	assert(typeof textResult.insight === 'string', 'TextNeuron query returns insight')

	// ── TextNeuron — Governance Config ────────────────────────────────────
	section('TextNeuron — Governance Config')

	const govNeuron = await TextNeuron.create({
		model,
		instructions: 'Track product design principles and user research insights.',
		store: new MemoryNeuronStore(),
		governance: { strategy: 'decay', maxTokens: 8000 },
	})
	assert(govNeuron instanceof TextNeuron, 'TextNeuron with governance config created')
	const gov = govNeuron.getGovernance()
	assert(gov.strategy === 'decay' && gov.maxTokens === 8000, 'getGovernance() returns config')
	await govNeuron.update({ governance: { strategy: 'cumulative' } })
	assert(govNeuron.getGovernance().strategy === 'cumulative', 'update({ governance }) changes strategy')
	await govNeuron.dispose()

	// TextInput items (caller-owned ids and times)
	const inputNeuron = await TextNeuron.create({
		model,
		instructions: 'Track product launch dates.',
		store: new MemoryNeuronStore(),
	})
	const inputResult = await inputNeuron.learn([
		{ deliveryId: 'msg-42', text: 'Moved the launch to March.', observedAt: '2026-11-10T09:00:00Z' },
	])
	assert(inputResult.status !== undefined, 'learn() accepts TextInput')
	await inputNeuron.dispose()

	// ── TextNeuron — Restore ──────────────────────────────────────────────
	section('TextNeuron — Restore')

	const restorePath = join(tmpDir, 'text-neuron.db')

	// Persist a neuron first
	const seed = await TextNeuron.create({
		model,
		instructions: 'Track restore-roundtrip patterns.',
		store: new SQLiteNeuronStore(restorePath),
	})
	await seed.dispose()

	// Restore via path string with runtime model
	const restoredFromPath = await TextNeuron.restore(restorePath, { model })
	assert(restoredFromPath instanceof TextNeuron, 'TextNeuron.restore(path, { model }) succeeds')
	await restoredFromPath.dispose()

	// Restore via explicit store with runtime model
	const restoredFromStore = await TextNeuron.restore(
		new SQLiteNeuronStore(restorePath),
		{ model },
	)
	assert(restoredFromStore instanceof TextNeuron, 'TextNeuron.restore(store, { model }) succeeds')
	await restoredFromStore.dispose()

	// Restore with id pinning (matches doc example)
	const restoredWithId = await TextNeuron.restore(restorePath, {
		id: 'design-principles',
		model,
	})
	assert(restoredWithId instanceof TextNeuron, 'TextNeuron.restore(path, { id, model }) succeeds')
	await restoredWithId.dispose()

	// ── Common Neuron API ────────────────────────────────────────────────
	section('Common Neuron API')

	const apiNeuron = await TextNeuron.create({
		model,
		instructions: 'Track coding patterns.',
		store: new MemoryNeuronStore(),
	})

	// Learning
	const learnResult = await apiNeuron.learn(['some batch data'])
	assert(learnResult.status !== undefined, 'learn() returns status')

	// Querying
	const qResult = await apiNeuron.query('test query')
	assert(typeof qResult.insight === 'string', 'query() returns insight')

	const qStream = await apiNeuron.queryStream('test query')
	assert(qStream.textStream !== undefined, 'queryStream() returns textStream')
	// consume stream
	for await (const _ of qStream.textStream) { break }

	// Understanding
	const uValue = await apiNeuron.getUnderstanding()
	assert(uValue !== undefined || uValue === null || typeof uValue === 'string', 'getUnderstanding() works')

	const summary = await apiNeuron.getSummary()
	assert(typeof summary === 'string', 'getSummary() returns string')

	const hasKnowledge = await apiNeuron.hasKnowledge()
	assert(typeof hasKnowledge === 'boolean', 'hasKnowledge() returns boolean')

	// Introspection
	const healthInfo = apiNeuron.getHealth()
	assert('activation' in healthInfo, 'getHealth() has activation')
	assert('status' in healthInfo, 'getHealth() has status')

	const metrics = apiNeuron.getMetrics()
	assert('ingestion' in metrics, 'getMetrics() has ingestion')
	assert('query' in metrics, 'getMetrics() has query')
	assert('dismissalRate' in metrics.ingestion, 'getMetrics().ingestion has dismissalRate')

	const evoHistory = await apiNeuron.getEvolution()
	assert(Array.isArray(evoHistory), 'getEvolution() returns array')

	const metadata = apiNeuron.getMetadata()
	assert(typeof metadata === 'object', 'getMetadata() returns object')

	// Config
	await apiNeuron.adjust('natural language directive')
	assert(true, 'adjust() succeeds')

	await apiNeuron.update({ instructions: 'new instructions' })
	assert(true, 'update() succeeds')

	// Identity
	assert(typeof apiNeuron.id === 'string', 'neuron.id is string')
	assert(typeof apiNeuron.name === 'string', 'neuron.name is string')
	assert(typeof apiNeuron.instructions === 'string', 'neuron.instructions is string')
	assert(typeof apiNeuron.description === 'string', 'neuron.description is string')
	assert(apiNeuron.type === 'text', 'neuron.type is text')
	assert(apiNeuron.origin === 'prompt' || apiNeuron.origin === 'developer' || apiNeuron.origin === 'emergent', 'neuron.origin is valid')

	// ── Learn Output — Discriminated Union ────────────────────────────────
	section('Learn Output — Discriminated Union')

	const learnNeuron = await TextNeuron.create({
		model,
		instructions: 'Track test patterns.',
		store: new MemoryNeuronStore(),
	})

	const learnOut = await learnNeuron.learn(['test data item'])

	switch (learnOut.status) {
		case 'synthesized':
			assert(typeof learnOut.evolution === 'string', 'synthesized: has evolution')
			console.log(`  What changed: ${learnOut.evolution}`)
			break
		case 'observe:dismissed':
			assert(Array.isArray(learnOut.gaps), 'dismissed: has gaps')
			break
		case 'synthesize:dismissed':
			assert(true, `learn returned status: ${learnOut.status}`)
			break
		default:
			assert(false, `unexpected learn status: ${learnOut.status}`)
	}

	await learnNeuron.dispose()
	await apiNeuron.dispose()
	await textNeuron.dispose()
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`04-neurons: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
