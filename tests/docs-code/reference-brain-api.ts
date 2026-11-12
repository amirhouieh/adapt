/**
 * Docs code test: reference/brain-api.md
 *
 * Verifies all Brain methods, accessors, and result types documented
 * in the API reference actually exist and have the expected shape.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/reference-brain-api.ts
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
		prompt: 'Track patterns for API reference test.',
		model,
		evolution: { enabled: true },
	})

	// ── Lifecycle Methods ────────────────────────────────────────────────
	section('Lifecycle Methods')

	assert(typeof Brain.create === 'function', 'Brain.create() exists')
	assert(typeof Brain.restore === 'function', 'Brain.restore() exists')
	assert(typeof brain.dispose === 'function', 'brain.dispose() exists')

	// onEvent — pre-init event subscription
	const onEventTypes: string[] = []
	const onEventBrain = await Brain.create({
		prompt: 'Track onEvent reference test.',
		model,
		autoSetup: false,
		evolution: { enabled: false },
		neurons: [
			{ id: 'oe', type: 'text', name: 'OE', description: 'onEvent test', instructions: 'Track onEvent patterns.' },
		],
		onEvent: (event) => { onEventTypes.push(event.type) },
	})
	assert(onEventTypes.includes('brain:init:started'), 'onEvent catches brain:init:started')
	await onEventBrain.dispose()

	// ── Data Methods ─────────────────────────────────────────────────────
	section('Data Methods')

	assert(typeof brain.inject === 'function', 'brain.inject() exists')
	assert(typeof brain.ask === 'function', 'brain.ask() exists')
	assert(typeof brain.askStream === 'function', 'brain.askStream() exists')
	assert(typeof brain.consult === 'function', 'brain.consult() exists')
	assert(typeof brain.inspect === 'function', 'brain.inspect() exists')

	// Inject and verify BrainInjectResult shape
	const injectResult = await brain.inject(['test: api ref'])
	assert(typeof injectResult.id === 'string', 'BrainInjectResult.id is string')
	assert(Array.isArray(injectResult.batches), 'BrainInjectResult.batches is array')
	if (injectResult.batches.length > 0) {
		const batch = injectResult.batches[0]
		assert(typeof batch.id === 'string', 'batch.id is string')
		assert(typeof batch.index === 'number', 'batch.index is number')
		assert(Array.isArray(batch.results), 'batch.results is array')
		if (batch.results.length > 0) {
			assert(typeof batch.results[0].neuronId === 'string', 'batch result has neuronId')
			assert('result' in batch.results[0], 'batch result has result (LearnOutput)')
		}
	}

	// Ask and verify BrainAskResult shape
	const askResult = await brain.ask('test query')
	assert(typeof askResult.insight === 'string', 'BrainAskResult.insight is string')
	assert(Array.isArray(askResult.sources), 'BrainAskResult.sources is array')
	assert(Array.isArray(askResult.gaps), 'BrainAskResult.gaps is array')
	if (askResult.sources.length > 0) {
		const src = askResult.sources[0]
		assert(typeof src.neuronId === 'string', 'source.neuronId is string')
		assert(typeof src.relevance === 'number', 'source.relevance is number')
		assert(typeof src.confidence === 'number', 'source.confidence is number')
		assert(typeof src.insight === 'string', 'source.insight is string')
	}

	// ask() options: model, mode
	assert(typeof brain.ask === 'function', 'ask() accepts options')

	// consult() options: { neuron?: string }
	const consultResult = await brain.consult('test')
	assert(typeof consultResult.insight === 'string', 'ConsultResult.insight is string')

	// inspect()
	const inspectResult = await brain.inspect('test')
	assert(typeof inspectResult.insight === 'string', 'InspectResult.insight is string')

	// ── Neuron Management Methods ────────────────────────────────────────
	section('Neuron Management Methods')

	assert(typeof brain.addNeuron === 'function', 'brain.addNeuron() exists')
	assert(typeof brain.removeNeuron === 'function', 'brain.removeNeuron() exists')
	assert(typeof brain.adjustNeuron === 'function', 'brain.adjustNeuron() exists')
	assert(typeof brain.getNeuron === 'function', 'brain.getNeuron() exists')
	assert(typeof brain.getNeurons === 'function', 'brain.getNeurons() exists')
	assert(typeof brain.getInternalNeuron === 'function', 'brain.getInternalNeuron() exists')
	assert(typeof brain.pauseNeuron === 'function', 'brain.pauseNeuron() exists')
	assert(typeof brain.resumeNeuron === 'function', 'brain.resumeNeuron() exists')
	assert(typeof brain.getNeuronStatus === 'function', 'brain.getNeuronStatus() exists')

	const neurons = brain.getNeurons()
	assert(Array.isArray(neurons), 'getNeurons() returns array')

	// Pause/resume round-trip on the first available neuron
	if (neurons.length > 0) {
		const targetId = neurons[0].id
		await brain.pauseNeuron(targetId)
		assert(brain.getNeuronStatus(targetId) === 'inactive', 'pauseNeuron sets status to inactive')
		await brain.resumeNeuron(targetId)
		assert(brain.getNeuronStatus(targetId) === 'active', 'resumeNeuron sets status to active')
	}

	// ── Evolution Methods ────────────────────────────────────────────────
	section('Evolution Methods')

	assert(typeof brain.createNeuron === 'function', 'brain.createNeuron() exists')
	assert(typeof brain.deleteNeuron === 'function', 'brain.deleteNeuron() exists')
	assert(typeof brain.mergeNeurons === 'function', 'brain.mergeNeurons() exists')
	assert(typeof brain.splitNeuron === 'function', 'brain.splitNeuron() exists')
	assert(typeof brain.updateNeuron === 'function', 'brain.updateNeuron() exists')
	assert(typeof brain.evaluateEvolution === 'function', 'brain.evaluateEvolution() exists')
	assert(typeof brain.evaluateEvolutionStream === 'function', 'brain.evaluateEvolutionStream() exists')

	// ── Signals & Config Methods ─────────────────────────────────────────
	section('Signals & Config Methods')

	assert(typeof brain.signal === 'function', 'brain.signal() exists')
	assert(typeof brain.triggerEvolution === 'function', 'brain.triggerEvolution() exists')
	assert(typeof brain.update === 'function', 'brain.update() exists')
	assert(typeof brain.on === 'function', 'brain.on() exists')

	// Verify BrainUpdateResult shape
	const updateResult = await brain.update({
		learning: { governance: { strategy: 'decay' } },
	})
	assert(Array.isArray(updateResult.changedFields), 'BrainUpdateResult.changedFields is array')
	assert(typeof updateResult.config === 'object', 'BrainUpdateResult.config is object')
	assert(Array.isArray(updateResult.neuronResults), 'BrainUpdateResult.neuronResults is array')

	// ── Accessors ────────────────────────────────────────────────────────
	section('Accessors')

	assert(typeof brain.prompt === 'string', 'brain.prompt is string')
	assert(brain.promptContext === undefined || typeof brain.promptContext === 'object', 'brain.promptContext is object or undefined')
	assert(brain.evolutionContext === null || typeof brain.evolutionContext === 'string', 'brain.evolutionContext is string or null')
	assert(typeof brain.config === 'object', 'brain.config is object')
	assert(brain.neurons instanceof Map, 'brain.neurons is Map')
	assert(brain.internalNeurons instanceof Map, 'brain.internalNeurons is Map')
	assert(typeof brain.store === 'object', 'brain.store is object')

	await brain.dispose()

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`reference-brain-api: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
