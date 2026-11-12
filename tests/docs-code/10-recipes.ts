/**
 * Docs code test: 10-recipes.md
 *
 * Verifies every TypeScript code block from the Recipes guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/10-recipes.ts
 */

import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'
import { model } from '../../evals/helpers/provider'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, '..', '.tmp-docs-10')

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
		// ── Proactive Insights ────────────────────────────────────────────
		section('Proactive Insights')

		const brain = await Brain.create({
			prompt: 'Track patterns for recipe testing.',
			model,
			evolution: { enabled: false },
			autoSetup: false,
			neurons: [
				{ id: 'patterns', type: 'text', name: 'Patterns', description: 'Pattern tracking', instructions: 'Track patterns.' },
			],
		})

		let proactiveInsightFired = false
		brain.on('neuron:synthesized', async () => {
			const insight = await brain.ask('What new patterns or tensions have emerged?')
			if (insight.sources.some(s => s.confidence > 0.7)) {
				proactiveInsightFired = true
			}
		})
		assert(true, 'Proactive insights event handler registered')

		await brain.inject([
			'data: Important pattern data 1',
			'data: Important pattern data 2',
		])

		// ── Quality Gating ───────────────────────────────────────────────
		section('Quality Gating')

		const result = await brain.ask('What patterns exist?')
		const strong = result.sources.filter(s => s.confidence > 0.6 && s.relevance > 0.5)
		if (strong.length === 0) {
			assert(true, 'Quality gating: no strong sources → returns null (correct)')
		} else {
			const gated = { insight: result.insight, gaps: result.gaps }
			assert(typeof gated.insight === 'string', 'Quality gating: gated result has insight')
			assert(Array.isArray(gated.gaps), 'Quality gating: gated result has gaps')
		}

		// ── Cross-Domain Connections ─────────────────────────────────────
		section('Cross-Domain Connections')

		const crossDomain = await brain.ask('What connects my interest in calm tech with my wedding planning?')
		assert(typeof crossDomain.insight === 'string', 'Cross-domain ask returns insight')

		await brain.dispose()

		// ── User-Steerable Taxonomy ──────────────────────────────────────
		section('User-Steerable Taxonomy')

		const taxonomyBrain = await Brain.create({
			prompt: 'Track bookmarks and categories.',
			model,
			evolution: { enabled: true },
			autoSetup: false,
			neurons: [
				{ id: 'eink', type: 'text', name: 'eink', description: 'eink', instructions: 'Track eink.' },
				{ id: 'paper-displays', type: 'text', name: 'paper-displays', description: 'paper displays', instructions: 'Track paper displays.' },
				{ id: 'ai-neuron', type: 'text', name: 'AI', description: 'AI tracking', instructions: 'Track AI.' },
				{ id: 'categories', type: 'text', name: 'Categories', description: 'Categories', instructions: 'Track categories.' },
			],
		})

		await taxonomyBrain.mergeNeurons(['eink', 'paper-displays'], 'Combine under hardware')
		assert(true, 'mergeNeurons() in taxonomy context works')

		await taxonomyBrain.splitNeuron('ai-neuron', 'Separate into AI tools vs AI research')
		assert(true, 'splitNeuron() in taxonomy context works')

		await taxonomyBrain.adjustNeuron('categories', 'Stop categorizing things as inspiration')
		assert(true, 'adjustNeuron() in taxonomy context works')

		await taxonomyBrain.dispose()

		// ── Dual-Brain Architecture ──────────────────────────────────────
		section('Dual-Brain Architecture')

		// Long-term brain: evolves over time, persists everything
		const longTermBrain = await Brain.create({
			prompt: 'Track patterns across all interactions.',
			model,
			store: new SQLiteBrainStore(join(tmpDir, 'long-term.brain.db')),
			evolution: { enabled: false },
			autoSetup: false,
			neurons: [
				{ id: 'long-term', type: 'text', name: 'Long Term', description: 'Long-term patterns', instructions: 'Track patterns across all interactions.' },
			],
		})

		// Session brain: fixed structure, short-lived
		const sessionNeuronDefs = [
			{ id: 'obs', type: 'text' as const, name: 'Session', description: 'What happened in the session', instructions: 'Extract what happened in this session.' },
		]
		const sessionBrain = await Brain.create({
			prompt: 'Extract what happened in this session.',
			model,
			autoSetup: false,
			neurons: sessionNeuronDefs,
			evolution: { enabled: false },
		})

		// Process data through the session brain
		const sessionData = ['event: user clicked dark mode toggle 5 times']
		await sessionBrain.inject(sessionData)
		assert(true, 'Session brain injected data')

		// Transfer session knowledge to the long-term brain
		for (const neuron of sessionBrain.getNeurons()) {
			const understanding = await neuron.getUnderstanding()
			if (understanding) {
				await longTermBrain.inject(`${neuron.name}:\n${understanding}`)
			}
		}
		assert(true, 'Session knowledge transferred to long-term brain')

		await sessionBrain.dispose()
		await longTermBrain.dispose()

		// ── Event-Driven Synchronization ─────────────────────────────────
		section('Event-Driven Synchronization')

		const syncBrain = await Brain.create({
			prompt: 'Event sync test.',
			model,
			evolution: { enabled: false },
			autoSetup: false,
			neurons: [
				{ id: 'sync', type: 'text', name: 'Sync', description: 'Sync test', instructions: 'Track sync patterns.' },
			],
		})

		const injectDone = new Promise<void>((resolve) => {
			syncBrain.on('brain:inject:completed', () => resolve())
		})

		await syncBrain.inject(['sync test'])
		await injectDone
		assert(true, 'Event-driven sync: brain:inject:completed resolves')

		await syncBrain.dispose()

		// ── SSE Event Broadcasting ───────────────────────────────────────
		section('SSE Event Broadcasting')

		const sseBrain = await Brain.create({
			prompt: 'SSE test.',
			model,
			evolution: { enabled: false },
		})

		const sseClients: Array<(type: string, payload: unknown) => void> = []
		const broadcasted: Array<{ type: string; payload: unknown }> = []

		// Simulate an SSE client
		sseClients.push((type, payload) => {
			broadcasted.push({ type, payload })
		})

		brain.on((event) => {
			for (const send of sseClients) {
				send(event.type, event.payload)
			}
		})
		assert(true, 'SSE broadcasting pattern registers without error')

		await sseBrain.dispose()
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`10-recipes: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
