/**
 * Integration tests — real LLM calls
 *
 * Tests neuron lifecycle, query, update/regen, and strategy compression
 * using real LLM APIs via OpenRouter.
 *
 * Requires OPENROUTER_API_KEY env var.
 * Run: export $(cat .env.local | xargs) && npx vitest run tests/integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { TextNeuron, MemoryNeuronStore } from '../src'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'

let model: LanguageModel

beforeAll(() => {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		throw new Error(
			'OPENROUTER_API_KEY is required for integration tests. Run: export $(cat .env.local | xargs) && npx vitest run tests/integration.test.ts',
		)
	}
	const openrouter = createOpenRouter({ apiKey })
	model = openrouter(process.env.MODEL ?? 'google/gemini-2.0-flash-001')
})

// ── TextNeuron lifecycle ────────────────────────────────────────────────────

describe('TextNeuron lifecycle', () => {
	it('learn → builds understanding → query returns relevant answer', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-text',
			instructions: 'Track knowledge about coffee brewing methods and techniques.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'continuous' },
			understand: {
				thresholds: { minImportance: 0.2, maxObservations: 3 },
			},
		})

		const result = await neuron.learn([
			'Pour-over coffee works best at 200°F with a 1:16 coffee-to-water ratio.',
			'French press requires a coarse grind and 4-minute steep time.',
			'Espresso uses 9 bars of pressure and finely ground beans.',
		])

		expect(result.status).toBe('synthesized')

		const understanding = await neuron.getUnderstanding()
		expect(understanding).toBeTruthy()
		expect(typeof understanding).toBe('string')
		expect(understanding!.length).toBeGreaterThan(50)

		const queryResult = await neuron.query('What temperature is best for pour-over?')
		expect(queryResult.insight).toBeTruthy()
		expect(queryResult.insight.length).toBeGreaterThan(10)
	}, 60_000)

	it('learn with low-relevance data returns dismissed', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-dismiss',
			instructions: 'Track only information about quantum physics.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'continuous' },
		})

		const result = await neuron.learn([
			'The weather today is sunny with a high of 75°F.',
		])

		// Should be dismissed or observed with low importance
		expect(['observe:dismissed', 'observed']).toContain(result.status)
	}, 30_000)
})

// ── Neuron update with instruction change ───────────────────────────────────

describe('TextNeuron update', () => {
	it('changing instructions triggers prompt regeneration', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-update',
			instructions: 'Track coffee brewing methods.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'continuous' },
		})

		// Learn initial data
		await neuron.learn([
			'Pour-over coffee uses a 1:16 ratio and 200°F water.',
			'Espresso requires 9 bars of pressure.',
			'Cold brew steeps for 12-24 hours in cold water.',
		], { forceSynthesize: true })

		const beforeUpdate = await neuron.getUnderstanding()
		expect(beforeUpdate).toBeTruthy()

		// Update instructions — should trigger observe + understand regen
		const { changedFields } = await neuron.update({
			instructions: 'Track only espresso preparation techniques. Ignore all other brewing methods.',
		})

		expect(changedFields).toContain('instructions')

		// After update, a query about espresso should still work
		const queryResult = await neuron.query('How is espresso made?')
		expect(queryResult.insight).toBeTruthy()
	}, 60_000)

	it('passive updates (name, description) do not trigger regen', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-passive',
			instructions: 'Track tea varieties.',
			store: new MemoryNeuronStore(),
			governance: { strategy: 'continuous' },
		})

		const { changedFields } = await neuron.update({
			name: 'Tea Expert',
			description: 'Tracks knowledge about tea',
		})

		expect(changedFields).toContain('name')
		expect(changedFields).toContain('description')
		expect(neuron.name).toBe('Tea Expert')
		expect(neuron.description).toBe('Tracks knowledge about tea')
	}, 30_000)
})

// ── Strategy compression with real LLM ──────────────────────────────────────

describe('cumulative strategy compression', () => {
	it('compresses understanding when exceeding maxTokens', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-compress',
			instructions: 'Track everything about software engineering practices.',
			store: new MemoryNeuronStore(),
			governance: {
				strategy: 'cumulative',
				maxTokens: 100, // Very low threshold to force compression
			},
			understand: {
				thresholds: { minImportance: 0.1, maxObservations: 3 },
			},
		})

		// Feed enough data to exceed the low token limit
		await neuron.learn([
			'Use dependency injection for testability. Constructor injection is preferred over service locators.',
			'Follow the SOLID principles: Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.',
			'Test-driven development: write failing test first, make it pass with minimum code, then refactor.',
		], { forceSynthesize: true })

		// Feed more data to trigger another synthesis cycle which should trigger compression
		await neuron.learn([
			'Code reviews should focus on correctness, readability, and architectural alignment.',
			'Prefer composition over inheritance. Use interfaces to define contracts.',
			'Continuous integration: commit frequently, run tests automatically, fix broken builds immediately.',
		], { forceSynthesize: true })

		const understanding = await neuron.getUnderstanding()
		expect(understanding).toBeTruthy()
		// After two synthesis cycles with a 100-token limit, compression should have fired
		// Understanding should still contain meaningful content
		expect(understanding!.length).toBeGreaterThan(20)
	}, 90_000)
})

describe('decay strategy compression', () => {
	it('compresses when approaching 80% of maxTokens', async () => {
		const neuron = await TextNeuron.create({
			model,
			id: 'test-decay',
			instructions: 'Track notes about programming languages.',
			store: new MemoryNeuronStore(),
			governance: {
				strategy: 'decay',
				maxTokens: 100, // Very low to force decay compression
			},
			understand: {
				thresholds: { minImportance: 0.1, maxObservations: 3 },
			},
		})

		await neuron.learn([
			'Rust has a borrow checker that prevents data races at compile time.',
			'Go uses goroutines for lightweight concurrency with channels for communication.',
			'TypeScript adds static typing to JavaScript, catching bugs at compile time.',
		])

		const understanding = await neuron.getUnderstanding()
		expect(understanding).toBeTruthy()
		expect(understanding!.length).toBeGreaterThan(20)
	}, 60_000)
})
