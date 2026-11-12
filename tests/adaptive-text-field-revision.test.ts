import { describe, expect, it } from 'vitest'

import { LearningRegistry } from '../src/learning/registry'
import {
	type FieldRevisionConfig,
	fieldGroupsOf,
	fieldRevisionRecipeRef,
	fitTextProcedureRequest,
	type PinnedProcedureRun,
	type ProcedurePorts,
	type ProseOutcome,
	type ProseRequest,
	cleanTextAnswer,
	confirmOrdinal,
	indicatedLevel,
	stepToward,
	parseFieldAnswer,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	type TextLearningConfig,
	validateTextLearningConfig,
} from '../src/learning/text-procedures'

const levels = ['not_observed', 'emerging', 'developing', 'established', 'integrated']

const fieldSettings: FieldRevisionConfig = {
	schema: {
		type: 'object',
		properties: {
			emotional_regulation: {
				type: 'object',
				description: 'How well the client manages intense emotions.',
				properties: {
					level: { type: 'string', enum: levels, description: 'Current level' },
					evidence: { type: 'string', description: 'The latest moment showing emotional regulation' },
				},
			},
			agency: {
				type: 'object',
				description: 'How much the client acts on their own behalf.',
				properties: {
					level: { type: 'string', enum: levels, description: 'Current level' },
					evidence: { type: 'string', description: 'The latest moment showing agency' },
				},
			},
			key_quotes: { type: 'array', items: { type: 'string' }, description: 'Notable client quotes' },
			in_crisis: { type: 'boolean', description: 'Whether the client is currently in crisis' },
		},
	},
	ordinalFields: ['emotional_regulation.level', 'agency.level'],
	maxOrdinalStep: 1,
	maxListItems: 3,
	maxChangeSummaryCharacters: 600,
	confirmations: 1,
}

function config(overrides: Partial<TextLearningConfig> = {}): TextLearningConfig {
	return {
		lens: {
			purpose: 'Track how this client\'s clinical capacities evolve across sessions.',
			developerInstructions: [],
			instructionPrecedence: ['developer', 'learned', 'incoming'],
			incomingTextRole: 'data-only',
		},
		model: { id: 'local-model', version: '1' },
		activeProcedure: fieldRevisionRecipeRef,
		allowedProcedures: [fieldRevisionRecipeRef],
		selection: {
			mode: 'fixed',
			selector: { id: 'selector', version: '1' },
			minCommittedRuns: 0,
			minElapsedMs: 0,
			maxCatalogueEntries: 4,
			autoActivatePreEvaluated: false,
		},
		batching: { maxItems: 4, maxInputCharacters: 4_000, maxInputTokens: 4_000, maxDelayMs: 0, acceptCallerUrgency: true },
		input: { maxItemCharacters: 2_000, maxRoutingSpanCharacters: 2_000 },
		memory: { maxCharacters: 8_000, maxNarrativeTokens: 8_000, splitPressureCharacters: 7_000, allowExplicitClear: false, standaloneCapacity: 'reject' },
		generation: { loadedContextTokens: 4_096, reservedOutputTokens: 512, maxNoteCharacters: 500, maxProviderCalls: 64, maxTokenClaims: 200_000, maxBudgetClaims: 200 },
		planning: { maxNodes: 2, maxCollectionItems: 4, maxOperations: 2 },
		retries: { maxLogicalAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, terminalAfterMs: 0 },
		history: { maxEntries: 10, maxCharacters: 2_000 },
		idempotence: { processedIdHorizonMs: 0, maxProcessedIds: 100 },
		fieldRevision: fieldSettings,
		...overrides,
	}
}

function run(memory: string, texts: readonly string[], configuration = config()): PinnedProcedureRun {
	return {
		runId: 'run-1',
		pins: {
			execution: { memory: 3, configuration: 7, registry: 'registry-1' },
			neuron: { id: 'n-1', incarnation: 'inc-1', ownershipRevision: 1 },
			procedure: configuration.activeProcedure,
			profile: { id: 'profile', version: '1' },
			model: { id: 'local-model', version: '1' },
			learnedStateRevision: 1,
		},
		configuration,
		memory: { text: memory, revision: 3 },
		inputs: texts.map((text, index) => ({ deliveryId: `d-${index + 1}`, text, observedAt: `2026-03-0${index + 1}T10:00:00Z` })),
		signal: new AbortController().signal,
	}
}

function complete(text: string): ProseOutcome {
	return { status: 'complete', text, completion: { finishReason: 'stop' } }
}

type Call = { kind: 'relevance' | 'select' | 'value' | 'indicator'; target: string; request: ProseRequest }

function kindOf(request: ProseRequest): Call {
	if (request.prompt.endsWith('Relevant? YES or NO:')) return { kind: 'relevance', target: '', request }
	const indicator = request.prompt.match(/\n\nQuestion: ([\s\S]*)\n\nYES or NO:$/)
	if (indicator) return { kind: 'indicator', target: indicator[1] as string, request }
	const select = request.prompt.match(/^Field: (\S+) — [\s\S]*YES or NO:$/)
	if (select) return { kind: 'select', target: select[1] as string, request }
	const value = request.prompt.match(/^Field: (\S+) — /)
	if (value && (request.prompt.endsWith('Value now:') || request.prompt.endsWith('Level this note shows:')))
		return { kind: 'value', target: value[1] as string, request }
	const capacity = request.prompt.match(/^Capacity: (\S+) — /)
	if (capacity && request.prompt.endsWith('BETTER, WORSE, or SAME:'))
		return { kind: 'value', target: `${capacity[1]}.level`, request }
	if (capacity && request.prompt.endsWith('Level this note shows:'))
		return { kind: 'value', target: `${capacity[1]}.level`, request }
	const describe = request.prompt.match(/^Describe: The latest moment showing (\S+)/)
	if (describe && request.prompt.endsWith('Statement:'))
		return { kind: 'value', target: describe[1] === 'emotional' ? 'emotional_regulation.evidence' : `${describe[1]}.evidence`, request }
	throw new Error(`unknown request: ${request.prompt}`)
}

function ports(answer: (call: Call) => ProseOutcome, seen: Call[]): ProcedurePorts {
	const registry = new LearningRegistry()
	registerAdaptiveTextProcedures(registry)
	return {
		registry,
		provider: {
			async generate(request) {
				const call = kindOf(request)
				seen.push(call)
				return answer(call)
			},
		},
		tokens: {
			countRequest: (request) => ({ tokens: request.system.length + request.prompt.length, conservativeUpperBound: true }),
			countText: (text) => ({ tokens: text.length, conservativeUpperBound: true }),
			countTextBound: (characters) => ({ tokens: characters, conservativeUpperBound: true }),
		},
		clock: { now: () => '2026-03-10T12:00:00Z' },
	}
}

describe('field revision procedure', () => {
	it('flattens grouped and top-level fields and validates its configuration', () => {
		const groups = fieldGroupsOf(fieldSettings)
		expect(groups.map((group) => group.name)).toEqual(['emotional_regulation', 'agency', 'key_quotes', 'in_crisis'])
		expect(groups[0]?.leaves.map((leaf) => [leaf.path, leaf.kind, leaf.ordinal])).toEqual([
			['emotional_regulation.level', 'enum', true],
			['emotional_regulation.evidence', 'string', false],
		])
		expect(() => validateTextLearningConfig(config())).not.toThrow()
		expect(() => validateTextLearningConfig(config({ fieldRevision: undefined }))).toThrow(/fieldRevision settings/)
		expect(() =>
			validateTextLearningConfig(config({ fieldRevision: { ...fieldSettings, ordinalFields: ['agency.evidence'] } })),
		).toThrow(/ordinal field/)
		expect(() =>
			fieldGroupsOf({ schema: { type: 'object', properties: { nested: { type: 'object', properties: { deep: { type: 'object', properties: {} } } } } }, ordinalFields: [] }),
		).toThrow()
	})

	it('updates only the fields of selected groups and records dated changes', async () => {
		const seen: Call[] = []
		const proposal = await runTextProcedure(
			run('', ['She asked for a night alone without apologising and booked the class herself.']),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				if (call.target === 'agency.level') return complete('emerging')
				return complete('Asked for time alone without apologising.')
			}, seen),
		)
		expect(seen.filter(({ kind }) => kind === 'value').map(({ target }) => target)).toEqual(['agency.level', 'agency.evidence'])
		expect(proposal.result).toMatchObject({ outcome: 'change' })
		const result = proposal.result as { patch: { text: string }; explanation: string }
		expect(JSON.parse(result.patch.text)).toEqual({
			agency: { level: 'emerging', evidence: 'Asked for time alone without apologising.' },
		})
		expect(result.explanation).toContain('agency.level (2026-03-01): null -> "emerging"')
	})

	it('moves an ordered rating at most one step per input and keeps unusable answers', async () => {
		const memory = JSON.stringify({ agency: { level: 'emerging', evidence: 'Old evidence.' } })
		const proposal = await runTextProcedure(
			run(memory, ['A big step forward.']),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				if (call.target === 'agency.level') return complete('BETTER')
				return complete('KEEP')
			}, []),
		)
		const result = proposal.result as { patch: { text: string } }
		expect(JSON.parse(result.patch.text)).toEqual({ agency: { level: 'developing', evidence: 'Old evidence.' } })
	})

	it('reports no change for irrelevant input and for invalid or keep answers', async () => {
		const seen: Call[] = []
		const irrelevant = await runTextProcedure(run('{}', ['We moved next week to Thursday.']), ports(() => complete('NO'), seen))
		expect(seen.map(({ kind }) => kind)).toEqual(['relevance'])
		expect(irrelevant.result).toMatchObject({ outcome: 'no_change', consumedInputIds: ['d-1'] })

		const invalid = await runTextProcedure(
			run(JSON.stringify({ agency: { level: 'emerging' } }), ['Something about agency.']),
			ports((call) => {
				if (call.kind === 'relevance' || call.kind === 'select') return complete('YES')
				if (call.target.endsWith('.level')) return complete('very high')
				if (call.target === 'in_crisis') return complete('maybe')
				return complete('KEEP')
			}, []),
		)
		expect(invalid.result).toMatchObject({ outcome: 'no_change' })
	})

	it('appends new list items without duplicates and parses booleans', () => {
		const leaf = fieldGroupsOf(fieldSettings).find((group) => group.name === 'key_quotes')?.leaves[0]
		const crisis = fieldGroupsOf(fieldSettings).find((group) => group.name === 'in_crisis')?.leaves[0]
		if (!leaf || !crisis) throw new Error('missing leaves')
		const limits = { maxOrdinalStep: 1, maxListItems: 3 }
		expect(parseFieldAnswer(leaf, '- "I am doing the thing again."', ['first'], limits)).toEqual({
			kind: 'set',
			value: ['first', '"I am doing the thing again."'],
		})
		expect(parseFieldAnswer(leaf, 'First', ['first'], limits)).toEqual({ kind: 'keep' })
		expect(parseFieldAnswer(leaf, 'd', ['a', 'b', 'c'], limits)).toEqual({ kind: 'set', value: ['b', 'c', 'd'] })
		expect(parseFieldAnswer(crisis, 'false.', true, limits)).toEqual({ kind: 'set', value: false })
	})

	it('fails without changes when the stored memory is not a JSON object', async () => {
		const proposal = await runTextProcedure(run('plain narrative text', ['Note.']), ports(() => complete('YES'), []))
		expect(proposal.result).toMatchObject({ outcome: 'failure', code: 'structured_memory_invalid', retryable: false })
	})

	it('sizes capacity by the largest single field request', () => {
		const tokens = {
			countRequest: (request: ProseRequest) => ({ tokens: request.system.length + request.prompt.length, conservativeUpperBound: true }),
			countText: (text: string) => ({ tokens: text.length, conservativeUpperBound: true }),
			countTextBound: (characters: number) => ({ tokens: characters, conservativeUpperBound: true }),
		}
		const input = [{ deliveryId: 'd', text: 'Note.', observedAt: 'x' }]
		expect(fitTextProcedureRequest({ configuration: config(), memory: { text: '{}', revision: 1 }, inputs: input }, tokens)).toEqual({ status: 'fits' })
		expect(fitTextProcedureRequest({ configuration: config(), memory: { text: 'not json', revision: 1 }, inputs: input }, tokens)).toMatchObject({ status: 'memory-capacity' })
	})

	it('compares an existing rating with the moment instead of asking for an absolute level', async () => {
		const seen: Call[] = []
		const memory = JSON.stringify({ agency: { level: 'emerging', evidence: 'Old evidence.' } })
		await runTextProcedure(
			run(memory, ['Unrelated detail.']),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				return complete(call.target === 'agency.level' ? 'SAME' : 'KEEP')
			}, seen),
		)
		const level = seen.find((call) => call.target === 'agency.level')
		expect(level?.request.prompt).toContain('Current level: emerging')
		expect(level?.request.prompt.endsWith('BETTER, WORSE, or SAME:')).toBe(true)
		const evidence = seen.find((call) => call.target === 'agency.evidence')
		expect(evidence?.request.prompt).not.toContain('Old evidence.')
		expect(evidence?.request.prompt).toContain('For: agency — How much the client acts on their own behalf.')
	})

	it('rejects echoed prompts, placeholders, and trailing keep signals in text answers', () => {
		const leaf = { path: 'agency.evidence' }
		expect(cleanTextAnswer('agency.evidence — Recent moment Current value: (not set) Session 4. ... Value now: KEEP', leaf)).toBe('')
		expect(cleanTextAnswer('**set**', leaf)).toBe('')
		expect(cleanTextAnswer('agency.evidence — (still not set)', leaf)).toBe('')
		expect(cleanTextAnswer('Booked the class herself. **KEEP**', leaf)).toBe('')
		expect(cleanTextAnswer('agency.evidence — Asked for a night alone without apologising.', leaf)).toBe(
			'Asked for a night alone without apologising.',
		)
		expect(cleanTextAnswer('Value now: **Asked for a night alone.**', leaf)).toBe('Asked for a night alone.')
	})

	it('moves ratings one step on BETTER or WORSE, never below the lowest option, and keeps on SAME', () => {
		const leaf = fieldGroupsOf(fieldSettings).find((group) => group.name === 'agency')?.leaves[0]
		if (!leaf) throw new Error('missing leaf')
		const limits = { maxOrdinalStep: 1, maxListItems: 3 }
		expect(parseFieldAnswer(leaf, 'BETTER.', 'developing', limits)).toEqual({ kind: 'set', value: 'established' })
		expect(parseFieldAnswer(leaf, 'Worse', 'developing', limits)).toEqual({ kind: 'set', value: 'emerging' })
		expect(parseFieldAnswer(leaf, 'WORSE', 'not_observed', limits)).toEqual({ kind: 'keep' })
		expect(parseFieldAnswer(leaf, 'SAME', 'developing', limits)).toEqual({ kind: 'keep' })
		expect(parseFieldAnswer(leaf, 'emerging', undefined, limits)).toEqual({ kind: 'set', value: 'emerging' })
	})

	it('skips a field whose answer hits the output limit instead of failing the batch', async () => {
		const proposal = await runTextProcedure(
			run('', ['She asked for a night alone.']),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				if (call.target === 'agency.level') return complete('emerging')
				return { status: 'failure', code: 'finish_length', retryable: false }
			}, []),
		)
		expect(proposal.result).toMatchObject({ outcome: 'change' })
		expect(JSON.parse((proposal.result as { patch: { text: string } }).patch.text)).toEqual({ agency: { level: 'emerging' } })
	})

	it('derives an ordered rating from indicator questions and moves one step toward it', async () => {
		const seen: Call[] = []
		const configuration = config({
			fieldRevision: {
				...fieldSettings,
				indicators: {
					'agency.level': {
						emerging: 'Does the note show her making a small choice?',
						developing: 'Does the note show her asking for what she needs?',
						established: 'Does the note show her setting a clear boundary?',
					},
				},
			},
		})
		const proposal = await runTextProcedure(
			run(JSON.stringify({ agency: { level: 'emerging' } }), ['She set a clear boundary with her manager.'], configuration),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				if (call.kind === 'indicator') return complete(call.target.includes('boundary') || call.target.includes('small') ? 'YES' : 'NO')
				return complete('KEEP')
			}, seen),
		)
		expect(seen.filter((call) => call.kind === 'value').map((call) => call.target)).toEqual(['agency.evidence'])
		expect(seen.filter((call) => call.kind === 'indicator')).toHaveLength(3)
		expect(seen.filter((call) => call.kind === 'indicator').every((call) => call.request.prompt.startsWith('Capacity: agency — '))).toBe(true)
		expect(JSON.parse((proposal.result as { patch: { text: string } }).patch.text)).toEqual({ agency: { level: 'developing' } })
		expect(() =>
			validateTextLearningConfig(config({ fieldRevision: { ...fieldSettings, indicators: { 'agency.evidence': { emerging: 'x' } } } })),
		).toThrow(/ordinal field/)
	})

	it('picks the highest indicated level and steps toward it from any side', () => {
		const leaf = fieldGroupsOf(fieldSettings).find((group) => group.name === 'agency')?.leaves[0]
		if (!leaf) throw new Error('missing leaf')
		expect(indicatedLevel(leaf, new Set(['emerging', 'established']))).toBe('established')
		expect(indicatedLevel(leaf, new Set())).toBeUndefined()
		expect(stepToward(leaf, undefined, 'established', 1)).toBe('emerging')
		expect(stepToward(leaf, 'established', 'emerging', 1)).toBe('developing')
		expect(stepToward(leaf, 'developing', 'developing', 1)).toBe('developing')
	})

	it('moves a rating only after enough distinct sessions point the same way', () => {
		const leaf = fieldGroupsOf(fieldSettings).find((group) => group.name === 'agency')?.leaves[0]
		if (!leaf) throw new Error('missing leaf')
		const limits = { confirmations: 2, maxOrdinalStep: 1 }
		const first = confirmOrdinal(leaf, 'developing', 'established', 'session-1', undefined, limits)
		expect(first).toEqual({ next: 'developing', pending: { direction: 1, count: 1, lastEvent: 'session-1' } })
		const sameSession = confirmOrdinal(leaf, 'developing', 'established', 'session-1', first.pending, limits)
		expect(sameSession.next).toBe('developing')
		const second = confirmOrdinal(leaf, 'developing', 'integrated', 'session-2', first.pending, limits)
		expect(second).toEqual({ next: 'established', pending: undefined })
		const reversed = confirmOrdinal(leaf, 'developing', 'emerging', 'session-2', first.pending, limits)
		expect(reversed).toEqual({ next: 'developing', pending: { direction: -1, count: 1, lastEvent: 'session-2' } })
		expect(confirmOrdinal(leaf, 'developing', 'developing', 'session-3', first.pending, limits)).toEqual({ next: 'developing', pending: first.pending })
		expect(confirmOrdinal(leaf, undefined, 'established', 'session-1', undefined, limits).next).toBe('emerging')
	})

	it('keeps waiting counts under the reserved key and skips evidence when no level was shown', async () => {
		const seen: Call[] = []
		const configuration = config({
			fieldRevision: {
				...fieldSettings,
				confirmations: 2,
				indicators: { 'agency.level': { developing: 'Does the note show her asking for what she needs?' } },
			},
		})
		const first = await runTextProcedure(
			run(JSON.stringify({ agency: { level: 'emerging' } }), ['She asked for what she needs.'], configuration),
			ports((call) => {
				if (call.kind === 'relevance') return complete('YES')
				if (call.kind === 'select') return complete(call.target === 'agency' ? 'YES' : 'NO')
				if (call.kind === 'indicator') return complete('YES')
				return complete('Asked for what she needs.')
			}, seen),
		)
		const stored = JSON.parse((first.result as { patch: { text: string } }).patch.text)
		expect(stored.agency.level).toBe('emerging')
		expect(stored._pending['agency.level']).toMatchObject({ direction: 1, count: 1 })
		expect(() =>
			validateTextLearningConfig(config({ fieldRevision: { ...fieldSettings, schema: { type: 'object', properties: { _pending: { type: 'string' } } } } })),
		).toThrow(/reserved/)

		const skipped: Call[] = []
		await runTextProcedure(
			run(JSON.stringify({ agency: { level: 'emerging' } }), ['Unrelated.'], configuration),
			ports((call) => {
				if (call.kind === 'relevance' || call.kind === 'select') return complete('YES')
				return complete('NO')
			}, skipped),
		)
		expect(skipped.some((call) => call.target === 'agency.evidence')).toBe(false)
	})
})
