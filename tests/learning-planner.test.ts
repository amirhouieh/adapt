import { describe, expect, it } from 'vitest'

import {
	LearningRegistry,
	defineSchema,
	learningResultSchema,
	planRecipe,
	type Operation,
	type Recipe,
	type ValueSchema,
} from '../src/learning'

const text = defineSchema({
	id: 'text',
	version: '1',
	parse(value: unknown) {
		if (typeof value !== 'string') throw new Error('expected text')
		return value
	},
})

const resultOperation: Operation = {
	id: 'finish',
	version: '1',
	inputSchemas: { value: text },
	outputSchemas: { result: learningResultSchema },
	requiredCapabilities: [],
	run: ({ value }) => ({
		result: {
			outcome: 'change',
			patch: value,
			expectedMemoryRevision: 3,
			expectedConfigurationRevision: 2,
		},
	}),
}

function recipe(inputSchema: ValueSchema = text): Recipe {
	return {
		id: 'recipe',
		version: '1',
		nodes: [
			{
				kind: 'operation',
				id: 'finish',
				operation: { id: 'finish', version: '1' },
				inputs: { value: { source: 'root', root: 'input' } },
			},
		],
		result: { source: 'node', nodeId: 'finish', output: 'result' },
	}
}

function plan(registry: LearningRegistry, inputSchema: ValueSchema = text) {
	return planRecipe(registry, {
		recipe: { id: 'recipe', version: '1' },
		roots: { input: { schema: inputSchema, value: 'source' } },
		memoryType: 'text',
		availableCapabilities: new Set(),
		revisions: { memory: 3, configuration: 2, registry: 'registry-4' },
		limits: { maxNodes: 4, maxCollectionItems: 4, maxOperations: 4 },
	})
}

describe('LearningRegistry and planRecipe', () => {
	it('pins a deeply immutable recipe, roots, configuration, and revisions', () => {
		const configuration = { nested: { value: 'before' } }
		const mutableRecipe: Recipe = {
			...recipe(),
			nodes: [{ ...recipe().nodes[0]!, configuration }],
		}
		const configured: Operation = {
			...resultOperation,
			configurationSchema: defineSchema({
				id: 'config',
				version: '1',
				parse: (value) => value,
			}),
		}
		const registry = new LearningRegistry()
		registry.registerOperation(configured)
		registry.registerRecipe(mutableRecipe)
		configuration.nested.value = 'after'
		const executionPlan = plan(registry)

		expect(executionPlan.revisions).toEqual({
			memory: 3,
			configuration: 2,
			registry: 'registry-4',
		})
		expect(executionPlan.nodes[0]?.configuration).toEqual({
			nested: { value: 'before' },
		})
		expect(Object.isFrozen(executionPlan.nodes)).toBe(true)
		expect(Object.isFrozen(executionPlan.roots.input?.value)).toBe(true)
	})

	it('rejects replacement while keeping tuple keys collision-free', () => {
		const registry = new LearningRegistry()
		registry.registerOperation({ ...resultOperation, id: 'a@b', version: 'c' })
		registry.registerOperation({ ...resultOperation, id: 'a', version: 'b@c' })
		expect(registry.getOperation({ id: 'a@b', version: 'c' })?.id).toBe('a@b')
		expect(registry.getOperation({ id: 'a', version: 'b@c' })?.id).toBe('a')
		expect(() => registry.registerOperation(resultOperation)).not.toThrow()
		expect(() => registry.registerOperation({ ...resultOperation })).toThrow(
			'operation version finish@1 is immutable',
		)
	})

	it('rejects a different schema object with the same textual identity', () => {
		const impostor = defineSchema({
			id: text.id,
			version: text.version,
			parse: () => 42,
		})
		const registry = new LearningRegistry()
		registry.registerOperation(resultOperation)
		registry.registerRecipe(recipe(impostor))

		expect(() => plan(registry, impostor)).toThrow('incompatible binding')
	})

	it('rejects cycles, missing capabilities, memory mismatches, and excessive work', () => {
		const capable: Operation = {
			...resultOperation,
			id: 'capable',
			requiredCapabilities: ['local-decision'],
			memoryTypes: ['list'],
		}
		const registry = new LearningRegistry()
		registry.registerOperation(capable)
		registry.registerRecipe({
			id: 'recipe',
			version: '1',
			nodes: [
				{
					kind: 'operation',
					id: 'one',
					operation: { id: 'capable', version: '1' },
					inputs: { value: { source: 'node', nodeId: 'two', output: 'result' } },
				},
				{
					kind: 'operation',
					id: 'two',
					operation: { id: 'capable', version: '1' },
					inputs: { value: { source: 'node', nodeId: 'one', output: 'result' } },
				},
			],
			result: { source: 'node', nodeId: 'two', output: 'result' },
		})
		expect(() => plan(registry)).toThrow('operation capable does not support text')

		const missingCapabilityRegistry = new LearningRegistry()
		missingCapabilityRegistry.registerOperation({
			...capable,
			id: 'finish',
			memoryTypes: ['text'],
		})
		missingCapabilityRegistry.registerRecipe(recipe())
		expect(() => plan(missingCapabilityRegistry)).toThrow(
			'missing capability local-decision',
		)

		const normalRegistry = new LearningRegistry()
		normalRegistry.registerOperation(resultOperation)
		normalRegistry.registerRecipe({
			...recipe(),
			nodes: [
				{ ...recipe().nodes[0]!, id: 'one', after: ['two'] },
				{ ...recipe().nodes[0]!, id: 'two', after: ['one'] },
			],
			result: { source: 'node', nodeId: 'two', output: 'result' },
		})
		expect(() => plan(normalRegistry)).toThrow('recipe graph must not contain a cycle')

		const bounded = new LearningRegistry()
		bounded.registerOperation({
			id: 'copy', version: '1', inputSchemas: { value: text }, outputSchemas: { value: text }, requiredCapabilities: [],
			run: ({ value }) => ({ value }),
		})
		bounded.registerOperation(resultOperation)
		bounded.registerRecipe({
			...recipe(),
			nodes: [
				{ kind: 'operation', id: 'copy', operation: { id: 'copy', version: '1' }, inputs: { value: { source: 'root', root: 'input' } } },
				{ kind: 'operation', id: 'finish', operation: { id: 'finish', version: '1' }, inputs: { value: { source: 'node', nodeId: 'copy', output: 'value' } } },
			],
		})
		expect(() =>
			planRecipe(bounded, {
				recipe: { id: 'recipe', version: '1' },
				roots: { input: { schema: text, value: 'source' } },
				memoryType: 'text',
				availableCapabilities: new Set(),
				revisions: { memory: 1, configuration: 1, registry: 'r' },
				limits: { maxNodes: 2, maxCollectionItems: 1, maxOperations: 1 },
			}),
		).toThrow('recipe exceeds the operation limit')
	})
})
