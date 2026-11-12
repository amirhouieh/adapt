import type {
	ModelOperationInput,
	ProcedurePorts,
	TextInput,
	TextLearningConfig,
} from './contracts'
import { isTwoStepProcedure, twoStepRequests } from './two-step'

export interface TextProcedureCapacityInput {
	readonly configuration: TextLearningConfig
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
}

export type TextProcedureCapacity =
	| { readonly status: 'fits' }
	| {
			readonly status: 'input-too-large'
			readonly deliveryId: string
			readonly reason: string
	  }
	| { readonly status: 'memory-capacity'; readonly reason: string }

export function fitTextProcedureRequest(
	value: TextProcedureCapacityInput,
	tokens: ProcedurePorts['tokens'],
): TextProcedureCapacity {
	for (const input of value.inputs) {
		if (input.text.length > value.configuration.input.maxItemCharacters) {
			return {
				status: 'input-too-large',
				deliveryId: input.deliveryId,
				reason: 'input exceeds the configured item character bound',
			}
		}
	}
	if (value.inputs.length > value.configuration.batching.maxItems) {
		return {
			status: 'memory-capacity',
			reason: 'batch contains too many complete inputs',
		}
	}
	const inputCharacters = value.inputs.reduce(
		(total, input) => total + input.text.length,
		0,
	)
	if (inputCharacters > value.configuration.batching.maxInputCharacters) {
		return {
			status: 'memory-capacity',
			reason: 'batch exceeds the configured input character bound',
		}
	}
	const inputTokens = value.inputs.reduce(
		(total, input) => total + tokens.countText(input.text).tokens,
		0,
	)
	if (inputTokens > value.configuration.batching.maxInputTokens) {
		return {
			status: 'memory-capacity',
			reason: 'batch exceeds the configured input token bound',
		}
	}
	if (!isTwoStepProcedure(value.configuration.activeProcedure))
		throw new Error(
			'active procedure is not a registered adaptive text procedure',
		)
	return fitTwoStep(value, tokens)
}

/**
 * Two-step sends the batch to the extract step and the whole understanding
 * plus that extract to the update step. The extract is at most one response
 * long, so the update request reserves one response for it. There is no
 * memory character bound here: only whether both requests fit the context.
 */
function fitTwoStep(
	value: TextProcedureCapacityInput,
	tokens: ProcedurePorts['tokens'],
): TextProcedureCapacity {
	const generation = value.configuration.generation
	const base: ModelOperationInput = {
		lens: value.configuration.lens,
		memory: value.memory,
		inputs: value.inputs,
		limits: {
			loadedContextTokens: generation.loadedContextTokens,
			reservedOutputTokens: generation.reservedOutputTokens,
		},
	}
	const requests = twoStepRequests(base, '')
	const extract = tokens.countRequest(requests.extract).tokens
	const update =
		tokens.countRequest(requests.update).tokens +
		generation.reservedOutputTokens
	if (
		Math.max(extract, update) + generation.reservedOutputTokens >
		generation.loadedContextTokens
	)
		return {
			status: 'memory-capacity',
			reason: 'a two-step request exceeds the loaded context',
		}
	return { status: 'fits' }
}
