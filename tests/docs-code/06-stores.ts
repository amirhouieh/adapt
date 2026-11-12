/**
 * Docs code test: 06-stores.md
 *
 * Verifies every TypeScript code block from the Stores guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/06-stores.ts
 */

import {
	Brain,
	MemoryBrainStore,
	MemoryNeuronStore,
	type NeuronStore,
} from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'
import { model } from '../../evals/helpers/provider'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, '..', '.tmp-docs-06')

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
		// ── Memory Stores (default) ───────────────────────────────────────
		section('Memory Stores')

		const memBrain = await Brain.create({
			prompt: 'Test memory stores.',
			model,
			store: new MemoryBrainStore(),
		})
		assert(memBrain instanceof Brain, 'Brain with MemoryBrainStore + MemoryNeuronStore created')
		await memBrain.dispose()

		// ── SQLite Stores ────────────────────────────────────────────────
		section('SQLite Stores')

		const sqlBrain = await Brain.create({
			prompt: 'Test SQLite stores.',
			model,
			store: new SQLiteBrainStore(join(tmpDir, 'brain.db')),
		})
		assert(sqlBrain instanceof Brain, 'Brain with SQLiteBrainStore + sibling neuron stores created')
		await sqlBrain.dispose()

		// ── Hierarchical Persistence ─────────────────────────────────────
		section('Hierarchical Persistence')

		const entityId = 'entity-1'
		const entityDir = join(tmpDir, entityId)
		mkdirSync(entityDir, { recursive: true })

		const hierBrain = await Brain.create({
			prompt: 'Test hierarchical persistence.',
			model,
			store: new SQLiteBrainStore(join(entityDir, 'brain.db')),
		})
		assert(hierBrain instanceof Brain, 'Hierarchical persistence Brain created')
		await hierBrain.dispose()

		// ── Persistence Across Sessions ──────────────────────────────────
		section('Persistence Across Sessions')

		const brainDb = join(tmpDir, 'persist-brain.db')

		// Session 1: create and learn
		const brain1 = await Brain.create({
			prompt: 'Track session persistence test.',
			model,
			store: new SQLiteBrainStore(brainDb),
		})
		await brain1.inject(['note: Session 1 data — persistence test'])
		assert(true, 'Session 1: brain initialized and data injected')
		await brain1.dispose()

		// Session 2: restore and continue. The runtime arg rehydrates persisted
		// model refs through the LLM plugin (matches the docs example).
		const brain2 = await Brain.restore(brainDb, { model })
		const answer = await brain2.ask('What do you know?')
		assert(typeof answer.insight === 'string', 'Session 2: brain restored and can answer')
		console.log(`  Session 2 insight: ${answer.insight.slice(0, 80)}...`)
		await brain2.dispose()

		// ── NeuronStore Interface — Type Check ───────────────────────────
		section('NeuronStore / BrainStore Interface Types')

		// Verify these types are importable and usable
		const memStore: NeuronStore = new MemoryNeuronStore()
		assert('observations' in memStore, 'NeuronStore has observations namespace')
		assert('understanding' in memStore, 'NeuronStore has understanding namespace')
		assert('evolution' in memStore, 'NeuronStore has evolution namespace')
		assert('state' in memStore, 'NeuronStore has state namespace')
		assert(typeof memStore.dispose === 'function', 'NeuronStore has dispose()')

		// Verify NeuronCollection CRUD interface
		const coll = memStore.observations
		assert(typeof coll.add === 'function', 'NeuronCollection has add()')
		assert(typeof coll.get === 'function', 'NeuronCollection has get()')
		assert(typeof coll.list === 'function', 'NeuronCollection has list()')
		assert(typeof coll.update === 'function', 'NeuronCollection has update()')
		assert(typeof coll.delete === 'function', 'NeuronCollection has delete()')
		assert(typeof coll.clear === 'function', 'NeuronCollection has clear()')
		assert(typeof coll.count === 'function', 'NeuronCollection has count()')
		assert(typeof coll.search === 'function', 'NeuronCollection has search()')
		assert(typeof coll.addBatch === 'function', 'NeuronCollection has addBatch()')

		await memStore.dispose()

		// BrainStore interface
		const brainStore = new MemoryBrainStore()
		assert('state' in brainStore, 'BrainStore has state namespace')
		assert('neurons' in brainStore, 'BrainStore has neurons namespace')
		assert('internalNeurons' in brainStore, 'BrainStore has internalNeurons namespace')
		assert('evolution' in brainStore, 'BrainStore has evolution namespace')
		assert('dismissedBatches' in brainStore, 'BrainStore has dismissedBatches namespace')
		assert(typeof brainStore.getNeuronStore === 'function', 'BrainStore has getNeuronStore()')
		assert(typeof brainStore.dispose === 'function', 'BrainStore has dispose()')

		// getNeuronStore returns a usable NeuronStore and caches per id
		const ns1 = brainStore.getNeuronStore('neuron-a')
		const ns2 = brainStore.getNeuronStore('neuron-a')
		assert(ns1 === ns2, 'getNeuronStore() caches per neuron id')
		assert('observations' in ns1, 'derived NeuronStore has observations namespace')

		await brainStore.dispose()
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`06-stores: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
