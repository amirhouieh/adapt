/**
 * Docs code test: 03-brain.md
 *
 * Verifies every TypeScript code block from the Brain guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/03-brain.ts
 */

import { Brain, MemoryNeuronStore, TextNeuron, createAiSdkLLM } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'
import { model } from '../../evals/helpers/provider'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, '..', '.tmp-docs-03')

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
		// ── Creating a Brain ──────────────────────────────────────────────────
		section('Creating a Brain')

		// Minimal — only prompt and model required
		const brain1 = await Brain.create({
			prompt: 'Track user coding patterns and development philosophy.',
			model,
		})
		assert(brain1 instanceof Brain, 'Brain created with minimal config')
		await brain1.dispose()

		// Full config with SQLite
		const brain2 = await Brain.create({
			prompt: 'Track user coding patterns and development philosophy.',
			model,
			store: new SQLiteBrainStore(join(tmpDir, 'brain.db')),
			evolution: { enabled: true },
		})
		assert(brain2 instanceof Brain, 'Brain created with full config')
		assert(true, 'Brain.create() succeeds')

		await brain2.dispose()

		// ── Fresh vs Restored ────────────────────────────────────────────────
		section('Fresh vs Restored')

		const restorePath = join(tmpDir, 'restore.db')

		// Fresh — runs LLM decomposition, persists to the store
		const fresh = await Brain.create({
			prompt: 'Track restore-roundtrip patterns.',
			model,
			store: new SQLiteBrainStore(restorePath),
		})
		assert(fresh instanceof Brain, 'Brain.create() persists to disk')
		await fresh.dispose()

		// Restore — path-string sugar with runtime model
		const restoredFromPath = await Brain.restore(restorePath, { model })
		assert(restoredFromPath instanceof Brain, 'Brain.restore(path, { model }) succeeds')
		await restoredFromPath.dispose()

		// Restore — explicit BrainStore instance with runtime model
		const restoredFromStore = await Brain.restore(
			new SQLiteBrainStore(restorePath),
			{ model },
		)
		assert(restoredFromStore instanceof Brain, 'Brain.restore(store, { model }) succeeds')
		await restoredFromStore.dispose()

		// ── BYO LLM runtime ──────────────────────────────────────────────────
		section('BYO LLM runtime')

		const llm = createAiSdkLLM()
		const byoBrain = await Brain.create({
			prompt: 'BYO LLM smoke test.',
			model,
			llm,
			autoSetup: false,
			neurons: [
				{ id: 'byo', type: 'text', name: 'BYO', description: 'Smoke', instructions: 'Track patterns.' },
			],
			evolution: { enabled: false },
		})
		assert(byoBrain instanceof Brain, 'Brain.create({ llm }) succeeds')
		const byoPath = join(tmpDir, 'byo.db')
		await byoBrain.dispose()

		// Restore with the same llm plugin
		const byoFresh = await Brain.create({
			prompt: 'BYO LLM restore test.',
			model,
			llm,
			store: new SQLiteBrainStore(byoPath),
			autoSetup: false,
			neurons: [
				{ id: 'byo', type: 'text', name: 'BYO', description: 'Smoke', instructions: 'Track patterns.' },
			],
			evolution: { enabled: false },
		})
		await byoFresh.dispose()

		const byoRestored = await Brain.restore(byoPath, { llm })
		assert(byoRestored instanceof Brain, 'Brain.restore(path, { llm }) succeeds')
		await byoRestored.dispose()

		// ── Injecting Data ───────────────────────────────────────────────────
		section('Injecting Data')

		// Use explicit neurons to keep neuron count low and reduce concurrent LLM calls
		const brain = await Brain.create({
			prompt: 'Track user coding patterns and development philosophy.',
			model,
			evolution: { enabled: false },
			autoSetup: false,
			neurons: [
				{ id: 'coding', type: 'text', name: 'Coding', description: 'Coding patterns', instructions: 'Track coding patterns and development philosophy.' },
			],
		})

		// Array or single item — plain text
		await brain.inject([
			'note: Users prefer dark mode',
			'commit: refactor: move to composition API',
		])
		assert(true, 'brain.inject() with array succeeds')

		// With custom ID
		await brain.inject(['test'], { id: 'session-42' })
		assert(true, 'brain.inject() with custom ID succeeds')

		// Structured data — good pattern from docs
		await brain.inject([
			`bookmark (saved 2025-03-01): "Local-First Software" — https://example.com/local-first
highlights: CRDTs enable...; Offline-first is...
tags: architecture, sync`,
		])
		assert(true, 'brain.inject() with self-describing text succeeds')

		// ── Querying ─────────────────────────────────────────────────────────
		section('Querying')

		const result = await brain.ask('What patterns do you see?')
		assert(typeof result.insight === 'string', 'result.insight is string')
		assert(Array.isArray(result.sources), 'result.sources is array')
		assert(Array.isArray(result.gaps), 'result.gaps is array')

		if (result.sources.length > 0) {
			const s = result.sources[0]
			assert(typeof s.neuronId === 'string', 'source.neuronId is string')
			assert(typeof s.relevance === 'number', 'source.relevance is number')
			assert(typeof s.confidence === 'number', 'source.confidence is number')
			assert(typeof s.insight === 'string', 'source.insight is string')
		}

		// Default — fast, parallel
		const directResult = await brain.ask('What patterns do you see?')
		assert(typeof directResult.insight === 'string', 'direct mode ask works')

		// Agentic — multi-step, selective
		const deep = await brain.ask('What patterns do you see?', { mode: 'deep' })
		assert(typeof deep.insight === 'string', 'deep mode ask works')

		// Override model per-call
		const modelOverride = await brain.ask('What?', { model })
		assert(typeof modelOverride.insight === 'string', 'ask with model override works')

		// ── Streaming ────────────────────────────────────────────────────────
		section('Streaming')

		// Stream a brain query — textStream
		const stream1 = await brain.askStream('What patterns do you see?')
		let streamedText = ''
		for await (const chunk of stream1.textStream) {
			streamedText += chunk
		}
		assert(streamedText.length > 0, 'askStream textStream produces text')

		// Stream deep mode — fullStream
		const stream2 = await brain.askStream('What patterns?', { mode: 'deep' })
		let deepStreamParts = 0
		for await (const part of stream2.fullStream) {
			deepStreamParts++
			// Verify part.type exists (text-delta, tool-call, tool-result, etc.)
			assert(typeof part.type === 'string', `fullStream part has type: ${part.type}`)
			break // just verify first part
		}

		// Resolved promises after stream
		const text = await stream2.text
		assert(typeof text === 'string', 'stream.text resolves to string')
		const usage = await stream2.usage
		assert(usage !== undefined, 'stream.usage resolves')

		// ── Consulting Internal Neurons ───────────────────────────────────────
		section('Consulting Internal Neurons')

		const meta = await brain.consult('What cross-domain patterns have emerged?')
		assert(typeof meta.insight === 'string', 'consult() returns insight')

		// Target a specific internal neuron
		const gaps = await brain.consult('What knowledge gaps exist?', {
			neuron: '__internal_injection_gaps',
		})
		assert(typeof gaps.insight === 'string', 'consult() with specific neuron works')

		// Internal neuron config
		const brainWithInternalConfig = await Brain.create({
			prompt: 'Test internal neuron config.',
			model,
			internalNeurons: {
				globalUnderstanding: true,
				globalQueryUnderstanding: false,
				injectionGaps: { governance: { maxTokens: 4000 } },
				queryGaps: true,
			},
		})
		assert(brainWithInternalConfig instanceof Brain, 'Brain with internalNeurons config created')
		await brainWithInternalConfig.dispose()

		// ── Inspecting the Brain ─────────────────────────────────────────────
		section('Inspecting the Brain')

		const inspectResult = await brain.inspect('What are you learning and tracking?')
		assert(typeof inspectResult.insight === 'string', 'inspect() returns insight')

		const health = await brain.inspect('Which neurons have the most gaps?')
		assert(typeof health.insight === 'string', 'inspect() deeper question works')

		// ── Managing Neurons ─────────────────────────────────────────────────
		section('Managing Neurons — Basic')

		// Add with explicit config
		const neuron = await brain.addNeuron({
			id: 'ui-patterns',
			type: 'text',
			name: 'UI Patterns',
			description: 'Tracks UI/UX design patterns',
			instructions: 'Track user interface patterns, component choices, and design decisions.',
		})
		assert(neuron.id === 'ui-patterns', 'addNeuron() returns neuron with correct id')

		// Adjust with natural language
		await brain.adjustNeuron('ui-patterns', 'Focus more on accessibility patterns')
		assert(true, 'adjustNeuron() succeeds')

		// Remove
		await brain.removeNeuron('ui-patterns')
		assert(brain.getNeuron('ui-patterns') === undefined, 'removeNeuron() removes the neuron')

		// Inspect
		const allNeurons = brain.getNeurons()
		assert(Array.isArray(allNeurons), 'getNeurons() returns array')

		// ── Pausing Neurons ───────────────────────────────────────────────────
		section('Pausing Neurons')

		await brain.pauseNeuron('coding')
		assert(brain.getNeuronStatus('coding') === 'inactive', 'pauseNeuron sets status to inactive')

		await brain.resumeNeuron('coding')
		assert(brain.getNeuronStatus('coding') === 'active', 'resumeNeuron sets status to active')

		// ── Managing Neurons — Evolution ──────────────────────────────────────
		section('Managing Neurons — Evolution')

		const evoBrain = await Brain.create({
			prompt: 'Track frontend and backend patterns.',
			model,
			evolution: { enabled: true },
			autoSetup: false,
			neurons: [
				{ id: 'react-neuron', type: 'text', name: 'React', description: 'React patterns', instructions: 'Track React patterns.' },
				{ id: 'vue-neuron', type: 'text', name: 'Vue', description: 'Vue patterns', instructions: 'Track Vue patterns.' },
				{ id: 'broad-neuron', type: 'text', name: 'Broad', description: 'Broad patterns', instructions: 'Track broad patterns.' },
				{ id: 'neuron-x', type: 'text', name: 'X', description: 'X patterns', instructions: 'Track X patterns.' },
				{ id: 'neuron-y', type: 'text', name: 'Y', description: 'Y patterns', instructions: 'Track Y patterns.' },
			],
		})

		// LLM designs the neuron from guidance
		const created = await evoBrain.createNeuron('Track emerging frontend frameworks')
		assert(typeof created.id === 'string', 'createNeuron() returns neuron with id')

		// Merge overlapping neurons
		const merged = await evoBrain.mergeNeurons(
			['react-neuron', 'vue-neuron'],
			'Combine into unified frontend framework tracker',
		)
		assert(typeof merged.id === 'string', 'mergeNeurons() returns merged neuron with id')

		// Split overloaded neuron
		const parts = await evoBrain.splitNeuron(
			'broad-neuron',
			'Separate into technical patterns vs team dynamics',
		)
		assert(Array.isArray(parts), 'splitNeuron() returns array')
		assert(parts.length >= 2, 'splitNeuron() creates 2+ neurons')

		// LLM-driven update
		await evoBrain.updateNeuron('neuron-x', 'Narrow scope to React hooks only')
		assert(true, 'updateNeuron() succeeds')

		// Delete via evolution
		await evoBrain.deleteNeuron('neuron-y')
		assert(evoBrain.getNeuron('neuron-y') === undefined, 'deleteNeuron() removes neuron')

		await evoBrain.dispose()

		// ── Update vs Adjust ─────────────────────────────────────────────────
		section('Update vs Adjust')

		const updateBrain = await Brain.create({
			prompt: 'Track coding patterns.',
			model,
			evolution: { enabled: true },
		})

		// adjustNeuron — natural language steering
		const adjustableNeurons = updateBrain.getNeurons()
		if (adjustableNeurons.length > 0) {
			await updateBrain.adjustNeuron(adjustableNeurons[0].id, 'Be stricter about what counts as a distinct topic')
			assert(true, 'adjustNeuron() with directive succeeds')
		}

		// brain.update() — mechanical cascade
		await updateBrain.update({
			learning: { governance: { strategy: 'decay' } },
		})
		assert(true, 'brain.update() mechanical succeeds')

		// brain.update() — semantic triggers evolution
		await updateBrain.update({ prompt: 'Track design systems instead of coding patterns.' })
		assert(true, 'brain.update() semantic succeeds')

		await updateBrain.dispose()

		// ── Standalone neuron equivalents ─────────────────────────────────────
		section('Standalone Neuron — adjust and update')

		const standaloneNeuron = await TextNeuron.create({
			model,
			instructions: 'Track coding patterns.',
			store: new MemoryNeuronStore(),
		})

		await standaloneNeuron.learn(['Some coding data'])

		// adjust() — adds a rule, no LLM call
		await standaloneNeuron.adjust('Also track performance metrics')
		assert(true, 'neuron.adjust() succeeds')

		// update() — replace config fields
		await standaloneNeuron.update({
			instructions: 'Track only React performance patterns.',
			governance: { strategy: 'cumulative', maxTokens: 6000 },
		})
		assert(true, 'neuron.update() succeeds')

		await standaloneNeuron.dispose()

		await brain.dispose()
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}

	// ── Summary ──────────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`03-brain: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
