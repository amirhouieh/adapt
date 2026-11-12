import type {
	ModelOperationInput,
	ProcedurePorts,
	TextInput,
	TextLearningConfig,
} from './contracts'
import {
	buildTextProcedureRequest,
	buildTextProcedureVersion1WriterRequest,
	textProcedurePrompts,
} from './operations'
import {
	fieldGroupsOf,
	fieldRevisionRequests,
	isFieldRevisionProcedure,
	parseStructuredMemory,
} from './field-revision'
import {
	isLineRevisionProcedure,
	lineRevisionRequests,
	lineRevisionVersionOf,
	splitNarrative,
} from './line-revision'
import {
	textProcedureRecipeRefs,
	textProcedureVersion1DirectRecipeRef,
} from './recipes'
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

function sameRef(
	left: { id: string; version: string },
	right: { id: string; version: string },
): boolean {
	return left.id === right.id && left.version === right.version
}

function procedureKinds(
	config: TextLearningConfig,
): readonly ('comparison' | 'pattern')[] {
	if (sameRef(config.activeProcedure, textProcedureVersion1DirectRecipeRef))
		return []
	if (sameRef(config.activeProcedure, textProcedureRecipeRefs.direct)) return []
	if (sameRef(config.activeProcedure, textProcedureRecipeRefs.compare))
		return ['comparison']
	if (sameRef(config.activeProcedure, textProcedureRecipeRefs.pattern))
		return ['pattern']
	if (sameRef(config.activeProcedure, textProcedureRecipeRefs.comparePattern))
		return ['comparison', 'pattern']
	throw new Error(
		'active procedure is not a registered adaptive text procedure',
	)
}

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
	if (isLineRevisionProcedure(value.configuration.activeProcedure)) {
		return fitLineRevision(value, tokens)
	}
	if (isFieldRevisionProcedure(value.configuration.activeProcedure)) {
		return fitFieldRevision(value, tokens)
	}
	if (isTwoStepProcedure(value.configuration.activeProcedure)) {
		return fitTwoStep(value, tokens)
	}
	const kinds = procedureKinds(value.configuration)
	const base: ModelOperationInput = {
		lens: value.configuration.lens,
		memory: value.memory,
		inputs: value.inputs,
		notes: [],
		limits: {
			loadedContextTokens: value.configuration.generation.loadedContextTokens,
			reservedOutputTokens: value.configuration.generation.reservedOutputTokens,
			maxNarrativeTokens: value.configuration.memory.maxNarrativeTokens,
			maxMemoryCharacters: value.configuration.memory.maxCharacters,
			maxNoteCharacters: value.configuration.generation.maxNoteCharacters,
			allowExplicitClear: value.configuration.memory.allowExplicitClear,
		},
	}
	const requests = kinds.map((kind) =>
		buildTextProcedureRequest(
			base,
			kind === 'comparison'
				? textProcedurePrompts.compare.phase
				: textProcedurePrompts.pattern.phase,
			kind === 'comparison'
				? textProcedurePrompts.compare.rootQuestion
				: textProcedurePrompts.pattern.rootQuestion,
			kind === 'comparison'
				? textProcedurePrompts.compare.controls
				: textProcedurePrompts.pattern.controls,
			kind === 'comparison'
				? textProcedurePrompts.compare.controlInstructions
				: textProcedurePrompts.pattern.controlInstructions,
			value.configuration.generation.maxNoteCharacters,
		),
	)
	const notes = kinds.map((kind) => ({ kind, text: '' }))
	requests.push(
		sameRef(
			value.configuration.activeProcedure,
			textProcedureVersion1DirectRecipeRef,
		)
			? buildTextProcedureVersion1WriterRequest(base)
			: buildTextProcedureRequest(
					{ ...base, notes },
					textProcedurePrompts.write.phase,
					textProcedurePrompts.write.rootQuestion,
					textProcedurePrompts.write.controls,
					textProcedurePrompts.write.controlInstructions,
				),
	)
	for (const [index, request] of requests.entries()) {
		const count = tokens.countRequest(request)
		const noteReservation =
			index === requests.length - 1
				? kinds.length *
					tokens.countTextBound(
						value.configuration.generation.maxNoteCharacters,
					).tokens
				: 0
		if (
			count.tokens + noteReservation + request.reservedOutputTokens >
			request.loadedContextTokens
		) {
			return {
				status: 'memory-capacity',
				reason: 'a complete procedure request exceeds the loaded context',
			}
		}
	}
	return { status: 'fits' }
}

function longest(lines: readonly string[], count: number): string[] {
	return [...lines].sort((left, right) => right.length - left.length).slice(0, count)
}

/**
 * Line revision never sends the whole narrative. Each request holds at most
 * one input plus a bounded number of memory lines, so the fit check sizes the
 * largest possible request of each kind.
 */
function fitLineRevision(
	value: TextProcedureCapacityInput,
	tokens: ProcedurePorts['tokens'],
): TextProcedureCapacity {
	const settings = value.configuration.lineRevision
	if (settings === undefined) {
		return {
			status: 'memory-capacity',
			reason: 'line revision requires its typed configuration',
		}
	}
	if (value.memory.text.length > value.configuration.memory.maxCharacters) {
		return {
			status: 'memory-capacity',
			reason: 'narrative exceeds the configured memory character bound',
		}
	}
	const lines = splitNarrative(value.memory.text)
	const base: ModelOperationInput = {
		lens: value.configuration.lens,
		memory: value.memory,
		inputs: value.inputs,
		notes: [],
		limits: {
			loadedContextTokens: value.configuration.generation.loadedContextTokens,
			reservedOutputTokens: value.configuration.generation.reservedOutputTokens,
			maxNarrativeTokens: value.configuration.memory.maxNarrativeTokens,
			maxMemoryCharacters: value.configuration.memory.maxCharacters,
			maxNoteCharacters: value.configuration.generation.maxNoteCharacters,
			allowExplicitClear: value.configuration.memory.allowExplicitClear,
			lineRevision: settings,
		},
	}
	const related = longest(lines, settings.maxRelatedLines)
	const cluster = longest(lines, settings.maxClusterLines)
	for (const input of value.inputs) {
		const requests = lineRevisionRequests(
			base,
			input,
			related,
			cluster,
			settings.minCompactionWords,
			lineRevisionVersionOf(value.configuration.activeProcedure),
		)
		for (const request of Object.values(requests)) {
			if (
				tokens.countRequest(request).tokens + request.reservedOutputTokens >
				request.loadedContextTokens
			) {
				return {
					status: 'memory-capacity',
					reason: 'a line revision request exceeds the loaded context',
				}
			}
		}
	}
	return { status: 'fits' }
}

/**
 * Field revision sends one input with at most one field's current value, so
 * the fit check sizes the largest relevance, selection, and value request.
 */
function fitFieldRevision(
	value: TextProcedureCapacityInput,
	tokens: ProcedurePorts['tokens'],
): TextProcedureCapacity {
	const settings = value.configuration.fieldRevision
	if (settings === undefined)
		return { status: 'memory-capacity', reason: 'field revision requires its typed configuration' }
	if (value.memory.text.length > value.configuration.memory.maxCharacters)
		return { status: 'memory-capacity', reason: 'structured memory exceeds the configured character bound' }
	let memory: Record<string, unknown>
	try {
		memory = parseStructuredMemory(value.memory.text)
	} catch {
		return { status: 'memory-capacity', reason: 'structured memory is not a JSON object' }
	}
	const groups = fieldGroupsOf(settings)
	const base: ModelOperationInput = {
		lens: value.configuration.lens,
		memory: value.memory,
		inputs: value.inputs,
		notes: [],
		limits: {
			loadedContextTokens: value.configuration.generation.loadedContextTokens,
			reservedOutputTokens: value.configuration.generation.reservedOutputTokens,
			maxNarrativeTokens: value.configuration.memory.maxNarrativeTokens,
			maxMemoryCharacters: value.configuration.memory.maxCharacters,
			maxNoteCharacters: value.configuration.generation.maxNoteCharacters,
			allowExplicitClear: value.configuration.memory.allowExplicitClear,
			fieldRevision: settings,
		},
	}
	for (const input of value.inputs) {
		const requests = fieldRevisionRequests(base, input)
		const all = [
			requests.relevance,
			requests.screen,
			...groups.map((group) => requests.select(group)),
			...groups.flatMap((group) =>
				group.leaves.map((leaf) => {
					const [first, second] = leaf.path.split('.') as [string, string | undefined]
					const container = memory[first]
					const current =
						second === undefined
							? container
							: container !== null && typeof container === 'object'
								? (container as Record<string, unknown>)[second]
								: undefined
					return requests.value(leaf, current)
				}),
			),
		]
		for (const request of all) {
			if (tokens.countRequest(request).tokens + request.reservedOutputTokens > request.loadedContextTokens)
				return { status: 'memory-capacity', reason: 'a field revision request exceeds the loaded context' }
		}
	}
	return { status: 'fits' }
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
		notes: [],
		limits: {
			loadedContextTokens: generation.loadedContextTokens,
			reservedOutputTokens: generation.reservedOutputTokens,
			maxNarrativeTokens: value.configuration.memory.maxNarrativeTokens,
			maxMemoryCharacters: value.configuration.memory.maxCharacters,
			maxNoteCharacters: generation.maxNoteCharacters,
			allowExplicitClear: value.configuration.memory.allowExplicitClear,
		},
	}
	const requests = twoStepRequests(base, '')
	const extract = tokens.countRequest(requests.extract).tokens
	const update =
		tokens.countRequest(requests.update).tokens + generation.reservedOutputTokens
	if (Math.max(extract, update) + generation.reservedOutputTokens > generation.loadedContextTokens)
		return { status: 'memory-capacity', reason: 'a two-step request exceeds the loaded context' }
	return { status: 'fits' }
}
