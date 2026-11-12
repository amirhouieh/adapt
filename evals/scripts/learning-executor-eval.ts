/**
 * Eval: portable learning recipe runner
 *
 * Records an actual planner/runner input and output for human inspection.
 * It contains no assertions, comparisons, grading, or acceptance logic.
 *
 * Run:
 *   npx tsx evals/scripts/learning-executor-eval.ts <config.json> <output-directory>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { z } from 'zod'

import {
	LearningRegistry,
	arraySchema,
	defineOperation,
	defineSchema,
	learningResultSchema,
	planRecipe,
	runRecipe,
	type BudgetClaim,
	type Recipe,
} from '../../src/learning/index'

const configPathArgument = process.argv[2]
const outputDirectoryArgument = process.argv[3]
if (configPathArgument === undefined || outputDirectoryArgument === undefined) {
	throw new Error('provide a config path and output directory')
}
const configPath = resolve(configPathArgument)
const outputDirectory = resolve(outputDirectoryArgument)

const VersionSchema = z.object({ id: z.string().min(1), version: z.string().min(1) }).strict()
const EvalConfigSchema = z.object({
	eval: z.object({ name: z.string().min(1), modelReason: z.string().min(1) }).strict(),
	schemas: z.object({ text: VersionSchema, boolean: VersionSchema, texts: VersionSchema }).strict(),
	recipe: z.object({
		id: z.string().min(1), version: z.string().min(1),
		nodes: z.object({ gate: z.string().min(1), collection: z.string().min(1), result: z.string().min(1) }).strict(),
		operations: z.object({ gate: VersionSchema, collection: VersionSchema, result: VersionSchema }).strict(),
		collectionLimit: z.number().int().positive(),
	}).strict(),
	roots: z.object({ memory: z.string(), observations: z.array(z.string()) }).strict(),
	revisions: z.object({ memory: z.number().int().nonnegative(), configuration: z.number().int().nonnegative(), registry: z.string().min(1) }).strict(),
	limits: z.object({ maxNodes: z.number().int().positive(), maxCollectionItems: z.number().int().positive(), maxOperations: z.number().int().positive(), maxBudgetClaims: z.number().int().positive() }).strict(),
	result: z.object({ consumedInputIds: z.array(z.string()), explanation: z.string().min(1) }).strict(),
}).strict()

async function main() {
	const configText = await readFile(configPath, 'utf8')
	const config = EvalConfigSchema.parse(JSON.parse(configText))
	const text = defineSchema({
		...config.schemas.text,
		parse(value: unknown) {
			if (typeof value !== 'string') throw new Error('expected text')
			return value
		},
	})
	const boolean = defineSchema({
		...config.schemas.boolean,
		parse(value: unknown) {
			if (typeof value !== 'boolean') throw new Error('expected boolean')
			return value
		},
	})
	const texts = arraySchema(config.schemas.texts.id, config.schemas.texts.version, text)
	const recipe: Recipe = {
		id: config.recipe.id,
		version: config.recipe.version,
		memoryTypes: ['text'],
		nodes: [
			{
				kind: 'gate', id: config.recipe.nodes.gate,
				operation: config.recipe.operations.gate,
				inputs: { observations: { source: 'root', root: 'observations' } },
				appliesOutput: 'applies',
			},
			{
				kind: 'collection', id: config.recipe.nodes.collection,
				operation: config.recipe.operations.collection,
				inputs: {}, items: { source: 'root', root: 'observations' },
				itemInput: 'observation', limit: config.recipe.collectionLimit,
				outputSchemas: { evidence: texts }, after: [config.recipe.nodes.gate],
			},
			{
				kind: 'operation', id: config.recipe.nodes.result,
				operation: config.recipe.operations.result,
				inputs: {
					memory: { source: 'root', root: 'memory' },
					evidence: { source: 'node', nodeId: config.recipe.nodes.collection, output: 'evidence' },
				},
			},
		],
		result: { source: 'node', nodeId: config.recipe.nodes.result, output: 'result' },
	}
	const roots = {
		memory: { schema: text, value: config.roots.memory },
		observations: { schema: texts, value: config.roots.observations },
	}
	const planningInput = {
		recipe: { id: recipe.id, version: recipe.version },
		memoryType: 'text' as const,
		availableCapabilities: [] as string[],
		revisions: config.revisions,
		limits: {
			maxNodes: config.limits.maxNodes,
			maxCollectionItems: config.limits.maxCollectionItems,
			maxOperations: config.limits.maxOperations,
		},
	}
	await mkdir(outputDirectory, { recursive: true })
	await writeFile(
		resolve(outputDirectory, 'raw-input.json'),
		JSON.stringify({ config, recipe, roots: config.roots, planningInput }, null, 2),
	)
	const registry = new LearningRegistry()
	registry.registerOperation(defineOperation({
		...config.recipe.operations.gate,
		inputSchemas: { observations: texts }, outputSchemas: { applies: boolean }, requiredCapabilities: [],
		run: ({ observations }) => ({ applies: observations.length > 0 }),
	}))
	registry.registerOperation(defineOperation({
		...config.recipe.operations.collection,
		inputSchemas: { observation: text }, outputSchemas: { evidence: text }, requiredCapabilities: [],
		run: ({ observation }) => ({ evidence: observation }),
	}))
	registry.registerOperation(defineOperation({
		...config.recipe.operations.result,
		inputSchemas: { memory: text, evidence: texts }, outputSchemas: { result: learningResultSchema }, requiredCapabilities: [],
		run: ({ memory, evidence }) => ({
			result: {
				outcome: 'change' as const,
				patch: { current: memory, supportedAddition: evidence },
				expectedMemoryRevision: config.revisions.memory,
				expectedConfigurationRevision: config.revisions.configuration,
				consumedInputIds: config.result.consumedInputIds,
				supportReferences: evidence,
				explanation: config.result.explanation,
			},
		}),
	}))
	registry.registerRecipe(recipe)
	const plan = planRecipe(registry, {
		...planningInput, roots,
		availableCapabilities: new Set(planningInput.availableCapabilities),
	})
	const claims: BudgetClaim[] = []
	const output = await runRecipe(plan, {
		signal: new AbortController().signal,
		capabilities: { has: () => false, get: () => undefined },
		budget: {
			claim(claim) {
				if (claims.length >= config.limits.maxBudgetClaims) return false
				claims.push(claim)
				return true
			},
			snapshot: () => ({ claims }),
		},
	})
	await writeFile(resolve(outputDirectory, 'raw-output.json'), JSON.stringify(output, null, 2))
	await writeFile(
		resolve(outputDirectory, 'raw-output.inspect.txt'),
		inspect(output, { depth: null, maxArrayLength: null, maxStringLength: null }),
	)
	await writeFile(
		resolve(outputDirectory, 'metadata.json'),
		JSON.stringify({
			eval: config.eval.name,
			timestamp: new Date().toISOString(),
			script: 'evals/scripts/learning-executor-eval.ts',
			configPath,
			model: null,
			modelReason: config.eval.modelReason,
		}, null, 2),
	)
	console.log(inspect(output, { depth: null, maxArrayLength: null, maxStringLength: null }))
}

main().catch(async (error: unknown) => {
	await mkdir(outputDirectory, { recursive: true })
	await writeFile(
		resolve(outputDirectory, 'raw-failure.inspect.txt'),
		inspect(error, { depth: null, maxArrayLength: null, maxStringLength: null }),
	)
	console.error(error)
	process.exitCode = 1
})
