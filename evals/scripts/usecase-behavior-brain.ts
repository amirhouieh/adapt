/**
 * Eval: Personal Behavioral Intelligence — Brain Level
 *
 * Tests the Brain orchestrator (not a single neuron) on the same behavioral
 * dataset used in usecase-behavior-neuron.ts. The brain receives a high-level
 * prompt and must decompose it into appropriate neurons, route data, and
 * synthesize cross-neuron insights.
 *
 * Objectives:
 *   1. Decomposition quality — Does the brain create well-scoped, non-redundant
 *      neurons from the prompt? Expected: behavioral patterns, emotional states,
 *      browsing habits, avoidance detection — or similar reasonable decomposition.
 *   2. Cross-neuron synthesis — Does brain.ask() produce richer answers than any
 *      single neuron could? Queries that span multiple concern areas should
 *      integrate insights from relevant neurons.
 *   3. Neuron coverage — After ingestion, do multiple neurons have understanding?
 *      No neuron should be starved (0 observations) if the data is diverse enough.
 *   4. Internal neuron awareness — Does the brain's global understanding capture
 *      cross-cutting themes (e.g., career anxiety shows in both conversations and
 *      browsing)?
 *
 * Ground truth (from dataset metadata):
 *   - Avoidance: exercise/gym (cancelled 6x), dentist (rescheduled 4x),
 *     promotion conversation (dodged at 4 separate 1:1s)
 *   - Topic counts: "career change" ~11 events, "AI/machine learning" ~7
 *   - Browsing: late-night (11pm-2am), weekend rabbit holes, morning routine,
 *     tab hopping during work
 *   - Frustration events: evt_019, evt_034, evt_052, evt_071
 *
 * Dataset: evals/datasets/personal-behavior.json (85 events, 2 months)
 *
 * Run (full — init + ingest + query):
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/usecase-behavior-brain.ts
 *   export $(cat .env.local | xargs) && bun run evals/scripts/usecase-behavior-brain.ts
 *
 * Run (query only — restores from SQLite, skips ingestion):
 *   export $(cat .env.local | xargs) && QUERY_ONLY=1 npx tsx evals/scripts/usecase-behavior-brain.ts
 *   export $(cat .env.local | xargs) && QUERY_ONLY=1 bun run evals/scripts/usecase-behavior-brain.ts
 */

import {
	type AiSdkProviderFactory,
	Brain,
	type BrainAskResult,
	createAiSdkLLM,
} from '../../src'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvalRepairWithFeedback } from '../helpers/repair-with-feedback'

const isBunRuntime = 'Bun' in globalThis
const { SQLiteBrainStore } = isBunRuntime
	? await import('../../src/sqlite/bun')
	: await import('../../src/sqlite')

const __dirname = dirname(fileURLToPath(import.meta.url))
const datasetsDir = join(__dirname, '..', 'datasets')
const dataset = JSON.parse(readFileSync(join(datasetsDir, 'personal-behavior.json'), 'utf-8'))

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
const llm = createAiSdkLLM({
	providers: {
		openrouter: ((id: string) =>
			openrouter(id) as unknown as ReturnType<AiSdkProviderFactory>) as AiSdkProviderFactory,
	},
})
const MODEL = process.env.MODEL ?? 'google/gemini-2.0-flash-001'
const model = openrouter(MODEL)
const QUERY_ONLY = process.env.QUERY_ONLY === '1'

const dbDir = join(__dirname, '..', '.data')
mkdirSync(dbDir, { recursive: true })
const BRAIN_DB = join(dbDir, 'behavior-brain.db')

const startTime = Date.now()
function elapsed() {
	return ((Date.now() - startTime) / 1000).toFixed(1)
}

const repairWithFeedback = createEvalRepairWithFeedback()

function printAskResult(result: BrainAskResult) {
	console.log(`\nSynthesized insight:\n${result.insight}`)
	console.log(`\nSources:`)
	for (const s of result.sources) {
		console.log(`  ${s.neuronId}: relevance=${s.relevance} confidence=${s.confidence}`)
		console.log(`    ${s.insight.slice(0, 200)}...`)
	}
	console.log(`\nGaps: ${result.gaps.length ? result.gaps.join('; ') : '(none)'}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const events: Array<{ id: string; timestamp: string; type: string; content: string; source: string }> = dataset.events

	console.log('Eval: Personal Behavioral Intelligence — Brain Level')
	console.log(`Runtime: ${isBunRuntime ? 'bun' : 'node'}`)
	console.log(`Model: ${MODEL}`)
	console.log(`Mode: ${QUERY_ONLY ? 'QUERY ONLY (restored from SQLite)' : 'FULL (init + ingest + query)'}`)
	console.log(`Dataset: ${dataset.metadata.name} (${events.length} events)`)
	console.log(`Store: ${BRAIN_DB}`)
	console.log(`Time: ${new Date().toISOString()}`)

	// ── 1. Create brain ─────────────────────────────────────────────────────

	console.log('\n━━━ 1. Create & initialize brain ━━━')

	const brainStore = new SQLiteBrainStore(BRAIN_DB)
	const freshConfig = {
		prompt: [
			"Learn about a person's behavioral patterns from their digital activity stream.",
			'You start knowing nothing about this person. Everything must be discovered from the data as it arrives.',
			'',
			'This includes messages, browsing history, calendar events, journal entries,',
			'and app usage data. As data comes in, stay open and attentive. Let the data reveal patterns.',
			'',
			'When you start recognizing distinct concerns, prioritize specialization over generalization.',
			'Create dedicated specialists for each distinct thing you discover rather than lumping things together.',
			'The kinds of things to watch for as they emerge:',
			'- Avoidance patterns: things they postpone, cancel, or make excuses about',
			'- Recurring topics and their frequency across different contexts',
			'- Emotional patterns: frustration, aggression, anxiety, excitement — and triggers',
			'- Browsing behaviors: timing patterns, depth vs breadth, categories',
			'- The gap between stated intentions and actual actions',
			'',
			'Do not generalize. If two things could be separate specialists, they should be.',
			'The goal is maximum coverage with maximum depth.',
			'Flag frustration or hostility moments prominently when detected.',
		].join('\n'),
		model,
		llm,
		store: brainStore,
		learning: {
			governance: { strategy: 'continuous' as const },
			understand: {
				thresholds: {
					minImportance: 0.2,
					maxObservations: 8,
				},
			},
		},
		evolution: {
			enabled: true,
			autoEvaluate: false,
		},
		ingest: { batchSize: 6 },
		repairWithFeedback,
		maxRepairAttempts: 2,
	}

	const brain = QUERY_ONLY
		? await Brain.restore(brainStore, {
				llm,
				repairWithFeedback,
				maxRepairAttempts: 2,
			})
		: await Brain.create(freshConfig)

	// Wire up brain-level event logging
	brain.on((event) => {
		switch (event.type) {
			case 'brain:init:config:generated': {
				const p = event.payload as { configs: Array<{ id: string; name: string; description: string }> }
				console.log(`  [${elapsed()}s] Decomposition generated ${p.configs.length} neurons:`)
				for (const c of p.configs) {
					console.log(`    - ${c.id}: ${c.name}`)
					console.log(`      ${c.description}`)
				}
				break
			}
			case 'brain:init:completed': {
				const p = event.payload as { neuronIds: string[] }
				console.log(`  [${elapsed()}s] Init completed — ${p.neuronIds.length} neurons`)
				break
			}
			case 'brain:inject:batch:completed': {
				const p = event.payload as { batchIndex: number; results: Array<{ neuronId: string; result: { status: string } }> }
				const statuses = p.results.map((r) => `${r.neuronId}:${r.result.status}`).join(', ')
				console.log(`  [${elapsed()}s] Batch ${p.batchIndex} — ${statuses}`)
				break
			}
			case 'brain:signal:received': {
				const p = event.payload as { source: string; description: string }
				console.log(`  [${elapsed()}s] Signal: [${p.source}] ${p.description}`)
				break
			}
			case 'evolution:change': {
				const p = event.payload as { action: string; neuronId: string; mergedIds?: string[] }
				const from = p.mergedIds ? ` from [${p.mergedIds.join(', ')}]` : ''
				console.log(`  [${elapsed()}s] Evolution: ${p.action} ${p.neuronId}${from}`)
				break
			}
			case 'evolution:completed': {
				const p = event.payload as { changes: unknown[]; reasoning: string }
				console.log(`  [${elapsed()}s] Evolution run — ${p.changes.length} changes. ${p.reasoning}`)
				break
			}
		}
	})

	console.log(`  [${elapsed()}s] Brain initialized`)

	// ── 2. Log decomposition details ────────────────────────────────────────

	console.log('\n━━━ 2. Decomposition details ━━━')

	const neurons = brain.getNeurons()
	console.log(`\nNeuron count: ${neurons.length}`)

	for (const l of neurons) {
		const meta = l.getMetadata()
		console.log(`\n  Neuron: ${l.id}`)
		console.log(`  Instructions: ${meta.instructions}`)
		console.log(`  Origin: ${meta.origin}`)
	}

	if (QUERY_ONLY) {
		console.log('\n━━━ Skipped ingestion (QUERY_ONLY mode) ━━━')
	} else {
		// ── 3. Ingest data ──────────────────────────────────────────────────

		console.log('\n━━━ 3. Ingest data stream ━━━')

		const formatted = events.map(
			(evt) => `[${evt.timestamp}] [${evt.type}] [source: ${evt.source}]\n${evt.content}`,
		)

		console.log(`  Total events: ${events.length}`)

		const result = await brain.inject(formatted)
		console.log(`  [${elapsed()}s] Inject completed — ${result.batches.length} batches`)

		// ── 4. Per-neuron state after ingestion ────────────────────────────

		console.log('\n━━━ 4. Per-neuron state after ingestion ━━━')

		for (const l of brain.getNeurons()) {
			const metrics = l.getMetrics()
			const understanding = await l.getUnderstanding()
			const health = l.getHealth()

			console.log(`\n  ── ${l.id} ──`)
			console.log(`  Health: ${JSON.stringify(health)}`)
			console.log(`  Observations: ${metrics.ingestion.observationCount}`)
			console.log(`  Syntheses: ${metrics.ingestion.synthesisCount}`)
			console.log(`  Dismissal rate: ${(metrics.ingestion.dismissalRate * 100).toFixed(1)}%`)
			console.log(`  Understanding (${(understanding as string)?.length ?? 0} chars):`)
			console.log(understanding || '  (empty)')
		}
	}

	// ── 5. Internal neuron state ───────────────────────────────────────────

	console.log('\n━━━ 5. Internal neurons ━━━')

	for (const [id, l] of brain.internalNeurons) {
		const understanding = await l.getUnderstanding()
		const hasKnowledge = await l.hasKnowledge()
		console.log(`\n  ── ${id} ──`)
		console.log(`  Has knowledge: ${hasKnowledge}`)
		console.log(`  Understanding (${(understanding as string)?.length ?? 0} chars):`)
		console.log(understanding || '  (empty)')
	}

	// ── 6. Cross-neuron queries ────────────────────────────────────────────

	console.log('\n━━━ 6. Query: "What have I been avoiding the most?" ━━━')
	printAskResult(await brain.ask( 'What have I been avoiding the most?'))

	console.log('\n━━━ 7. Query: "How many times did I talk about career change?" ━━━')
	printAskResult(await brain.ask( 'How many times did I talk about career change?'))

	console.log('\n━━━ 8. Query: "Give me a deep analysis of my browsing behavior" ━━━')
	printAskResult(await brain.ask( 'Give me a deep analysis of my browsing behavior'))

	console.log('\n━━━ 9. Query: "Am I showing signs of burnout?" ━━━')
	console.log('  (Cross-cutting query — should combine emotional + behavioral + browsing signals)')
	printAskResult(await brain.ask( 'Am I showing signs of burnout?'))

	// ── 10. Done ────────────────────────────────────────────────────────────

	console.log(`\n━━━ Done in ${elapsed()}s ━━━`)
}

main().catch((err) => {
	console.error('Eval crashed:', err)
	process.exit(1)
})
