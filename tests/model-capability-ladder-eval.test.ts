import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { modelCapabilityLadderSupport } from '../evals/scripts/model-capability-ladder-eval'
import {
	LEARNING_MODEL_CAPABILITY,
	LearningRegistry,
	learningLensValueSchema,
	learningObservationsValueSchema,
	planRecipe,
	registerNarrativeRecipe,
	runRecipe,
	stringArrayValueSchema,
	textMemorySnapshotValueSchema,
	type LearningModelCapability,
} from '../src/learning/index'

const repositoryRoot = resolve(import.meta.dirname, '..')

function fixture() {
	const dataset = modelCapabilityLadderSupport.datasetSchema.parse(
		JSON.parse(
			readFileSync(
				resolve(repositoryRoot, 'evals/datasets/model-capability-ladder.json'),
				'utf8',
			),
		) as unknown,
	)
	const config = modelCapabilityLadderSupport.configSchema.parse(
		JSON.parse(
			readFileSync(
				resolve(repositoryRoot, 'evals/config/model-capability-ladder-lfm.json'),
				'utf8',
			),
		) as unknown,
	)
	return { config, dataset }
}

async function recipeRequest(
	config: ReturnType<typeof fixture>['config'],
	caseId: string,
	stage: Extract<
		ReturnType<typeof fixture>['dataset']['cases'][number]['stages'][number],
		{ kind: 'recipe' }
	>,
) {
	const input = modelCapabilityLadderSupport.buildRecipeInput(
		config,
		caseId,
		stage,
	)
	const requests: Parameters<LearningModelCapability['generate']>[0][] = []
	const model: LearningModelCapability = {
		async generate(request) {
			requests.push(request)
			return {
				value: request.schema.parse({
					action: 'unchanged',
					target: '',
					text: '',
					reason: 'Already represented.',
				}),
				raw: null,
			}
		},
		async decide(): Promise<never> {
			throw new Error('unused')
		},
	}
	const registry = new LearningRegistry()
	registerNarrativeRecipe(registry, {
		recipeId: config.ids.recipeId,
		version: config.ids.recipeVersion,
		...stage.recipeLimits,
	})
	const roots = {
		lens: { schema: learningLensValueSchema, value: input.lens },
		memory: { schema: textMemorySnapshotValueSchema, value: input.memory },
		observations: {
			schema: learningObservationsValueSchema,
			value: input.observations,
		},
		processedInputIds: {
			schema: stringArrayValueSchema,
			value: input.processedInputIds,
		},
	}
	const plan = planRecipe(registry, {
		recipe: { id: config.ids.recipeId, version: config.ids.recipeVersion },
		roots,
		memoryType: 'text',
		availableCapabilities: new Set([LEARNING_MODEL_CAPABILITY]),
		revisions: {
			memory: config.revisions.memory,
			configuration: config.revisions.configuration,
			registry: config.ids.registryRevision,
		},
		limits: config.planning,
	})
	await runRecipe(plan, {
		signal: new AbortController().signal,
		capabilities: {
			has: (id) => id === LEARNING_MODEL_CAPABILITY,
			get: <T>(id: string) =>
				id === LEARNING_MODEL_CAPABILITY ? (model as T) : undefined,
		},
		budget: { claim: () => true, snapshot: () => null },
	})
	return requests
}

describe('model capability ladder harness', () => {
	it('parses every frozen provider config and the 3 by 10 dataset', () => {
		const { dataset } = fixture()
		for (const name of ['lfm', 'qwen', 'gemini']) {
			modelCapabilityLadderSupport.configSchema.parse(
				JSON.parse(
					readFileSync(
						resolve(
							repositoryRoot,
							`evals/config/model-capability-ladder-${name}.json`,
						),
						'utf8',
					),
				) as unknown,
			)
		}
		expect(dataset.cases).toHaveLength(3)
		expect(dataset.cases.map(({ stages }) => stages.length)).toEqual([
			10, 10, 10,
		])
	})

	it('keeps paired direct messages identical while only enforced requests carry schemas', () => {
		const { dataset } = fixture()
		for (const suppliedCase of dataset.cases) {
			for (const [promptedIndex, enforcedIndex] of [
				[1, 2],
				[4, 5],
			] as const) {
				const prompted = suppliedCase.stages[promptedIndex]
				const enforced = suppliedCase.stages[enforcedIndex]
				if (prompted?.kind !== 'direct' || enforced?.kind !== 'direct') {
					throw new Error('frozen direct stage pair is missing')
				}
				const promptedRequest =
					modelCapabilityLadderSupport.buildDirectRequest(prompted)
				const enforcedRequest =
					modelCapabilityLadderSupport.buildDirectRequest(enforced)
				expect({
					system: promptedRequest.system,
					prompt: promptedRequest.prompt,
				}).toEqual({
					system: enforcedRequest.system,
					prompt: enforcedRequest.prompt,
				})
				expect(promptedRequest).not.toHaveProperty('outputSchema')
				expect(enforcedRequest).toHaveProperty('outputSchema')
			}
		}
	})

	it('gives both recipe memory bounds identical production model messages', async () => {
		const { config, dataset } = fixture()
		for (const suppliedCase of dataset.cases) {
			const defaultBound = suppliedCase.stages[8]
			const largeBound = suppliedCase.stages[9]
			if (defaultBound?.kind !== 'recipe' || largeBound?.kind !== 'recipe') {
				throw new Error('frozen recipe stage pair is missing')
			}
			expect(defaultBound.recipeLimits.maxMemoryCharacters).toBe(2_000)
			expect(largeBound.recipeLimits.maxMemoryCharacters).toBe(8_000)
			const defaultRequests = await recipeRequest(
				config,
				suppliedCase.id,
				defaultBound,
			)
			const largeRequests = await recipeRequest(
				config,
				suppliedCase.id,
				largeBound,
			)
			expect(defaultRequests).toHaveLength(1)
			expect(largeRequests).toHaveLength(1)
			expect({
				system: defaultRequests[0]?.system,
				prompt: defaultRequests[0]?.prompt,
			}).toEqual({
				system: largeRequests[0]?.system,
				prompt: largeRequests[0]?.prompt,
			})
		}
	})
})
