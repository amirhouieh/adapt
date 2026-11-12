import {
	defineOperation,
	type LearningResult,
	learningResultSchema,
	type OperationContext,
	type Recipe,
	type VersionRef,
} from '../contracts'
import type { LearningRegistry } from '../registry'
import type {
	ModelOperationInput,
	ProcedurePorts,
	ProseOutcome,
	ProseRequest,
	TextInput,
	TextLearningLens,
} from './contracts'
import { TEXT_PROCEDURE_RUNTIME_CAPABILITY } from './operations'
import { modelOperationInputValueSchema } from './schemas'

/**
 * Two-step learning keeps one plain-text understanding per neuron. Each run
 * makes at most two model calls: extract what the batch says about the topic,
 * then update the understanding with that extract. No schema, no line
 * selection, no capacity rejection: the update step keeps the understanding
 * small on its own. Prompts are the eval arm `twostep` in
 * evals/scripts/bare-text-arm.ts, unchanged.
 */

export const twoStepOperationRef = Object.freeze({
	id: 'adapt.text-procedure.narrative.two-step',
	version: '1',
})

export const twoStepRecipeRef = Object.freeze({
	id: 'adapt.text-procedure.two-step',
	version: '1',
})

/** The exact reply the extract step gives when nothing in the batch is relevant. */
export const TWO_STEP_NOTHING_RELEVANT = 'NONE'

function rulesBlock(lens: TextLearningLens): string {
	if (lens.developerInstructions.length === 0) return ''
	return `\n\nRules from the developer:\n${lens.developerInstructions
		.map((rule) => `- ${rule}`)
		.join('\n')}`
}

export const twoStepPrompts = Object.freeze({
	extractSystem: (lens: TextLearningLens) =>
		`Here is some data. Our job is to extract whatever valuable and relevant pieces of information it has related to this topic:
${lens.purpose}${rulesBlock(lens)}

Reply with the extracted information only, in plain text. If nothing in the data is relevant, reply with exactly: ${TWO_STEP_NOTHING_RELEVANT}`,
	extractPrompt: (inputs: readonly TextInput[]) =>
		`Data:\n${inputs.map(({ text }) => text).join('\n\n')}`,
	updateSystem: (lens: TextLearningLens) =>
		`Here is information extracted about this topic:
${lens.purpose}${rulesBlock(lens)}

and here is our existing understanding of it. Update the understanding accordingly.
Reply with the updated understanding only, in plain text.`,
	updatePrompt: (understanding: string, extracted: string) =>
		`Existing understanding:\n${understanding.length > 0 ? understanding : '(none yet)'}\n\nExtracted information:\n${extracted}`,
})

function request(
	input: ModelOperationInput,
	system: string,
	prompt: string,
): ProseRequest {
	return {
		system,
		prompt,
		response: { kind: 'prose', controls: [] },
		loadedContextTokens: input.limits.loadedContextTokens,
		reservedOutputTokens: input.limits.reservedOutputTokens,
	}
}

export function twoStepRequests(
	input: ModelOperationInput,
	extracted: string,
): { readonly extract: ProseRequest; readonly update: ProseRequest } {
	return {
		extract: request(
			input,
			twoStepPrompts.extractSystem(input.lens),
			twoStepPrompts.extractPrompt(input.inputs),
		),
		update: request(
			input,
			twoStepPrompts.updateSystem(input.lens),
			twoStepPrompts.updatePrompt(input.memory.text, extracted),
		),
	}
}

function runtime(
	context: OperationContext,
): Pick<ProcedurePorts, 'provider' | 'tokens'> {
	const value = context.capabilities.get<
		Pick<ProcedurePorts, 'provider' | 'tokens'>
	>(TEXT_PROCEDURE_RUNTIME_CAPABILITY)
	if (value === undefined)
		throw new Error('text procedure runtime capability is unavailable')
	return value
}

async function generate(
	context: OperationContext,
	modelRequest: ProseRequest,
): Promise<ProseOutcome> {
	const ports = runtime(context)
	const count = ports.tokens.countRequest(modelRequest)
	if (
		count.tokens + modelRequest.reservedOutputTokens >
		modelRequest.loadedContextTokens
	) {
		return { status: 'failure', code: 'context_exceeded', retryable: false }
	}
	const nodeId = twoStepOperationRef.id
	if (!context.budget.claim({ kind: 'tokens', amount: count.tokens, nodeId })) {
		return {
			status: 'failure',
			code: 'token_budget_exhausted',
			retryable: true,
		}
	}
	if (!context.budget.claim({ kind: 'provider_call', amount: 1, nodeId })) {
		return {
			status: 'failure',
			code: 'provider_budget_exhausted',
			retryable: true,
		}
	}
	if (context.signal.aborted) {
		return {
			status: 'failure',
			code: 'cancelled',
			retryable: true,
			cause: context.signal.reason,
		}
	}
	return ports.provider.generate(modelRequest, context.signal)
}

/**
 * A cut-off answer (output limit reached) is kept pending, not dropped: the
 * run is deferred, its inputs stay in the durable queue, and the next attempt
 * extracts them again and carries them into the next update. Other failures
 * keep the provider's retry classification.
 */
function failed(
	step: 'extract' | 'update',
	outcome: ProseOutcome,
	input: ModelOperationInput,
): LearningResult {
	const pendingInputIds = input.inputs.map(({ deliveryId }) => deliveryId)
	if (outcome.status === 'failure' && outcome.code === 'finish_length') {
		return {
			outcome: 'defer',
			reason: `two_step_${step}_cut_off`,
			pendingInputIds,
		}
	}
	if (outcome.status === 'failure') {
		return {
			outcome: 'failure',
			code: outcome.code,
			reason: `two-step ${step}: ${outcome.code}`,
			retryable: outcome.retryable,
		}
	}
	return {
		outcome: 'failure',
		code: `two_step_${step}_${outcome.status}`,
		reason: `two-step ${step} returned ${outcome.status} instead of text`,
		retryable: false,
	}
}

/** True when the extract step found nothing relevant. */
export function saysNothingRelevant(text: string): boolean {
	return text.trim() === TWO_STEP_NOTHING_RELEVANT
}

export async function runTwoStep(
	input: ModelOperationInput,
	context: OperationContext,
): Promise<LearningResult> {
	const consumedInputIds = input.inputs.map(({ deliveryId }) => deliveryId)
	const extract = await generate(context, twoStepRequests(input, '').extract)
	if (extract.status !== 'complete') return failed('extract', extract, input)
	const extracted = extract.text.trim()
	if (saysNothingRelevant(extracted)) {
		return {
			outcome: 'no_change',
			reason: 'two_step_nothing_relevant',
			consumedInputIds,
		}
	}
	const update = await generate(
		context,
		twoStepRequests(input, extracted).update,
	)
	if (update.status !== 'complete') return failed('update', update, input)
	const understanding = update.text.trim()
	if (understanding === input.memory.text) {
		return {
			outcome: 'no_change',
			reason: 'two_step_no_change',
			consumedInputIds,
		}
	}
	return {
		outcome: 'change',
		patch: { type: 'replace', text: understanding },
		expectedMemoryRevision: input.memory.revision,
		expectedConfigurationRevision: context.revisions.configuration,
		consumedInputIds,
		explanation: `two-step: learned from ${consumedInputIds.length} input${consumedInputIds.length === 1 ? '' : 's'}.`,
	}
}

export function registerTwoStepOperation(registry: LearningRegistry): void {
	registry.registerOperation(
		defineOperation({
			...twoStepOperationRef,
			inputSchemas: { input: modelOperationInputValueSchema },
			outputSchemas: { result: learningResultSchema },
			requiredCapabilities: [TEXT_PROCEDURE_RUNTIME_CAPABILITY],
			memoryTypes: ['text'],
			async run({ input }, context) {
				return { result: await runTwoStep(input, context) }
			},
		}),
	)
}

export function twoStepRecipe(): Recipe {
	return {
		...twoStepRecipeRef,
		memoryTypes: ['text'],
		nodes: [
			{
				kind: 'operation',
				id: 'two-step',
				operation: twoStepOperationRef,
				inputs: { input: { source: 'root', root: 'input' } },
			},
		],
		result: { source: 'node', nodeId: 'two-step', output: 'result' },
	}
}

export function isTwoStepProcedure(ref: VersionRef): boolean {
	return (
		ref.id === twoStepRecipeRef.id && ref.version === twoStepRecipeRef.version
	)
}
