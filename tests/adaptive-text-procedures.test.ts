import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { AdaptLLMPlugin, AdaptModelTurnResult } from '../src/llm'
import { createBoundedDeviceScheduler } from '../src/llm/local/scheduler'
import { LearningRegistry } from '../src/learning/registry'
import {
	createAdaptTextProcedureProvider,
	createConservativeByteTokenCounter,
	fitTextProcedureRequest,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	selectTextProcedure,
	textProcedureRecipeRefs,
	textProcedureVersion1DirectRecipeRef,
	textProcedureVersion1WriteOperationRef,
	type PinnedProcedureRun,
	type ProcedurePorts,
	type ProseOutcome,
	type ProseRequest,
	type TextLearningConfig,
} from '../src/learning/text-procedures'

function config(procedure = textProcedureRecipeRefs.direct): TextLearningConfig {
	return {
		lens: {
			purpose: 'Remember durable engineering preferences.',
			developerInstructions: ['Keep uncertainty explicit.'],
			instructionPrecedence: ['Developer instructions', 'learned narrative', 'incoming data'],
			incomingTextRole: 'data-only',
		},
		model: { id: 'local-model', version: '1' },
		activeProcedure: procedure,
		allowedProcedures: [
			textProcedureVersion1DirectRecipeRef,
			...Object.values(textProcedureRecipeRefs),
		],
		selection: {
			mode: 'periodic', selector: { id: 'selector', version: '1' },
			minCommittedRuns: 0, minElapsedMs: 0, maxCatalogueEntries: 4,
			autoActivatePreEvaluated: false,
		},
		batching: {
			maxItems: 4, maxInputCharacters: 4_000, maxInputTokens: 4_000,
			maxDelayMs: 0, acceptCallerUrgency: true,
		},
		input: { maxItemCharacters: 2_000, maxRoutingSpanCharacters: 2_000 },
		memory: {
			maxCharacters: 4_000, maxNarrativeTokens: 800,
			splitPressureCharacters: 3_500, allowExplicitClear: true,
			standaloneCapacity: 'reject',
		},
		generation: {
			loadedContextTokens: 8_000, reservedOutputTokens: 800,
			maxNoteCharacters: 500, maxProviderCalls: 3,
			maxTokenClaims: 20_000, maxBudgetClaims: 20,
		},
		planning: { maxNodes: 4, maxCollectionItems: 4, maxOperations: 4 },
		retries: { maxLogicalAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, terminalAfterMs: 0 },
		history: { maxEntries: 10, maxCharacters: 2_000 },
		idempotence: { processedIdHorizonMs: 0, maxProcessedIds: 100 },
	}
}

function pinnedRun(procedure = textProcedureRecipeRefs.direct): PinnedProcedureRun {
	return {
		runId: 'run-1',
		pins: {
			execution: { memory: 3, configuration: 7, registry: 'registry-1' },
			neuron: { id: 'n-1', incarnation: 'inc-1', ownershipRevision: 2 },
			procedure, profile: { id: 'profile', version: '1' },
			model: { id: 'local-model', version: '1' }, learnedStateRevision: 9,
		},
		configuration: config(procedure),
		memory: { text: 'Existing fact.', revision: 3 },
		inputs: [
			{ deliveryId: 'd-1', eventId: 'e-1', text: 'Original first input.', observedAt: '2026-10-10T10:00:00Z' },
			{ deliveryId: 'd-2', text: 'Original second input.', observedAt: '2026-10-10T10:01:00Z' },
		],
		signal: new AbortController().signal,
	}
}

function complete(text: string): ProseOutcome {
	return { status: 'complete', text, completion: { finishReason: 'stop' } }
}

function ports(outputs: readonly ProseOutcome[], requests: ProseRequest[]): ProcedurePorts {
	const registry = new LearningRegistry()
	registerAdaptiveTextProcedures(registry)
	let index = 0
	return {
		registry,
		provider: {
			async generate(request) {
				requests.push(request)
				const output = outputs[index]
				index += 1
				if (output === undefined) throw new Error('missing queued outcome')
				return output
			},
		},
		tokens: {
			countRequest: () => ({ tokens: 50, conservativeUpperBound: true }),
			countText: (text) => ({ tokens: text.length, conservativeUpperBound: true }),
			countTextBound: (characters) => ({ tokens: characters, conservativeUpperBound: true }),
		},
		clock: { now: () => '2026-10-10T12:00:00Z' },
	}
}

describe('adaptive text procedures', () => {
	it('registers the restored version 1 direct recipe beside four immutable version 2 recipes', () => {
		const registry = new LearningRegistry()
		registerAdaptiveTextProcedures(registry)
		const recipes = Object.values(textProcedureRecipeRefs).map((ref) => registry.getRecipe(ref))
		expect(recipes).toHaveLength(4)
		expect(Object.values(textProcedureRecipeRefs).every((ref) => ref.version === '2')).toBe(true)
		expect(recipes.flatMap((recipe) => recipe?.nodes ?? []).every((node) => node.operation.version === '2')).toBe(true)
		expect(recipes.every((recipe) => recipe?.nodes.at(-1)?.operation.id.endsWith('narrative.write'))).toBe(true)
		expect(
			registry.getRecipe(textProcedureVersion1DirectRecipeRef)?.nodes,
		).toEqual([
			expect.objectContaining({ operation: textProcedureVersion1WriteOperationRef }),
		])
		expect(() => registerAdaptiveTextProcedures(registry)).toThrow('immutable')
	})

	it('reproduces all four preserved version 1 writer request byte strings', async () => {
		type WriterCase = {
			readonly id: string
			readonly kind: string
			readonly lens: TextLearningConfig['lens']
			readonly memory: { readonly text: string; readonly revision: number }
			readonly inputs: PinnedProcedureRun['inputs']
		}
		type RequestFixture = {
			readonly id: string
			readonly sourceSha256: string
			readonly requestSha256: string
			readonly system: string
			readonly prompt: string
		}
		const dataset = JSON.parse(
			readFileSync(
				'evals/datasets/adaptive-text-learning/module-cases.json',
				'utf8',
			),
		) as { readonly cases: readonly WriterCase[] }
		const fixture = JSON.parse(
			readFileSync(
				'tests/fixtures/adaptive-text-version1-writer-requests.json',
				'utf8',
			),
		) as { readonly cases: readonly RequestFixture[] }

		for (const expected of fixture.cases) {
			const testCase = dataset.cases.find(({ id }) => id === expected.id)
			expect(expected.sourceSha256).toHaveLength(64)
			expect(testCase?.kind).toBe('writer')
			if (testCase === undefined) throw new Error(`missing case ${expected.id}`)
			const captured: ProseRequest[] = []
			const base = pinnedRun(textProcedureVersion1DirectRecipeRef)
			await runTextProcedure(
				{
					...base,
					pins: {
						...base.pins,
						execution: {
							...base.pins.execution,
							memory: testCase.memory.revision,
						},
						procedure: textProcedureVersion1DirectRecipeRef,
					},
					configuration: {
						...config(textProcedureVersion1DirectRecipeRef),
						lens: testCase.lens,
						generation: {
							...config(textProcedureVersion1DirectRecipeRef).generation,
							loadedContextTokens: 16_384,
							reservedOutputTokens: 4_096,
						},
						memory: {
							...config(textProcedureVersion1DirectRecipeRef).memory,
							maxNarrativeTokens: 4_096,
						},
					},
					memory: testCase.memory,
					inputs: testCase.inputs,
				},
				ports([complete(testCase.memory.text)], captured),
			)
			expect(captured).toHaveLength(1)
			const actual = captured[0]
			if (actual === undefined) throw new Error('writer request was not captured')
			expect(actual.system).toBe(expected.system)
			expect(actual.prompt).toBe(expected.prompt)
			expect(
				createHash('sha256')
					.update(
						JSON.stringify({ system: actual.system, prompt: actual.prompt }),
					)
					.digest('hex'),
			).toBe(expected.requestSha256)
			expect(actual.loadedContextTokens).toBe(16_384)
			expect(actual.reservedOutputTokens).toBe(4_096)
		}
	})

	it('runs direct revision through planner/executor with every original input', async () => {
		const requests: ProseRequest[] = []
		const proposal = await runTextProcedure(
			pinnedRun(),
			ports([complete('Existing fact. New durable fact.')], requests),
		)
		expect(proposal.result).toMatchObject({
			outcome: 'change',
			patch: { type: 'replace', text: 'Existing fact. New durable fact.' },
			expectedMemoryRevision: 3,
			expectedConfigurationRevision: 7,
			consumedInputIds: ['d-1', 'd-2'],
		})
		expect(requests).toHaveLength(1)
		expect(requests[0]?.prompt).toContain('Original first input.')
		expect(requests[0]?.prompt).toContain('Original second input.')
		expect(requests[0]?.prompt).toContain('currentNarrativeBeforeRun')
		expect(requests[0]?.prompt).toContain('selectedSourceInputs')
		expect(requests[0]?.prompt).toContain('ingestedAt')
		expect(requests[0]?.prompt).toContain('ADAPT_NO_CHANGE')
		expect(requests[0]?.system).toContain('does not rank factual evidence or factual currentness')
		expect(requests[0]?.system).toContain('stored verbatim')
	})

	it('keeps compare and pattern independent and gives both notes plus originals to the writer', async () => {
		const requests: ProseRequest[] = []
		const proposal = await runTextProcedure(
			pinnedRun(textProcedureRecipeRefs.comparePattern),
			ports([
				complete('comparison note'),
				complete('pattern note'),
				complete('Revised complete narrative.'),
			], requests),
		)
		expect(proposal.result.outcome).toBe('change')
		expect(requests).toHaveLength(3)
		expect(requests[1]?.prompt).not.toContain('comparison note')
		expect(requests[2]?.prompt).toContain('comparison note')
		expect(requests[2]?.prompt).toContain('pattern note')
		expect(requests[2]?.prompt).toContain('Original first input.')
		expect(requests[2]?.prompt).toContain('nonAuthoritativeNotes')
	})

	it('preserves a note failure instead of disguising it as a defer', async () => {
		const proposal = await runTextProcedure(
			pinnedRun(textProcedureRecipeRefs.compare),
			ports([{ status: 'failure', code: 'bad_note', retryable: false }], []),
		)
		expect(proposal.result).toMatchObject({ outcome: 'failure', code: 'bad_note', retryable: false })
	})

	it('pins caller-owned inputs and revisions before the provider awaits', async () => {
		const run = pinnedRun()
		let release: (() => void) | undefined
		const waiting = new Promise<void>((accept) => { release = accept })
		let observedPrompt = ''
		const dependencies = ports([complete('Pinned narrative.')], [])
		dependencies.provider.generate = async (request) => {
			observedPrompt = request.prompt
			await waiting
			return complete('Pinned narrative.')
		}
		const promise = runTextProcedure(run, dependencies)
		await Promise.resolve()
		;(run.inputs[0] as { text: string }).text = 'mutated after dispatch'
		;(run.pins.execution as { memory: number }).memory = 99
		release?.()
		const proposal = await promise
		expect(observedPrompt).toContain('Original first input.')
		expect(observedPrompt).not.toContain('mutated after dispatch')
		expect(proposal.pins.execution.memory).toBe(3)
	})

	it('stops a rich recipe when its single provider-call budget is exhausted', async () => {
		const run = pinnedRun(textProcedureRecipeRefs.comparePattern)
		const requests: ProseRequest[] = []
		const proposal = await runTextProcedure({
			...run,
			configuration: {
				...run.configuration,
				generation: { ...run.configuration.generation, maxProviderCalls: 1 },
			},
		}, ports([complete('comparison note')], requests))
		expect(requests).toHaveLength(1)
		expect(proposal.result).toMatchObject({
			outcome: 'failure', code: 'provider_budget_exhausted', retryable: true,
		})
	})

	it('preflights full request capacity without clipping ordinary input', () => {
		const value = pinnedRun(textProcedureRecipeRefs.comparePattern)
		const result = fitTextProcedureRequest(
			{ configuration: { ...value.configuration, generation: { ...value.configuration.generation, loadedContextTokens: 900 } }, memory: value.memory, inputs: value.inputs },
			createConservativeByteTokenCounter({ requestTemplateOverheadTokens: 20, textTemplateOverheadTokens: 0 }),
		)
		expect(result).toEqual({ status: 'memory-capacity', reason: 'a complete procedure request exceeds the loaded context' })
	})

	it('preflights the restored version 1 request through its exact builder', () => {
		const value = pinnedRun(textProcedureVersion1DirectRecipeRef)
		const counted: ProseRequest[] = []
		const result = fitTextProcedureRequest(
			{
				configuration: value.configuration,
				memory: value.memory,
				inputs: value.inputs,
			},
			{
				countRequest(request) {
					counted.push(request)
					return { tokens: 50, conservativeUpperBound: true }
				},
				countText: (text) => ({
					tokens: text.length,
					conservativeUpperBound: true,
				}),
				countTextBound: (characters) => ({
					tokens: characters,
					conservativeUpperBound: true,
				}),
			},
		)
		expect(result).toEqual({ status: 'fits' })
		expect(counted).toHaveLength(1)
		expect(counted[0]?.prompt).toContain('"currentNarrative"')
		expect(counted[0]?.prompt).toContain('"originalInputs"')
		expect(counted[0]?.prompt).not.toContain('currentNarrativeBeforeRun')
	})

	it('maps a stopped exact no-change token through the production adapter and selector', async () => {
		let selectorSystem = ''
		let selectorPrompt = ''
		const plugin: AdaptLLMPlugin = {
			id: 'ai-sdk',
			model: { toConfig: () => ({ plugin: 'ai-sdk', provider: 'local', id: 'test' }) },
			async call(input): Promise<AdaptModelTurnResult> {
				selectorSystem = input.system ?? ''
				selectorPrompt = input.messages
					.flatMap(({ content }) => content)
					.filter((content) => content.type === 'text')
					.map(({ text }) => text)
					.join('\n')
				return {
					text: 'ADAPT_NO_CHANGE', finishReason: 'stop', toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: { response: 'raw' },
				}
			},
		}
		const provider = createAdaptTextProcedureProvider({
			llm: plugin, model: { plugin: 'ai-sdk', provider: 'local', id: 'test' },
			settings: { maxOutputTokens: 8, maxRetries: 0 },
			scheduler: createBoundedDeviceScheduler({ maxConcurrent: 1, maxQueued: 1 }),
			priority: 'background',
		})
		const result = await selectTextProcedure({
			review: { id: 'review-1', trigger: 'periodic', contextDigest: 'context', evidenceRefs: [] },
			lens: config().lens,
			state: {
				neuron: { id: 'n-1', incarnation: 'inc-1', ownershipRevision: 1 },
				learnedStateRevision: 1, procedure: textProcedureRecipeRefs.direct,
				profile: { id: 'profile', version: '1' }, profileRevision: 1,
				model: { id: 'local-model', version: '1' },
				allowedCatalogueDigest: 'catalogue', referencedDefinitionDigest: 'definition',
			},
			currentNarrative: 'Existing fact.', learnedChanges: [], pending: [], feedback: [],
			metrics: { committedRuns: 3, deferredRuns: 0, failedRuns: 0, meanBatchItems: 1, elapsedSinceSelectionMs: 1_000 },
			allowed: [{ procedure: textProcedureRecipeRefs.direct, expectedEffect: 'direct rewrite', token: 'DIRECT' }],
			limits: { loadedContextTokens: 100, reservedOutputTokens: 8, maxContextCharacters: 10_000, maxCatalogueEntries: 4 },
			signal: new AbortController().signal,
		}, {
			provider,
			tokens: {
				countRequest: () => ({ tokens: 10, conservativeUpperBound: true }),
				countText: () => ({ tokens: 1, conservativeUpperBound: true }),
				countTextBound: (characters) => ({ tokens: characters, conservativeUpperBound: true }),
			},
		})
		expect(result).toEqual({ status: 'no_change', reason: 'selector_no_change' })
		expect(selectorPrompt).toContain('"currentToken": "DIRECT"')
		expect(selectorPrompt).toContain('currentNarrativeBeforeSelection')
		expect(selectorSystem).toContain('Do not write or revise the memory')
		expect(selectorSystem).toContain('ADAPT_NO_CHANGE when currentToken remains the best choice')
	})

	it('rejects selector state whose current procedure has no catalogue token', async () => {
		const result = await selectTextProcedure({
			review: { id: 'review-1', trigger: 'periodic', contextDigest: 'context', evidenceRefs: [] },
			lens: config().lens,
			state: {
				neuron: { id: 'n-1', incarnation: 'inc-1', ownershipRevision: 1 },
				learnedStateRevision: 1,
				procedure: { id: 'missing', version: '1' },
				profile: { id: 'profile', version: '2' }, profileRevision: 2,
				model: { id: 'local-model', version: '1' },
				allowedCatalogueDigest: 'catalogue', referencedDefinitionDigest: 'definition',
			},
			currentNarrative: 'Existing fact.', learnedChanges: [], pending: [], feedback: [],
			metrics: { committedRuns: 3, deferredRuns: 0, failedRuns: 0, meanBatchItems: 1 },
			allowed: [{ procedure: textProcedureRecipeRefs.direct, expectedEffect: 'direct rewrite', token: 'DIRECT' }],
			limits: { loadedContextTokens: 100, reservedOutputTokens: 8, maxContextCharacters: 10_000, maxCatalogueEntries: 4 },
			signal: new AbortController().signal,
		}, {
			provider: { async generate() { throw new Error('must not call provider') } },
			tokens: {
				countRequest: () => ({ tokens: 1, conservativeUpperBound: true }),
				countText: () => ({ tokens: 1, conservativeUpperBound: true }),
				countTextBound: (characters) => ({ tokens: characters, conservativeUpperBound: true }),
			},
		})
		expect(result).toEqual({
			status: 'failure', code: 'current_procedure_not_in_catalogue', retryable: false,
		})
	})

	it('rejects an output reserve that cannot hold the configured narrative', async () => {
		const run = pinnedRun()
		await expect(runTextProcedure({
			...run,
			configuration: {
				...run.configuration,
				generation: { ...run.configuration.generation, reservedOutputTokens: 100 },
			},
		}, ports([complete('unused')], []))).rejects.toThrow('maxNarrativeTokens')
	})
})
