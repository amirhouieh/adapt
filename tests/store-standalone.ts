/**
 * Store standalone test
 *
 * Tests the store module in complete isolation — no Brain, no LLM, no dependencies.
 * Verifies all Collection<T> operations across all 4 namespaces.
 * Runs the full suite against both MemoryNeuronStore and SQLiteNeuronStore.
 */

import {
	MemoryNeuronStore,
	type NeuronStore,
	type ObservationRecord,
	type UnderstandingRecord,
	type EvolutionRecord,
	type StateRecord,
	type NeuronCollection,
} from '../src'
import { SQLiteNeuronStore } from '../src/sqlite'

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

function assertEqual<T>(actual: T, expected: T, message: string) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (ok) {
		passed++
		console.log(`  ✓ ${message}`)
	} else {
		failed++
		console.log(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
	}
}

function section(title: string) {
	console.log(`\n━━━ ${title} ━━━`)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeObservation(
	id: string,
	data: unknown,
	importance: number,
	status: 'pending' | 'processed' = 'pending',
): ObservationRecord {
	return {
		id,
		data,
		metadata_importance: importance,
		metadata_tokens: typeof data === 'string' ? Math.ceil(data.length / 4) : 10,
		metadata_status: status,
		metadata_created_at: new Date().toISOString(),
	}
}

function makeUnderstanding(id: string, data: unknown, confidence = 0.8): UnderstandingRecord {
	const now = new Date().toISOString()
	return {
		id,
		data,
		metadata_confidence: confidence,
		metadata_created_at: now,
		metadata_updated_at: now,
	}
}

function makeEvolution(
	id: string,
	significance: 'routine' | 'notable' | 'critical',
	summary: string,
): EvolutionRecord {
	return { id, significance, summary, created_at: new Date().toISOString() }
}

function makeState(id: string, value: unknown): StateRecord {
	return { id, value, updated_at: new Date().toISOString() }
}

type CreateNeuronStore = () => NeuronStore

// ── Test: Collection CRUD (generic, works for any namespace) ────────────────

async function testCollectionCRUD<T extends { id: string }>(
	label: string,
	collection: NeuronCollection<T>,
	makeItem: (id: string) => T,
	makeChanges: () => Partial<Omit<T, 'id'>>,
) {
	section(`${label} — CRUD`)

	// starts empty
	assertEqual(await collection.count(), 0, 'starts empty')
	assertEqual(await collection.list(), [], 'list returns empty array')
	assertEqual(await collection.get('nonexistent'), undefined, 'get nonexistent returns undefined')

	// add
	const item1 = makeItem('item-1')
	const item2 = makeItem('item-2')
	const item3 = makeItem('item-3')
	await collection.add(item1)
	assertEqual(await collection.count(), 1, 'count is 1 after add')
	await collection.add(item2)
	await collection.add(item3)
	assertEqual(await collection.count(), 3, 'count is 3 after 3 adds')

	// get
	const retrieved = await collection.get('item-1')
	assert(retrieved !== undefined, 'get returns the item')
	assertEqual(retrieved?.id, 'item-1', 'get returns correct item by id')

	// list (no filter)
	const all = await collection.list()
	assertEqual(all.length, 3, 'list returns all items')
	assert(all.some(i => i.id === 'item-1'), 'list contains item-1')
	assert(all.some(i => i.id === 'item-2'), 'list contains item-2')
	assert(all.some(i => i.id === 'item-3'), 'list contains item-3')

	// list returns a copy, not a reference
	all.push(makeItem('rogue'))
	assertEqual(await collection.count(), 3, 'list returns a copy (push does not affect store)')

	// search (text across all string fields)
	const searchResults = await collection.search('item-2')
	assert(searchResults.length >= 1, 'search finds items containing query')
	const emptySearch = await collection.search('zzz_nonexistent_zzz')
	assertEqual(emptySearch.length, 0, 'search returns empty when no text match')

	// update
	const changes = makeChanges()
	await collection.update('item-2', changes)
	const updated = await collection.get('item-2')
	assert(updated !== undefined, 'updated item still exists')
	for (const [key, value] of Object.entries(changes)) {
		assertEqual((updated as any)[key], value, `update applied: ${key}`)
	}

	// update nonexistent throws
	let updateThrew = false
	try {
		await collection.update('nonexistent', changes)
	} catch {
		updateThrew = true
	}
	assert(updateThrew, 'update throws on nonexistent item')
	assertEqual(await collection.count(), 3, 'count unchanged after failed update')

	// delete
	await collection.delete('item-1')
	assertEqual(await collection.count(), 2, 'count decremented after delete')
	assertEqual(await collection.get('item-1'), undefined, 'deleted item is gone')

	// delete nonexistent throws
	let deleteThrew = false
	try {
		await collection.delete('item-1')
	} catch {
		deleteThrew = true
	}
	assert(deleteThrew, 'delete throws on nonexistent item')
	assertEqual(await collection.count(), 2, 'count unchanged after failed delete')

	// clear
	await collection.clear()
	assertEqual(await collection.count(), 0, 'count is 0 after clear')
	assertEqual(await collection.list(), [], 'list is empty after clear')

	// clear empty (should not throw)
	await collection.clear()
	assertEqual(await collection.count(), 0, 'clear on empty is safe')
}

// ── Test: list(filter) and count(filter) ────────────────────────────────────

async function testFiltering(createStore: CreateNeuronStore) {
	section('Filtering — list(filter) and count(filter)')

	const store = createStore()

	// Add observations with different statuses
	await store.observations.add(makeObservation('obs-1', 'first observation', 0.8, 'pending'))
	await store.observations.add(makeObservation('obs-2', 'second observation', 0.6, 'pending'))
	await store.observations.add(makeObservation('obs-3', 'third observation', 0.9, 'processed'))
	await store.observations.add(makeObservation('obs-4', 'fourth observation', 0.7, 'pending'))

	// list with filter
	const pending = await store.observations.list({ metadata_status: 'pending' })
	assertEqual(pending.length, 3, 'list(pending) returns 3 pending observations')
	assert(pending.every(o => o.metadata_status === 'pending'), 'all filtered items are pending')

	const processed = await store.observations.list({ metadata_status: 'processed' })
	assertEqual(processed.length, 1, 'list(processed) returns 1 processed observation')
	assertEqual(processed[0].id, 'obs-3', 'correct processed observation returned')

	// count with filter
	const pendingCount = await store.observations.count({ metadata_status: 'pending' })
	assertEqual(pendingCount, 3, 'count(pending) returns 3')

	const processedCount = await store.observations.count({ metadata_status: 'processed' })
	assertEqual(processedCount, 1, 'count(processed) returns 1')

	// count without filter
	const totalCount = await store.observations.count()
	assertEqual(totalCount, 4, 'count() returns total of 4')

	// list without filter
	const allObs = await store.observations.list()
	assertEqual(allObs.length, 4, 'list() returns all 4')

	await store.dispose()
}

// ── Test: addBatch ──────────────────────────────────────────────────────────

async function testAddBatch(createStore: CreateNeuronStore) {
	section('addBatch')

	const store = createStore()

	const observations = [
		makeObservation('batch-1', 'observation A', 0.5),
		makeObservation('batch-2', 'observation B', 0.6),
		makeObservation('batch-3', 'observation C', 0.7),
	]

	await store.observations.addBatch(observations)
	assertEqual(await store.observations.count(), 3, 'addBatch added 3 items')

	const first = await store.observations.get('batch-1')
	assert(first !== undefined, 'first batch item retrievable')
	assertEqual(first?.data, 'observation A', 'first batch item has correct data')

	await store.dispose()
}

// ── Test: Pipeline simulation (TextNeuron-style) ───────────────────────────

async function testTextPipeline(createStore: CreateNeuronStore) {
	section('Text pipeline simulation')

	const store = createStore()

	// 1. Store initial state
	await store.state.add(makeState('instructions', 'Track TypeScript best practices'))
	await store.state.add(makeState('observe_prompt', 'Observe TypeScript best practices'))

	assertEqual(await store.state.count(), 2, 'state has 2 entries after init')

	// 2. Observer produces observations → store them as pending
	await store.observations.add(makeObservation('obs-1', 'Prefer interfaces over type aliases for object shapes', 0.7))
	await store.observations.add(makeObservation('obs-2', 'Use readonly for immutable properties', 0.5))
	await store.observations.add(makeObservation('obs-3', 'Avoid enums, prefer const objects with as const', 0.8))

	assertEqual(await store.observations.count(), 3, '3 observations buffered')
	assertEqual(await store.observations.count({ metadata_status: 'pending' }), 3, 'all 3 are pending')

	// 3. Check threshold (buffer metrics from pending)
	const pending = await store.observations.list({ metadata_status: 'pending' })
	const avgImportance = pending.reduce((sum, o) => sum + o.metadata_importance, 0) / pending.length
	assert(avgImportance > 0.5, `avg importance ${avgImportance.toFixed(2)} above threshold`)

	// 4. Understand produces new understanding → store it
	await store.understanding.add(makeUnderstanding('understanding',
		'TypeScript best practices: prefer interfaces for object shapes, use readonly for immutability, avoid enums in favor of const objects.',
		0.9))

	assertEqual(await store.understanding.count(), 1, 'understanding has 1 record')
	const understanding = await store.understanding.get('understanding')
	assert(typeof understanding?.data === 'string' && understanding.data.includes('interfaces'), 'understanding contains observed content')

	// 5. Mark observations as processed (NOT deleted)
	for (const obs of pending) {
		await store.observations.update(obs.id, { metadata_status: 'processed' as const })
	}
	assertEqual(await store.observations.count({ metadata_status: 'pending' }), 0, 'no pending after processing')
	assertEqual(await store.observations.count({ metadata_status: 'processed' }), 3, 'all 3 are processed')
	assertEqual(await store.observations.count(), 3, 'observations NOT deleted, just marked')

	// 6. Track evolution
	await store.evolution.add(makeEvolution('evo-1', 'notable', 'Initial understanding of TypeScript patterns'))

	// 7. Second cycle — more observations
	await store.observations.add(makeObservation('obs-4', 'Use discriminated unions for type narrowing', 0.9))
	await store.observations.add(makeObservation('obs-5', 'Prefer unknown over any for type safety', 0.6))

	assertEqual(await store.observations.count({ metadata_status: 'pending' }), 2, '2 new pending observations')

	// 8. Understand again — update existing understanding record
	await store.understanding.update('understanding', {
		data: 'TypeScript best practices: prefer interfaces, use readonly, avoid enums, use discriminated unions, prefer unknown over any.',
		metadata_confidence: 0.95,
		metadata_updated_at: new Date().toISOString(),
	})

	const updatedUnderstanding = await store.understanding.get('understanding')
	assert(typeof updatedUnderstanding?.data === 'string' && updatedUnderstanding.data.includes('discriminated'), 'understanding updated with new content')
	assertEqual(updatedUnderstanding?.metadata_confidence, 0.95, 'confidence updated')

	// Mark second batch as processed
	const pending2 = await store.observations.list({ metadata_status: 'pending' })
	for (const obs of pending2) {
		await store.observations.update(obs.id, { metadata_status: 'processed' as const })
	}
	assertEqual(await store.observations.count({ metadata_status: 'processed' }), 5, 'all 5 observations now processed')

	await store.evolution.add(makeEvolution('evo-2', 'routine', 'Added type narrowing patterns'))
	assertEqual(await store.evolution.count(), 2, 'evolution tracks 2 entries')

	console.log('\n  Text pipeline simulation complete')

	await store.dispose()
}

// ── Test: Pipeline simulation (item-style) ───────────────────────────

async function testListPipeline(createStore: CreateNeuronStore) {
	section('List pipeline simulation')

	const store = createStore()

	// 1. Store initial state
	await store.state.add(makeState('instructions', 'Track technology stack: tools, frameworks, libraries'))

	// 2. Buffer observations
	await store.observations.add(makeObservation('obs-1', 'Migrated from Express to Hono for the API layer', 0.8))
	await store.observations.add(makeObservation('obs-2', 'Using PostgreSQL 15 with Drizzle ORM', 0.6))
	await store.observations.add(makeObservation('obs-3', 'Frontend is Next.js 14 with React 18', 0.7))

	// 3. Understand produces list items → store them
	await store.understanding.add(makeUnderstanding('item-1', { name: 'Hono', category: 'API Framework', status: 'active' }, 0.9))
	await store.understanding.add(makeUnderstanding('item-2', { name: 'PostgreSQL 15', category: 'Database', status: 'active' }, 0.85))
	await store.understanding.add(makeUnderstanding('item-3', { name: 'Next.js 14', category: 'Frontend', status: 'active' }, 0.8))
	await store.understanding.add(makeUnderstanding('item-4', { name: 'React 18', category: 'UI Library', status: 'active' }, 0.8))

	assertEqual(await store.understanding.count(), 4, '4 items in understanding')

	// Mark observations as processed
	const pending = await store.observations.list({ metadata_status: 'pending' })
	for (const obs of pending) {
		await store.observations.update(obs.id, { metadata_status: 'processed' as const })
	}

	await store.evolution.add(makeEvolution('evo-1', 'notable', 'Initial tech stack captured'))

	// 4. Update existing item
	await store.understanding.update('item-3', {
		data: { name: 'Next.js 15', category: 'Frontend', status: 'active', note: 'Upgraded' },
		metadata_updated_at: new Date().toISOString(),
	})

	const updated = await store.understanding.get('item-3')
	assertEqual((updated?.data as any)?.name, 'Next.js 15', 'item updated: Next.js 14 → 15')

	// 5. Add new item
	await store.understanding.add(makeUnderstanding('item-5', { name: 'Tailwind CSS', category: 'CSS', status: 'active' }, 0.75))
	assertEqual(await store.understanding.count(), 5, '5 items after add')

	// 6. Remove item
	await store.understanding.delete('item-4')
	assertEqual(await store.understanding.count(), 4, '4 items after removal')
	assertEqual(await store.understanding.get('item-4'), undefined, 'removed item is gone')

	// 7. Search
	const honoResults = await store.understanding.search('Hono')
	assertEqual(honoResults.length, 1, 'search: found Hono')
	assertEqual((honoResults[0].data as any).name, 'Hono', 'search: correct item returned')

	// 8. List all understanding
	const allItems = await store.understanding.list()
	const names = allItems.map(i => (i.data as any).name).sort()
	assert(names.includes('Hono'), 'Hono in stack')
	assert(names.includes('Next.js 15'), 'Next.js 15 in stack (updated)')
	assert(names.includes('Tailwind CSS'), 'Tailwind added')

	console.log('\n  List pipeline simulation complete')

	await store.dispose()
}

// ── Test: Cross-namespace isolation ─────────────────────────────────────────

async function testIsolation(createStore: CreateNeuronStore) {
	section('Cross-namespace isolation')

	const store = createStore()

	await store.understanding.add(makeUnderstanding('u-1', 'some understanding'))
	await store.observations.add(makeObservation('obs-1', 'some observation', 0.5))
	await store.evolution.add(makeEvolution('evo-1', 'routine', 'some evolution'))
	await store.state.add(makeState('key-1', 'some state'))

	// Clear one namespace, others unaffected
	await store.observations.clear()
	assertEqual(await store.observations.count(), 0, 'observations cleared')
	assertEqual(await store.understanding.count(), 1, 'understanding unaffected')
	assertEqual(await store.evolution.count(), 1, 'evolution unaffected')
	assertEqual(await store.state.count(), 1, 'state unaffected')

	// Delete from one namespace, others unaffected
	await store.understanding.delete('u-1')
	assertEqual(await store.understanding.count(), 0, 'understanding removed')
	assertEqual(await store.evolution.count(), 1, 'evolution still unaffected')
	assertEqual(await store.state.count(), 1, 'state still unaffected')

	await store.dispose()
}

// ── Test: Two stores are independent ────────────────────────────────────────

async function testStoreIndependence(createStore: CreateNeuronStore) {
	section('Store independence (two stores do not share data)')

	const store1 = createStore()
	const store2 = createStore()

	await store1.observations.add(makeObservation('obs-1', 'only in store1', 0.5))
	await store2.observations.add(makeObservation('obs-2', 'only in store2', 0.6))
	await store2.observations.add(makeObservation('obs-3', 'also in store2', 0.7))

	assertEqual(await store1.observations.count(), 1, 'store1 has 1 observation')
	assertEqual(await store2.observations.count(), 2, 'store2 has 2 observations')
	assertEqual(await store1.observations.get('obs-2'), undefined, 'store1 cannot see store2 data')
	assertEqual(await store2.observations.get('obs-1'), undefined, 'store2 cannot see store1 data')

	await store1.dispose()
	await store2.dispose()
}

// ── Test: dispose ───────────────────────────────────────────────────────────

async function testDispose(createStore: CreateNeuronStore) {
	section('dispose')

	const store = createStore()
	await store.observations.add(makeObservation('obs-1', 'test', 0.5))

	// dispose should not throw
	await store.dispose()
	passed++
	console.log('  ✓ dispose completes without error')
}

// ── Run all tests for a given adapter ───────────────────────────────────────

async function runSuite(adapterName: string, createStore: CreateNeuronStore) {
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`  ${adapterName}`)
	console.log('═'.repeat(60))

	// Generic CRUD tests for each namespace (fresh store per namespace)
	const s1 = createStore()
	await testCollectionCRUD(
		'observations',
		s1.observations,
		(id) => makeObservation(id, `observation ${id}`, 0.5 + Math.random() * 0.5),
		() => ({ data: 'updated content', metadata_importance: 0.99 }),
	)
	await s1.dispose()

	const s2 = createStore()
	await testCollectionCRUD(
		'evolution',
		s2.evolution,
		(id) => makeEvolution(id, 'routine', `evolution ${id}`),
		() => ({ significance: 'critical' as const, summary: 'updated summary' }),
	)
	await s2.dispose()

	const s3 = createStore()
	await testCollectionCRUD(
		'state',
		s3.state,
		(id) => makeState(id, { key: id }),
		() => ({ value: 'updated value' }),
	)
	await s3.dispose()

	const s4 = createStore()
	await testCollectionCRUD(
		'understanding',
		s4.understanding,
		(id) => makeUnderstanding(id, `understanding ${id}`),
		() => ({ data: 'updated understanding', metadata_confidence: 0.95 }),
	)
	await s4.dispose()

	// Feature-specific tests
	await testFiltering(createStore)
	await testAddBatch(createStore)

	// Pipeline simulations
	await testTextPipeline(createStore)
	await testListPipeline(createStore)

	// Isolation & independence
	await testIsolation(createStore)
	await testStoreIndependence(createStore)

	// Dispose
	await testDispose(createStore)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log('Store standalone test\n')

	await runSuite('MemoryNeuronStore', () => new MemoryNeuronStore())
	await runSuite('SQLiteNeuronStore', () => new SQLiteNeuronStore())

	// Summary
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`  ${passed} passed, ${failed} failed`)
	console.log('═'.repeat(60))

	if (failed > 0) {
		process.exit(1)
	}
}

main()
