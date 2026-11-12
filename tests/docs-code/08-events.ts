/**
 * Docs code test: events.md (Events & Lifecycle)
 *
 * Verifies every TypeScript code block from the Events & Lifecycle guide
 * compiles and runs correctly. The lifecycle content is prose/diagrams only —
 * the executable assertions all come from the event subscription patterns.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/08-events.ts
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
	const brain = await Brain.create({
		prompt: 'Track event test patterns.',
		model,
		evolution: { enabled: false },
		autoSetup: false,
		neurons: [
			{ id: 'events', type: 'text', name: 'Events', description: 'Event patterns', instructions: 'Track event patterns.' },
		],
	})

	// ── Specific Event (typed) ───────────────────────────────────────────
	section('Specific Event Subscription')

	let synthesizedFired = false
	brain.on('neuron:synthesized', (payload) => {
		synthesizedFired = true
		assert(typeof payload.neuronId === 'string', 'neuron:synthesized payload has neuronId')
		assert(typeof payload.significance === 'string', 'neuron:synthesized payload has significance')
		assert(typeof payload.evolution === 'string', 'neuron:synthesized payload has evolution')
		console.log(`  ${payload.neuronId}: ${payload.significance} — ${payload.evolution}`)
	})
	assert(true, 'brain.on(specific event) registers without error')

	// ── All Events ───────────────────────────────────────────────────────
	section('All Events Subscription')

	const allEvents: string[] = []
	brain.on((event) => {
		allEvents.push(event.type)
		// Verify event shape
		assert(typeof event.type === 'string', `event has type: ${event.type}`)
		assert(typeof event.id === 'string', 'event has id')
		assert(typeof event.timestamp === 'string' || typeof event.timestamp === 'number', 'event has timestamp')
	})
	assert(true, 'brain.on(all events) registers without error')

	// ── Trigger some events via inject ────────────────────────────────────
	section('Trigger Events via inject')

	await brain.inject([
		'test: Event trigger data 1',
		'test: Event trigger data 2',
	])

	assert(allEvents.length > 0, `Events fired during inject: ${allEvents.length} events`)
	assert(allEvents.includes('brain:inject:started'), 'brain:inject:started event fired')
	assert(allEvents.includes('brain:inject:completed'), 'brain:inject:completed event fired')

	// ── Forwarding Pattern ───────────────────────────────────────────────
	section('Forwarding Pattern')

	// Simulate forwarding to a UI (Electron or SSE)
	const forwarded: Array<Record<string, unknown>> = []
	brain.on((event) => {
		forwarded.push({
			type: event.type,
			...event.payload as Record<string, unknown>,
		})
	})

	await brain.inject(['forward-test'])
	assert(forwarded.length > 0, 'Events forwarded to simulated UI')

	// ── Neuron Mgmt — status:changed event ───────────────────────────────
	section('Neuron Mgmt status:changed Event')

	let statusChangedPayload: { neuronId: string; previousStatus: string; newStatus: string } | null = null
	brain.on('brain:neuron:status:changed', (payload) => {
		statusChangedPayload = payload
	})

	await brain.pauseNeuron('events')
	assert(statusChangedPayload !== null, 'brain:neuron:status:changed fired on pauseNeuron')
	const captured = statusChangedPayload as { neuronId: string; previousStatus: string; newStatus: string } | null
	if (captured) {
		assert(captured.neuronId === 'events', 'status:changed payload has neuronId')
		assert(captured.previousStatus === 'active', 'status:changed payload has previousStatus')
		assert(captured.newStatus === 'inactive', 'status:changed payload has newStatus')
	}

	await brain.resumeNeuron('events')

	await brain.dispose()

	// ── Catching init events (onEvent) ───────────────────────────────────
	section('Catching init events (onEvent)')

	const initEvents: string[] = []
	const initBrain = await Brain.create({
		prompt: 'Track init event patterns.',
		model,
		evolution: { enabled: false },
		autoSetup: false,
		neurons: [
			{ id: 'init-events', type: 'text', name: 'Init Events', description: 'Init event patterns', instructions: 'Track init event patterns.' },
		],
		onEvent: (event) => { initEvents.push(event.type) },
	})
	assert(initEvents.includes('brain:init:started'), 'onEvent caught brain:init:started')
	assert(initEvents.includes('brain:init:completed'), 'onEvent caught brain:init:completed')
	await initBrain.dispose()

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`08-events: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
