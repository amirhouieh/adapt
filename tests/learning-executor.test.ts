import { describe, expect, it } from 'vitest'

import {
	LearningRegistry,
	arraySchema,
	defineSchema,
	learningResultSchema,
	planRecipe,
	runRecipe,
	type BudgetClaim,
	type Operation,
	type Recipe,
} from '../src/learning'

const text = defineSchema({
	id: 'text', version: '1',
	parse(value: unknown) {
		if (typeof value !== 'string') throw new Error('expected text')
		return value
	},
})
const boolean = defineSchema({
	id: 'boolean', version: '1',
	parse(value: unknown) {
		if (typeof value !== 'boolean') throw new Error('expected boolean')
		return value
	},
})
const optionalBoolean = defineSchema({
	id: 'optional-boolean', version: '1',
	accepts: (producer) => producer === boolean,
	parse(value: unknown) {
		if (value !== undefined && typeof value !== 'boolean') throw new Error('expected optional boolean')
		return value as boolean | undefined
	},
})
const texts = arraySchema('texts', '1', text)

function budget(maxClaims = Number.POSITIVE_INFINITY) {
	const claims: BudgetClaim[] = []
	return {
		claim(claim: BudgetClaim) {
			if (claims.length >= maxClaims) return false
			claims.push(claim)
			return true
		},
		snapshot: () => ({ claims }),
	}
}

const capabilities = {
	has: () => true,
	get: () => undefined,
}

function execute(
	registry: LearningRegistry,
	recipe: Recipe,
	roots: Record<string, { schema: typeof text | typeof texts; value: unknown }>,
	signal = new AbortController().signal,
	workBudget = budget(),
) {
	registry.registerRecipe(recipe)
	const plan = planRecipe(registry, {
		recipe: { id: recipe.id, version: recipe.version },
		roots,
		memoryType: 'text',
		availableCapabilities: new Set(),
		revisions: { memory: 5, configuration: 8, registry: 'registry-13' },
		limits: { maxNodes: 12, maxCollectionItems: 4, maxOperations: 12 },
	})
	return runRecipe(plan, { capabilities, budget: workBudget, signal })
}

describe('runRecipe', () => {
	it('runs independent branches in parallel and joins their exact outputs', async () => {
		const registry = new LearningRegistry()
		let release: (() => void) | undefined
		const blocked = new Promise<void>((resolve) => { release = resolve })
		const started: string[] = []
		for (const id of ['left', 'right']) {
			registry.registerOperation({
				id, version: '1', inputSchemas: { input: text }, outputSchemas: { value: text }, requiredCapabilities: [],
				async run({ input }) { started.push(id); await blocked; return { value: `${input}-${id}` } },
			})
		}
		registry.registerOperation({
			id: 'join', version: '1', inputSchemas: { left: text, right: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: ({ left, right }) => ({ result: { outcome: 'no_change', reason: `${left}|${right}` } }),
		})
		const running = execute(registry, {
			id: 'parallel', version: '1',
			nodes: [
				{ kind: 'operation', id: 'left', operation: { id: 'left', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
				{ kind: 'operation', id: 'right', operation: { id: 'right', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
				{ kind: 'operation', id: 'join', operation: { id: 'join', version: '1' }, inputs: {
					left: { source: 'node', nodeId: 'left', output: 'value' },
					right: { source: 'node', nodeId: 'right', output: 'value' },
				} },
			],
			result: { source: 'node', nodeId: 'join', output: 'result' },
		}, { input: { schema: text, value: 'root' } })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(started.sort()).toEqual(['left', 'right'])
		release?.()
		const output = await running
		expect(output.result).toEqual({ outcome: 'no_change', reason: 'root-left|root-right' })
		expect(output.nodes.map(({ rawOutput }) => rawOutput)).toEqual([
			{ value: 'root-left' }, { value: 'root-right' },
			{ result: { outcome: 'no_change', reason: 'root-left|root-right' } },
		])
	})

	it('lets a join consume an explicit optional skipped gate branch', async () => {
		const registry = new LearningRegistry()
		registry.registerOperation({
			id: 'gate', version: '1', inputSchemas: { input: text }, outputSchemas: { applies: boolean }, requiredCapabilities: [],
			run: () => ({ applies: false }),
		})
		registry.registerOperation({
			id: 'keep', version: '1', inputSchemas: { input: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			run: ({ input }) => ({ value: input }),
		})
		registry.registerOperation({
			id: 'join', version: '1', inputSchemas: { gate: optionalBoolean, value: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: ({ gate, value }) => ({ result: { outcome: 'no_change', reason: `${String(gate)}:${value}` } }),
		})
		const output = await execute(registry, {
			id: 'gate-recipe', version: '1', nodes: [
				{ kind: 'gate', id: 'gate', operation: { id: 'gate', version: '1' }, inputs: { input: { source: 'root', root: 'input' } }, appliesOutput: 'applies' },
				{ kind: 'operation', id: 'keep', operation: { id: 'keep', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
				{ kind: 'operation', id: 'join', operation: { id: 'join', version: '1' }, inputs: {
					gate: { source: 'node', nodeId: 'gate', output: 'applies', optional: true },
					value: { source: 'node', nodeId: 'keep', output: 'value' },
				} },
			], result: { source: 'node', nodeId: 'join', output: 'result' },
		}, { input: { schema: text, value: 'kept' } })
		expect(output.nodes.map(({ status }) => status)).toEqual(['not_applicable', 'succeeded', 'succeeded'])
		expect(output.result).toEqual({ outcome: 'no_change', reason: 'undefined:kept' })
	})

	it('bounds collection work and preserves overflow as pending', async () => {
		const registry = new LearningRegistry()
		registry.registerOperation({
			id: 'upper', version: '1', inputSchemas: { item: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			run: ({ item }) => ({ value: item.toUpperCase() }),
		})
		registry.registerOperation({
			id: 'finish', version: '1', inputSchemas: { values: texts }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: ({ values }) => ({ result: { outcome: 'change', patch: values, expectedMemoryRevision: 5, expectedConfigurationRevision: 8 } }),
		})
		const output = await execute(registry, {
			id: 'collection', version: '1', nodes: [
				{ kind: 'collection', id: 'map', operation: { id: 'upper', version: '1' }, inputs: {}, itemInput: 'item', items: { source: 'root', root: 'items' }, limit: 2, outputSchemas: { value: texts } },
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { values: { source: 'node', nodeId: 'map', output: 'value' } } },
			], result: { source: 'node', nodeId: 'finish', output: 'result' },
		}, { items: { schema: texts, value: ['one', 'two', 'three'] } })
		expect(output.result).toMatchObject({ outcome: 'change', patch: ['ONE', 'TWO'] })
		expect(output.pending).toEqual([{ nodeId: 'map', items: ['three'] }])
		expect(output.nodes[0]?.rawOutput).toEqual([{ value: 'ONE' }, { value: 'TWO' }])
	})

	it('returns defer when the supplied budget is exhausted', async () => {
		const registry = new LearningRegistry()
		registry.registerOperation({
			id: 'finish', version: '1', inputSchemas: { input: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: () => ({ result: { outcome: 'no_change' } }),
		})
		const output = await execute(registry, {
			id: 'bounded', version: '1', nodes: [
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
			], result: { source: 'node', nodeId: 'finish', output: 'result' },
		}, { input: { schema: text, value: 'input' } }, new AbortController().signal, budget(0))
		expect(output.result).toEqual({ outcome: 'defer', reason: 'execution budget was exhausted', pending: [] })
		expect(output.nodes[0]?.status).toBe('deferred')
	})

	it('retains an invalid raw output with the failure', async () => {
		const registry = new LearningRegistry()
		const invalid = { wrong: 'raw output' }
		registry.registerOperation({
			id: 'invalid', version: '1', inputSchemas: { input: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: () => invalid,
		})
		const output = await execute(registry, {
			id: 'invalid', version: '1', nodes: [
				{ kind: 'operation', id: 'invalid', operation: { id: 'invalid', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
			], result: { source: 'node', nodeId: 'invalid', output: 'result' },
		}, { input: { schema: text, value: 'input' } })
		expect(output.nodes[0]?.rawOutput).toBe(invalid)
		expect(output.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
	})

	it('cancels after an awaited operation and keeps its raw output non-committable', async () => {
		const registry = new LearningRegistry()
		const controller = new AbortController()
		registry.registerOperation({
			id: 'finish', version: '1', inputSchemas: { input: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			async run() { controller.abort('stopped'); return { result: { outcome: 'change', patch: 'unsafe', expectedMemoryRevision: 5, expectedConfigurationRevision: 8 } } },
		})
		const output = await execute(registry, {
			id: 'cancel', version: '1', nodes: [
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
			], result: { source: 'node', nodeId: 'finish', output: 'result' },
		}, { input: { schema: text, value: 'input' } }, controller.signal)
		expect(output.nodes[0]?.status).toBe('cancelled')
		expect(output.nodes[0]?.rawOutput).toMatchObject({ result: { patch: 'unsafe' } })
		expect(output.result).toEqual({ outcome: 'failure', code: 'cancelled', reason: 'recipe execution was cancelled', retryable: true })
	})

	it('cancels on the last awaited collection item and retains every item as pending', async () => {
		const registry = new LearningRegistry()
		const controller = new AbortController()
		let calls = 0
		registry.registerOperation({
			id: 'item', version: '1', inputSchemas: { item: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			async run({ item }) { calls += 1; if (calls === 2) controller.abort('deadline'); return { value: item } },
		})
		registry.registerOperation({
			id: 'finish', version: '1', inputSchemas: { values: texts }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: () => ({ result: { outcome: 'no_change' } }),
		})
		const output = await execute(registry, {
			id: 'collection-cancel', version: '1', nodes: [
				{ kind: 'collection', id: 'items', operation: { id: 'item', version: '1' }, inputs: {}, itemInput: 'item', items: { source: 'root', root: 'items' }, limit: 2, outputSchemas: { value: texts } },
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { values: { source: 'node', nodeId: 'items', output: 'value' } } },
			], result: { source: 'node', nodeId: 'finish', output: 'result' },
		}, { items: { schema: texts, value: ['one', 'two', 'overflow'] } }, controller.signal)
		expect(output.nodes[0]?.status).toBe('cancelled')
		expect(output.pending).toEqual([{ nodeId: 'items', items: ['one', 'two', 'overflow'] }])
		expect(output.result.outcome).toBe('failure')
	})

	it('retains collection overflow when aggregate validation fails', async () => {
		const badTexts = defineSchema({
			id: 'bad-texts', version: '1', collectionItem: text,
			parse() { throw new Error('aggregate rejected') },
		})
		const registry = new LearningRegistry()
		registry.registerOperation({
			id: 'item', version: '1', inputSchemas: { item: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			run: ({ item }) => ({ value: item }),
		})
		registry.registerOperation({
			id: 'finish', version: '1', inputSchemas: { values: badTexts }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: () => ({ result: { outcome: 'no_change' } }),
		})
		const output = await execute(registry, {
			id: 'aggregate-failure', version: '1', nodes: [
				{ kind: 'collection', id: 'items', operation: { id: 'item', version: '1' }, inputs: {}, itemInput: 'item', items: { source: 'root', root: 'items' }, limit: 2, outputSchemas: { value: badTexts } },
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { values: { source: 'node', nodeId: 'items', output: 'value' } } },
			], result: { source: 'node', nodeId: 'finish', output: 'result' },
		}, { items: { schema: texts, value: ['one', 'two', 'overflow'] } })
		expect(output.pending).toEqual([{ nodeId: 'items', items: ['one', 'two', 'overflow'] }])
		expect(output.nodes[0]?.status).toBe('failed')
	})

	it('does not turn an optional failed branch into not_applicable', async () => {
		const registry = new LearningRegistry()
		registry.registerOperation({
			id: 'fail', version: '1', inputSchemas: { input: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			run() { throw new Error('branch failed') },
		})
		registry.registerOperation({
			id: 'join', version: '1', inputSchemas: { value: text }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
			run: () => ({ result: { outcome: 'no_change' } }),
		})
		const output = await execute(registry, {
			id: 'optional-failure', version: '1', nodes: [
				{ kind: 'operation', id: 'fail', operation: { id: 'fail', version: '1' }, inputs: { input: { source: 'root', root: 'input' } } },
				{ kind: 'operation', id: 'join', operation: { id: 'join', version: '1' }, inputs: { value: { source: 'node', nodeId: 'fail', output: 'value', optional: true } } },
			], result: { source: 'node', nodeId: 'join', output: 'result' },
		}, { input: { schema: text, value: 'input' } })
		expect(output.nodes[0]?.status).toBe('failed')
		expect(output.nodes[1]?.status).toBe('failed')
		expect(output.result).toMatchObject({ outcome: 'failure', code: 'operation_failed' })
	})
})
