/**
 * Docs code test: reference/neuron-api.md
 *
 * Verifies all Neuron methods, result types, and identity properties
 * documented in the API reference actually exist and have the expected shape.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/reference-neuron-api.ts
 */

import { TextNeuron, MemoryNeuronStore } from '@unbody-io/adapt'
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
	// ── TextNeuron — Methods ─────────────────────────────────────────────
	section('TextNeuron — Lifecycle')

	const textNeuron = await TextNeuron.create({
		model,
		instructions: 'Track API test patterns.',
		store: new MemoryNeuronStore(),
	})

	// Lifecycle
	assert(typeof TextNeuron.create === 'function', 'TextNeuron.create() exists')
	assert(typeof TextNeuron.restore === 'function', 'TextNeuron.restore() exists')
	assert(typeof textNeuron.dispose === 'function', 'textNeuron.dispose() exists')
	assert(typeof textNeuron.isInitialized === 'function', 'textNeuron.isInitialized() exists')
	assert(textNeuron.isInitialized() === true, 'isInitialized() returns true after create()')

	// ── Learning ─────────────────────────────────────────────────────────
	section('TextNeuron — Learning')

	assert(typeof textNeuron.learn === 'function', 'textNeuron.learn() exists')

	const learnResult = await textNeuron.learn(['test data for API ref'])
	assert('status' in learnResult, 'LearnOutput has status')

	// Verify all possible status values
	const validStatuses = ['synthesized', 'observe:dismissed', 'synthesize:dismissed']
	assert(validStatuses.includes(learnResult.status), `LearnOutput.status is valid: ${learnResult.status}`)

	// learn() takes TextInput items too
	const inputResult = await textNeuron.learn([
		{ deliveryId: 'ref-1', text: 'more data', observedAt: new Date().toISOString() },
	])
	assert('status' in inputResult, 'learn(TextInput[]) returns LearnOutput')

	// Memory strategy
	const gov = textNeuron.getGovernance()
	assert(gov.strategy === 'continuous' && gov.maxTokens === 4000, 'getGovernance() returns neuron defaults')

	// Verify synthesized fields if we got a synthesized result
	if (inputResult.status === 'synthesized') {
		assert(typeof inputResult.newUnderstanding !== 'undefined', 'synthesized: has newUnderstanding')
		assert(typeof inputResult.significance === 'string', 'synthesized: has significance')
		assert(['routine', 'notable', 'critical'].includes(inputResult.significance), 'significance is valid enum')
		assert(typeof inputResult.evolution === 'string', 'synthesized: has evolution')
	}

	// ── Querying ─────────────────────────────────────────────────────────
	section('TextNeuron — Querying')

	assert(typeof textNeuron.query === 'function', 'textNeuron.query() exists')
	assert(typeof textNeuron.queryStream === 'function', 'textNeuron.queryStream() exists')

	// QueryResult shape
	const queryResult = await textNeuron.query('What patterns exist?')
	assert(typeof queryResult.relevant === 'boolean', 'QueryResult.relevant is boolean')
	assert(typeof queryResult.relevance === 'number', 'QueryResult.relevance is number')
	assert(typeof queryResult.confidence === 'number', 'QueryResult.confidence is number')
	assert(typeof queryResult.insight === 'string', 'QueryResult.insight is string')
	assert(typeof queryResult.gaps === 'string', 'QueryResult.gaps is string')
	assert(typeof queryResult.usage === 'object', 'QueryResult.usage is object')

	// queryStream
	const qStream = await textNeuron.queryStream('test stream')
	assert(qStream.textStream !== undefined, 'queryStream returns textStream')
	for await (const _ of qStream.textStream) { break }

	// ── Understanding ────────────────────────────────────────────────────
	section('TextNeuron — Understanding')

	assert(typeof textNeuron.getUnderstanding === 'function', 'getUnderstanding() exists')
	assert(typeof textNeuron.setUnderstanding === 'function', 'setUnderstanding() exists')
	assert(typeof textNeuron.getSummary === 'function', 'getSummary() exists')
	assert(typeof textNeuron.hasKnowledge === 'function', 'hasKnowledge() exists')

	const understanding = await textNeuron.getUnderstanding()
	assert(typeof understanding === 'string' || understanding === null, 'TextNeuron understanding is string or null')

	const summary = await textNeuron.getSummary()
	assert(typeof summary === 'string', 'getSummary() returns string')

	const hasKnowledge = await textNeuron.hasKnowledge()
	assert(typeof hasKnowledge === 'boolean', 'hasKnowledge() returns boolean')

	// ── Introspection ────────────────────────────────────────────────────
	section('TextNeuron — Introspection')

	assert(typeof textNeuron.getHealth === 'function', 'getHealth() exists')
	assert(typeof textNeuron.getMetrics === 'function', 'getMetrics() exists')
	assert(typeof textNeuron.getMetadata === 'function', 'getMetadata() exists')
	assert(typeof textNeuron.getEvolution === 'function', 'getEvolution() exists')
	assert(typeof textNeuron.getUnderstandThresholds === 'function', 'getUnderstandThresholds() exists')

	const health = textNeuron.getHealth()
	assert('activation' in health, 'NeuronHealth has activation')
	assert('status' in health, 'NeuronHealth has status')

	const metrics = textNeuron.getMetrics()
	assert('ingestion' in metrics, 'NeuronMetrics has ingestion')
	assert('query' in metrics, 'NeuronMetrics has query')
	assert('dismissalRate' in metrics.ingestion, 'NeuronMetrics.ingestion has dismissalRate')

	const evo = await textNeuron.getEvolution()
	assert(Array.isArray(evo), 'getEvolution() returns array')

	const thresholds = textNeuron.getUnderstandThresholds()
	assert(typeof thresholds === 'object', 'getUnderstandThresholds() returns object')

	// ── Config ───────────────────────────────────────────────────────────
	section('TextNeuron — Config')

	assert(typeof textNeuron.update === 'function', 'update() exists')
	assert(typeof textNeuron.adjust === 'function', 'adjust() exists')

	// AdjustResult shape
	const adjustResult = await textNeuron.adjust('Test adjustment directive')
	assert(Array.isArray(adjustResult.changedFields), 'AdjustResult.changedFields is array')
	assert(typeof adjustResult.adjustedConfig === 'boolean', 'AdjustResult.adjustedConfig is boolean')
	assert(typeof adjustResult.adjustedUnderstanding === 'boolean', 'AdjustResult.adjustedUnderstanding is boolean')

	// update() result
	const updateResult = await textNeuron.update({ instructions: 'Updated instructions.' })
	assert(Array.isArray(updateResult.changedFields), 'update() returns changedFields')

	// ── Identity ─────────────────────────────────────────────────────────
	section('TextNeuron — Identity')

	assert(typeof textNeuron.id === 'string', 'neuron.id is string')
	assert(textNeuron.type === 'text', 'neuron.type is "text"')
	assert(typeof textNeuron.name === 'string', 'neuron.name is string')
	assert(typeof textNeuron.description === 'string', 'neuron.description is string')
	assert(typeof textNeuron.instructions === 'string', 'neuron.instructions is string')
	assert(textNeuron.focus === null || typeof textNeuron.focus === 'string', 'neuron.focus is string or null')
	assert(textNeuron.origin === 'prompt' || textNeuron.origin === 'developer' || textNeuron.origin === 'emergent', 'neuron.origin is valid')

	await textNeuron.dispose()

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`reference-neuron-api: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
