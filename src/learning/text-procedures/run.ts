import type {
	BudgetClaim,
	BudgetController,
	LearningResult,
} from '../contracts'
import { runRecipe } from '../executor'
import { planRecipe } from '../planner'
import type {
	ModelOperationInput,
	PinnedProcedureRun,
	ProcedurePins,
	ProcedurePorts,
	ProcedureProposal,
	TextLearningConfig,
} from './contracts'
import { modelOperationInputValueSchema } from './schemas'
import {
	registerTwoStepOperation,
	TEXT_PROCEDURE_RUNTIME_CAPABILITY,
	twoStepRecipe,
} from './two-step'

function sameRef(
	left: { id: string; version: string },
	right: { id: string; version: string },
): boolean {
	return left.id === right.id && left.version === right.version
}

function positive(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1)
		throw new Error(`${label} must be a positive integer`)
}

function nonnegative(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0)
		throw new Error(`${label} must be a nonnegative integer`)
}

export function validateTextLearningConfig(config: TextLearningConfig): void {
	if (config.lens.purpose.length === 0)
		throw new Error('lens purpose must not be empty')
	if (config.lens.incomingTextRole !== 'data-only')
		throw new Error('incoming text role must be data-only')
	positive(config.batching.maxItems, 'batching.maxItems')
	positive(config.batching.maxInputCharacters, 'batching.maxInputCharacters')
	positive(config.batching.maxInputTokens, 'batching.maxInputTokens')
	nonnegative(config.batching.maxDelayMs, 'batching.maxDelayMs')
	positive(config.input.maxItemCharacters, 'input.maxItemCharacters')
	positive(config.memory.maxCharacters, 'memory.maxCharacters')
	positive(
		config.generation.loadedContextTokens,
		'generation.loadedContextTokens',
	)
	positive(
		config.generation.reservedOutputTokens,
		'generation.reservedOutputTokens',
	)
	positive(config.generation.maxProviderCalls, 'generation.maxProviderCalls')
	positive(config.generation.maxTokenClaims, 'generation.maxTokenClaims')
	positive(config.generation.maxBudgetClaims, 'generation.maxBudgetClaims')
	if (
		config.generation.reservedOutputTokens >=
		config.generation.loadedContextTokens
	) {
		throw new Error(
			'reserved output tokens must be smaller than the loaded context',
		)
	}
	positive(config.planning.maxNodes, 'planning.maxNodes')
	positive(config.planning.maxCollectionItems, 'planning.maxCollectionItems')
	positive(config.planning.maxOperations, 'planning.maxOperations')
	nonnegative(config.retries.maxLogicalAttempts, 'retries.maxLogicalAttempts')
	nonnegative(config.retries.initialDelayMs, 'retries.initialDelayMs')
	nonnegative(config.retries.maxDelayMs, 'retries.maxDelayMs')
	nonnegative(config.retries.terminalAfterMs, 'retries.terminalAfterMs')
	positive(config.history.maxEntries, 'history.maxEntries')
	positive(config.history.maxCharacters, 'history.maxCharacters')
	nonnegative(
		config.idempotence.processedIdHorizonMs,
		'idempotence.processedIdHorizonMs',
	)
	positive(config.idempotence.maxProcessedIds, 'idempotence.maxProcessedIds')
	if (
		!config.allowedProcedures.some((ref) =>
			sameRef(ref, config.activeProcedure),
		)
	) {
		throw new Error('active procedure must be in the allowed catalogue')
	}
}

function budget(config: TextLearningConfig): BudgetController {
	const claims: BudgetClaim[] = []
	let operations = 0
	let providers = 0
	let tokens = 0
	return {
		claim(claim) {
			if (claims.length >= config.generation.maxBudgetClaims) return false
			if (claim.kind === 'operation') {
				if (operations + claim.amount > config.planning.maxOperations)
					return false
				operations += claim.amount
			}
			if (claim.kind === 'provider_call') {
				if (providers + claim.amount > config.generation.maxProviderCalls)
					return false
				providers += claim.amount
			}
			if (claim.kind === 'tokens') {
				if (tokens + claim.amount > config.generation.maxTokenClaims)
					return false
				tokens += claim.amount
			}
			claims.push(Object.freeze({ ...claim }))
			return true
		},
		snapshot: () =>
			Object.freeze({
				claims: Object.freeze([...claims]),
				operations,
				providers,
				tokens,
			}),
	}
}

function pins(value: ProcedurePins): ProcedurePins {
	return Object.freeze({
		execution: Object.freeze({ ...value.execution }),
		neuron: Object.freeze({ ...value.neuron }),
		procedure: Object.freeze({ ...value.procedure }),
		profile: Object.freeze({ ...value.profile }),
		model: Object.freeze({ ...value.model }),
		learnedStateRevision: value.learnedStateRevision,
	})
}

function immediate(
	run: PinnedProcedureRun,
	startedAt: string,
	completedAt: string,
	result: LearningResult,
): ProcedureProposal {
	return {
		pins: pins(run.pins),
		execution: {
			nodes: [],
			pending: [],
			budget: { claims: [], operations: 0, providers: 0, tokens: 0 },
		},
		result,
		trace: {
			runId: run.runId,
			startedAt,
			completedAt,
			procedure: Object.freeze({ ...run.pins.procedure }),
			inputIds: Object.freeze(run.inputs.map(({ deliveryId }) => deliveryId)),
		},
	}
}

export function registerAdaptiveTextProcedures(
	registry: ProcedurePorts['registry'],
): void {
	registerTwoStepOperation(registry)
	registry.registerRecipe(twoStepRecipe())
}

export async function runTextProcedure(
	run: PinnedProcedureRun,
	ports: ProcedurePorts,
): Promise<ProcedureProposal> {
	const startedAt = ports.clock.now()
	const pinnedRunPins = pins(run.pins)
	validateTextLearningConfig(run.configuration)
	if (!sameRef(run.pins.procedure, run.configuration.activeProcedure)) {
		throw new Error('run procedure does not match the pinned active procedure')
	}
	if (!sameRef(run.pins.model, run.configuration.model)) {
		throw new Error('run model does not match the pinned model')
	}
	if (run.memory.revision !== run.pins.execution.memory) {
		throw new Error(
			'memory snapshot does not match the pinned execution revision',
		)
	}
	if (run.inputs.length === 0)
		throw new Error('procedure run requires at least one input')
	const tooLarge = run.inputs.find(
		({ text }) => text.length > run.configuration.input.maxItemCharacters,
	)
	if (tooLarge !== undefined) {
		return immediate(run, startedAt, ports.clock.now(), {
			outcome: 'failure',
			code: 'input_too_large',
			retryable: false,
			reason: `input ${tooLarge.deliveryId} exceeds the configured item bound`,
		})
	}
	if (
		run.inputs.length > run.configuration.batching.maxItems ||
		run.inputs.reduce((total, input) => total + input.text.length, 0) >
			run.configuration.batching.maxInputCharacters
	) {
		return immediate(run, startedAt, ports.clock.now(), {
			outcome: 'defer',
			reason: 'selected batch exceeds its configured bound',
			pendingInputIds: run.inputs.map(({ deliveryId }) => deliveryId),
		})
	}
	const input: ModelOperationInput = {
		lens: run.configuration.lens,
		memory: run.memory,
		inputs: run.inputs,
		limits: {
			loadedContextTokens: run.configuration.generation.loadedContextTokens,
			reservedOutputTokens: run.configuration.generation.reservedOutputTokens,
		},
	}
	const plan = planRecipe(ports.registry, {
		recipe: run.pins.procedure,
		roots: {
			input: { schema: modelOperationInputValueSchema, value: input },
		},
		memoryType: 'text',
		availableCapabilities: new Set([TEXT_PROCEDURE_RUNTIME_CAPABILITY]),
		revisions: run.pins.execution,
		limits: run.configuration.planning,
	})
	const execution = await runRecipe(plan, {
		signal: run.signal,
		capabilities: {
			has: (id) => id === TEXT_PROCEDURE_RUNTIME_CAPABILITY,
			get: <T>(id: string) =>
				id === TEXT_PROCEDURE_RUNTIME_CAPABILITY
					? ({ provider: ports.provider, tokens: ports.tokens } as T)
					: undefined,
		},
		budget: budget(run.configuration),
	})
	return {
		pins: pinnedRunPins,
		execution: {
			nodes: execution.nodes,
			pending: execution.pending,
			budget: execution.budget,
		},
		result: execution.result,
		trace: {
			runId: run.runId,
			startedAt,
			completedAt: ports.clock.now(),
			procedure: pinnedRunPins.procedure,
			inputIds: Object.freeze(run.inputs.map(({ deliveryId }) => deliveryId)),
		},
	}
}
