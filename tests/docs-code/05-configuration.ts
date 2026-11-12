/**
 * Docs code test: 05-configuration.md
 *
 * Verifies every TypeScript code block from the Configuration guide
 * compiles and runs correctly.
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx tests/docs-code/05-configuration.ts
 */

import { Brain, MemoryBrainStore, createAiSdkLLM } from '@unbody-io/adapt'
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
	// ── BrainConfig — Full Interface ─────────────────────────────────────
	section('BrainConfig — Full Interface')

	// Verify all config fields are accepted without error
	const fullConfigBrain = await Brain.create({
		prompt: 'Test full config.',
		model,
		blueprintModel: model,
		autoSetup: true,
		neurons: [],
		store: new MemoryBrainStore(),

		init: { model },
		query: { model },
		ingest: { batchSize: 20 },

		learning: {
			model,
			blueprintModel: model,
			query: { model },
			governance: {
				strategy: 'cumulative',
				maxTokens: 8000,
			},
			understand: {
				thresholds: {
					maxObservations: 10,
					maxTokens: 8000,
					minImportance: 0.5,
				},
			},
		},

		evolution: {
			enabled: true,
			model,
			evaluatorSignalThreshold: 5,
			autoEvaluate: true,
			coverageGap: {
				relevanceThreshold: 0.3,
				gapCountThreshold: 5,
				windowSize: 20,
			},
		},

		internalNeurons: {
			globalUnderstanding: true,
			globalQueryUnderstanding: true,
			injectionGaps: true,
			queryGaps: true,
		},

		dismissedBatchBuffer: {
			maxSize: 100,
		},
	})

	assert(fullConfigBrain instanceof Brain, 'Brain accepts full BrainConfig interface')
	await fullConfigBrain.dispose()

	// ── Cost-Optimized Setup ─────────────────────────────────────────────
	section('Cost-Optimized Model Setup')

	// Docs show fast + smart model split — we use same model for both
	const fast = model
	const smart = model

	const costBrain = await Brain.create({
		prompt: 'Cost optimized.',
		model: fast,
		blueprintModel: smart,
		init: { model: smart },
		query: { model: smart },
		learning: {
			model: fast,
			query: { model: smart },
		},
	})

	assert(costBrain instanceof Brain, 'Cost-optimized Brain config accepted')
	await costBrain.dispose()

	// ── Provider Setup ───────────────────────────────────────────────────
	section('Provider Setup')

	// Docs show: openai, anthropic, google, openrouter
	// We verify the openrouter pattern (which is what we use)
	// The other providers follow the same LanguageModel interface
	const providerBrain = await Brain.create({ model, prompt: 'Provider test.' })
	assert(providerBrain instanceof Brain, 'Brain accepts LanguageModel from openrouter')
	await providerBrain.dispose()

	// ── Custom LLM Runtimes ──────────────────────────────────────────────
	section('Custom LLM Runtimes')

	// Default plugin is auto-wired, but you can pass an explicit one.
	// (createAiSdkLLM with `gateway: true` opts into AI Gateway fallback.)
	const llm = createAiSdkLLM()
	const llmBrain = await Brain.create({
		prompt: 'Custom LLM plugin.',
		model,
		llm,
	})
	assert(llmBrain instanceof Brain, 'Brain.create({ llm }) succeeds')
	await llmBrain.dispose()

	// ── Governance Strategies ────────────────────────────────────────────
	section('Governance Strategies')

	for (const strategy of ['continuous', 'cumulative', 'decay'] as const) {
		const brain = await Brain.create({
			prompt: `Test ${strategy} governance.`,
			model,
			learning: {
				governance: { strategy, maxTokens: 16000 },
			},
		})
		assert(brain instanceof Brain, `governance strategy '${strategy}' accepted`)
		await brain.dispose()
	}

	// ── Summary ──────────────────────────────────────────────────────────
	console.log(`\n${'═'.repeat(60)}`)
	console.log(`05-configuration: ${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
