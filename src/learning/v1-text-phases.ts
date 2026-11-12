import type {
	LearnOptions,
	LearnOutput,
	LearnPreparation,
} from '../neurons/base'
import {
	type BudgetClaim,
	type BudgetController,
	type CapabilityResolver,
	defineOperation,
	defineSchema,
	type LearningResult,
	learningResultSchema,
	type PlanningLimits,
	type Recipe,
	type RecipeExecution,
	type RevisionPins,
} from './contracts'
import { runRecipe } from './executor'
import { planRecipe } from './planner'
import { booleanValueSchema, stringArrayValueSchema } from './recipes/common'
import { LearningRegistry } from './registry'

const V1_TEXT_PHASE_LEARNER = 'adapt.v1-text-phase-learner'
const PREPARE_OPERATION = { id: 'adapt.v1-text.prepare', version: '1' } as const
const COMPLETE_OPERATION = {
	id: 'adapt.v1-text.complete',
	version: '1',
} as const
const RECIPE = { id: 'adapt.v1-text.learn', version: '1' } as const

export interface V1TextPhaseLearner {
	prepareLearning(
		batch: unknown[],
		options?: LearnOptions,
	): Promise<LearnPreparation>
	completeLearning(preparation: LearnPreparation): Promise<LearnOutput>
}

export interface V1TextPhaseDagInput {
	readonly batch: readonly string[]
	readonly forceSynthesize: boolean
	readonly signal?: AbortSignal
	readonly budget?: BudgetController
}

export interface V1TextPhaseDagOutput {
	readonly output?: LearnOutput
	readonly execution: RecipeExecution
}

export interface V1TextPhaseDag {
	learn(input: V1TextPhaseDagInput): Promise<V1TextPhaseDagOutput>
}

export interface V1TextPhaseDagConfig {
	readonly revisions: RevisionPins
	readonly planningLimits: PlanningLimits
	readonly operationBudget: number
}

function parsePreparation(value: unknown): LearnPreparation {
	if (typeof value !== 'object' || value === null || !('kind' in value)) {
		throw new Error('v1 learning preparation is invalid')
	}
	const preparation = value as {
		kind?: unknown
		failureEvent?: unknown
		output?: unknown
	}
	if (preparation.kind === 'complete' && preparation.output !== undefined) {
		return value as LearnPreparation
	}
	if (
		preparation.kind === 'synthesize' &&
		(preparation.failureEvent === 'emit' || preparation.failureEvent === 'skip')
	) {
		return value as LearnPreparation
	}
	throw new Error('v1 learning preparation is invalid')
}

function parseLearnOutput(value: unknown): LearnOutput {
	if (typeof value !== 'object' || value === null || !('status' in value)) {
		throw new Error('v1 learn output is invalid')
	}
	const status = (value as { status?: unknown }).status
	if (
		status !== 'observed' &&
		status !== 'observe:dismissed' &&
		status !== 'observe:error' &&
		status !== 'synthesized' &&
		status !== 'synthesize:dismissed' &&
		status !== 'synthesize:error'
	) {
		throw new Error('v1 learn output status is invalid')
	}
	return value as LearnOutput
}

const preparationSchema = defineSchema<LearnPreparation>({
	id: 'adapt.v1-text.learn-preparation',
	version: '1',
	parse: parsePreparation,
})

const learnOutputSchema = defineSchema<LearnOutput>({
	id: 'adapt.v1-text.learn-output',
	version: '1',
	parse: parseLearnOutput,
})

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function executionResult(output: LearnOutput): LearningResult {
	if (
		output.status === 'observe:error' ||
		output.status === 'synthesize:error'
	) {
		return {
			outcome: 'failure',
			code: output.status,
			reason: errorMessage(output.error),
			retryable: true,
			diagnostics: { output },
		}
	}
	// The self-persisting v1 learner already committed its state. `no_change`
	// means there is no second patch for the DAG caller to apply.
	return {
		outcome: 'no_change',
		reason: `v1 learner persisted status ${output.status}; the DAG has no additional patch to commit`,
		diagnostics: { output },
	}
}

function learner(context: {
	readonly capabilities: CapabilityResolver
}): V1TextPhaseLearner {
	const value = context.capabilities.get<V1TextPhaseLearner>(
		V1_TEXT_PHASE_LEARNER,
	)
	if (value === undefined)
		throw new Error('v1 text phase learner is unavailable')
	return value
}

function registry(): LearningRegistry {
	const registry = new LearningRegistry()
	registry.registerOperation(
		defineOperation({
			...PREPARE_OPERATION,
			inputSchemas: {
				batch: stringArrayValueSchema,
				forceSynthesize: booleanValueSchema,
			},
			outputSchemas: { preparation: preparationSchema },
			requiredCapabilities: [V1_TEXT_PHASE_LEARNER],
			memoryTypes: ['text'],
			async run({ batch, forceSynthesize }, context) {
				return {
					preparation: await learner(context).prepareLearning([...batch], {
						forceSynthesize,
					}),
				}
			},
		}),
	)
	registry.registerOperation(
		defineOperation({
			...COMPLETE_OPERATION,
			inputSchemas: { preparation: preparationSchema },
			outputSchemas: {
				output: learnOutputSchema,
				result: learningResultSchema,
			},
			requiredCapabilities: [V1_TEXT_PHASE_LEARNER],
			memoryTypes: ['text'],
			async run({ preparation }, context) {
				const output = await learner(context).completeLearning(preparation)
				return { output, result: executionResult(output) }
			},
		}),
	)
	const recipe: Recipe = {
		...RECIPE,
		memoryTypes: ['text'],
		nodes: [
			{
				kind: 'operation',
				id: 'prepare',
				operation: PREPARE_OPERATION,
				inputs: {
					batch: { source: 'root', root: 'batch' },
					forceSynthesize: { source: 'root', root: 'forceSynthesize' },
				},
			},
			{
				kind: 'operation',
				id: 'complete',
				operation: COMPLETE_OPERATION,
				inputs: {
					preparation: {
						source: 'node',
						nodeId: 'prepare',
						output: 'preparation',
					},
				},
			},
		],
		result: { source: 'node', nodeId: 'complete', output: 'result' },
	}
	registry.registerRecipe(recipe)
	return registry
}

class FixedBudget implements BudgetController {
	private used = 0
	constructor(private readonly limit: number) {}

	claim(_claim: BudgetClaim): boolean {
		if (this.used >= this.limit) return false
		this.used += 1
		return true
	}

	snapshot(): unknown {
		return { operations: this.used, limit: this.limit }
	}
}

class LearnerCapabilities implements CapabilityResolver {
	constructor(private readonly value: V1TextPhaseLearner) {}

	has(id: string): boolean {
		return id === V1_TEXT_PHASE_LEARNER
	}

	get<T = unknown>(id: string): T | undefined {
		return id === V1_TEXT_PHASE_LEARNER ? (this.value as T) : undefined
	}
}

export function createV1TextPhaseDag(
	phaseLearner: V1TextPhaseLearner,
	config: V1TextPhaseDagConfig,
): V1TextPhaseDag {
	if (!Number.isInteger(config.operationBudget) || config.operationBudget < 1) {
		throw new Error('v1 text phase operationBudget must be a positive integer')
	}
	const operations = registry()
	const capabilities = new LearnerCapabilities(phaseLearner)
	return {
		async learn(input) {
			const plan = planRecipe(operations, {
				recipe: RECIPE,
				roots: {
					batch: { schema: stringArrayValueSchema, value: input.batch },
					forceSynthesize: {
						schema: booleanValueSchema,
						value: input.forceSynthesize,
					},
				},
				memoryType: 'text',
				availableCapabilities: new Set([V1_TEXT_PHASE_LEARNER]),
				revisions: config.revisions,
				limits: config.planningLimits,
			})
			const execution = await runRecipe(plan, {
				capabilities,
				budget: input.budget ?? new FixedBudget(config.operationBudget),
				signal: input.signal ?? new AbortController().signal,
			})
			const complete = execution.nodes.find(
				({ nodeId }) => nodeId === 'complete',
			)
			const raw = complete?.rawOutput
			const output =
				typeof raw === 'object' && raw !== null && 'output' in raw
					? parseLearnOutput((raw as { output: unknown }).output)
					: undefined
			return { ...(output === undefined ? {} : { output }), execution }
		},
	}
}
