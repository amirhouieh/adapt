import type { Recipe, VersionRef } from '../contracts'
import type { LearningRegistry } from '../registry'
import {
	textProcedureOperationRefs,
	textProcedureVersion1WriteOperationRef,
} from './operations'

export const textProcedureVersion1DirectRecipeRef = Object.freeze({
	id: 'adapt.text-procedure.direct-revision',
	version: '1',
})

export const textProcedureRecipeRefs = Object.freeze({
	direct: Object.freeze({
		id: 'adapt.text-procedure.direct-revision',
		version: '2',
	}),
	compare: Object.freeze({
		id: 'adapt.text-procedure.compare-revision',
		version: '2',
	}),
	pattern: Object.freeze({
		id: 'adapt.text-procedure.pattern-revision',
		version: '2',
	}),
	comparePattern: Object.freeze({
		id: 'adapt.text-procedure.compare-pattern-revision',
		version: '2',
	}),
})

const root = { source: 'root', root: 'input' } as const
const absentComparison = { source: 'root', root: 'absentOutcome' } as const
const absentPattern = { source: 'root', root: 'absentOutcome' } as const

function noteNode(id: 'compare' | 'pattern') {
	return {
		kind: 'operation' as const,
		id,
		operation: textProcedureOperationRefs[id],
		inputs: { input: root },
	}
}

function writeNode(
	comparison: Recipe['result'],
	pattern: Recipe['result'],
	operation: VersionRef = textProcedureOperationRefs.write,
) {
	return {
		kind: 'operation' as const,
		id: 'write',
		operation,
		inputs: { input: root, comparison, pattern },
	}
}

export function textProcedureVersion1DirectRecipe(): Recipe {
	return {
		...textProcedureVersion1DirectRecipeRef,
		memoryTypes: ['text'],
		nodes: [
			writeNode(
				absentComparison,
				absentPattern,
				textProcedureVersion1WriteOperationRef,
			),
		],
		result: { source: 'node', nodeId: 'write', output: 'result' },
	}
}

export function textProcedureRecipes(): readonly Recipe[] {
	return [
		{
			...textProcedureRecipeRefs.direct,
			memoryTypes: ['text'],
			nodes: [writeNode(absentComparison, absentPattern)],
			result: { source: 'node', nodeId: 'write', output: 'result' },
		},
		{
			...textProcedureRecipeRefs.compare,
			memoryTypes: ['text'],
			nodes: [
				noteNode('compare'),
				writeNode(
					{ source: 'node', nodeId: 'compare', output: 'outcome' },
					absentPattern,
				),
			],
			result: { source: 'node', nodeId: 'write', output: 'result' },
		},
		{
			...textProcedureRecipeRefs.pattern,
			memoryTypes: ['text'],
			nodes: [
				noteNode('pattern'),
				writeNode(absentComparison, {
					source: 'node',
					nodeId: 'pattern',
					output: 'outcome',
				}),
			],
			result: { source: 'node', nodeId: 'write', output: 'result' },
		},
		{
			...textProcedureRecipeRefs.comparePattern,
			memoryTypes: ['text'],
			nodes: [
				noteNode('compare'),
				noteNode('pattern'),
				writeNode(
					{ source: 'node', nodeId: 'compare', output: 'outcome' },
					{ source: 'node', nodeId: 'pattern', output: 'outcome' },
				),
			],
			result: { source: 'node', nodeId: 'write', output: 'result' },
		},
	]
}

export function registerTextProcedureRecipes(
	registry: LearningRegistry,
): readonly VersionRef[] {
	return [textProcedureVersion1DirectRecipe(), ...textProcedureRecipes()].map(
		(recipe) => registry.registerRecipe(recipe),
	)
}
