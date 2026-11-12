import { describe, it, expect } from 'vitest'
import { resolveTextNeuronConfig } from '../src/neurons/text/config.resolver'
import { TEXT_NEURON_DEFAULTS } from '../src/neurons/text/config.defaults'
import { mockModel } from './helpers'

// ── TextNeuron Config ─────────────────────────────────────────────────────────

describe('resolveTextNeuronConfig', () => {
	const model = mockModel()

	it('throws when no model is provided', () => {
		expect(() =>
			resolveTextNeuronConfig({ instructions: 'test' } as any),
		).toThrow('TextNeuron requires a model')
	})

	it('uses config.model when provided', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.model).toBe(model)
	})

	it('falls back to parentModels.model when config.model is missing', () => {
		const parentModel = mockModel('parent', 'parent-model')
		const result = resolveTextNeuronConfig(
			{ instructions: 'test' } as any,
			{ model: parentModel },
		)
		expect(result.model).toBe(parentModel)
	})

	it('auto-generates id with neuron_ prefix when omitted', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.id).toMatch(/^neuron_/)
	})

	it('uses provided id when specified', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test', id: 'my-neuron' })
		expect(result.id).toBe('my-neuron')
	})

	it('defaults origin to developer', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.origin).toBe(TEXT_NEURON_DEFAULTS.origin)
	})

	it('passes through instructions as-is', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'Track coding patterns.' })
		expect(result.instructions).toBe('Track coding patterns.')
	})

	it('normalizes phase instruction overrides', () => {
		const result = resolveTextNeuronConfig({
			model,
			instructions: 'shared',
			observeInstructions: 'observe only',
			understandInstructions: 'understand only',
		})
		expect(result.observeInstructions).toBe('observe only')
		expect(result.understandInstructions).toBe('understand only')

		const fallback = resolveTextNeuronConfig({ model, instructions: 'shared' })
		expect(fallback.observeInstructions).toBeNull()
		expect(fallback.understandInstructions).toBeNull()
	})

	// ── Model cascade ──

	it('cascades blueprintModel: config > parent > config.model > parent.model', () => {
		const bpModel = mockModel('bp', 'bp-model')
		const result = resolveTextNeuronConfig({
			model,
			blueprintModel: bpModel,
			instructions: 'test',
		})
		expect(result.blueprintModel).toBe(bpModel)
	})

	it('blueprintModel falls back to config.model when not specified', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.blueprintModel).toBe(model)
	})

	it('observer.model cascades to config.model', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.observer.model).toBe(model)
	})

	it('observer.model uses override when provided', () => {
		const obsModel = mockModel('obs', 'obs-model')
		const result = resolveTextNeuronConfig({
			model,
			instructions: 'test',
			observer: { model: obsModel },
		})
		expect(result.observer.model).toBe(obsModel)
	})

	it('understand.model cascades to config.model', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.understand.model).toBe(model)
	})

	it('query.model cascades to config.model', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.query.model).toBe(model)
	})

	// ── Default thresholds ──

	it('applies default thresholds', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.understand.thresholds).toEqual({
			maxObservations: TEXT_NEURON_DEFAULTS.understand.thresholds.maxObservations,
			maxTokens: TEXT_NEURON_DEFAULTS.understand.thresholds.maxTokens,
			minImportance: TEXT_NEURON_DEFAULTS.understand.thresholds.minImportance,
		})
	})

	it('allows partial threshold overrides', () => {
		const result = resolveTextNeuronConfig({
			model,
			instructions: 'test',
			understand: { thresholds: { maxObservations: 5 } },
		})
		expect(result.understand.thresholds.maxObservations).toBe(5)
		expect(result.understand.thresholds.maxTokens).toBe(TEXT_NEURON_DEFAULTS.understand.thresholds.maxTokens)
		expect(result.understand.thresholds.minImportance).toBe(TEXT_NEURON_DEFAULTS.understand.thresholds.minImportance)
	})

	// ── Default governance ──

	it('applies default governance', () => {
		const result = resolveTextNeuronConfig({ model, instructions: 'test' })
		expect(result.governance).toEqual({
			strategy: 'cumulative',
			maxTokens: 16000,
		})
	})

	it('allows governance overrides', () => {
		const result = resolveTextNeuronConfig({
			model,
			instructions: 'test',
			governance: { strategy: 'decay', maxTokens: 8000 },
		})
		expect(result.governance.strategy).toBe('decay')
		expect(result.governance.maxTokens).toBe(8000)
	})
})
