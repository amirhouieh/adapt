import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TextNeuron, type AdaptiveTextLearningRuntime, type AdaptLLMPlugin } from '../src'
import { LearningRegistry } from '../src/learning/registry'
import {
	fitTextProcedureRequest,
	registerAdaptiveTextProcedures,
	runTextProcedure,
	twoStepRecipeRef,
	validateTextLearningConfig,
	type PinnedProcedureRun,
	type ProcedurePorts,
	type ProseOutcome,
	type ProseRequest,
	type TextLearningConfig,
} from '../src/learning/text-procedures'
import type { TextProfileSnapshot } from '../src/learning/text-state'
import { SQLiteNeuronStore } from '../src/sqlite'

const purpose = 'Remember durable communication preferences.'
const at = '2026-10-10T16:00:00.000Z'
const later = '2026-10-10T16:01:00.000Z'
const modelRef = { id: 'local-model', version: '1' }
const directories: string[] = []

function config(overrides: Partial<TextLearningConfig> = {}): TextLearningConfig {
	return {
		lens: {
			purpose,
			developerInstructions: [],
			instructionPrecedence: ['developer', 'incoming'],
			incomingTextRole: 'data-only',
		},
		model: modelRef,
		activeProcedure: twoStepRecipeRef,
		allowedProcedures: [twoStepRecipeRef],
		selection: {
			mode: 'fixed',
			selector: { id: 'selector', version: '1' },
			minCommittedRuns: 0,
			minElapsedMs: 0,
			maxCatalogueEntries: 4,
			autoActivatePreEvaluated: false,
		},
		batching: {
			maxItems: 8,
			maxInputCharacters: 8_000,
			maxInputTokens: 8_000,
			maxDelayMs: 1_000,
			acceptCallerUrgency: true,
		},
		input: { maxItemCharacters: 2_000, maxRoutingSpanCharacters: 2_000 },
		memory: {
			maxCharacters: 40_000,
			maxNarrativeTokens: 8_000,
			splitPressureCharacters: 30_000,
			allowExplicitClear: false,
			standaloneCapacity: 'reject',
		},
		generation: {
			loadedContextTokens: 64_000,
			reservedOutputTokens: 8_000,
			maxNoteCharacters: 500,
			maxProviderCalls: 2,
			maxTokenClaims: 200_000,
			maxBudgetClaims: 8,
		},
		planning: { maxNodes: 2, maxCollectionItems: 8, maxOperations: 2 },
		retries: { maxLogicalAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 4_000, terminalAfterMs: 600_000 },
		history: { maxEntries: 20, maxCharacters: 4_000 },
		idempotence: { processedIdHorizonMs: 60_000, maxProcessedIds: 100 },
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
			model: modelRef,
			learnedStateRevision: 1,
		},
		configuration,
		memory: { text: memory, revision: 3 },
		inputs: texts.map((text, index) => ({
			deliveryId: `d-${index + 1}`,
			text,
			observedAt: `2026-10-10T10:0${index}:00Z`,
		})),
		signal: new AbortController().signal,
	}
}

function complete(text: string): ProseOutcome {
	return { status: 'complete', text, completion: { finishReason: 'stop' } }
}

const cutOff: ProseOutcome = { status: 'failure', code: 'finish_length', retryable: false }

const tokens = {
	countRequest: (request: ProseRequest) => ({
		tokens: request.system.length + request.prompt.length,
		conservativeUpperBound: true,
	}),
	countText: (text: string) => ({ tokens: text.length, conservativeUpperBound: true }),
	countTextBound: (characters: number) => ({ tokens: characters, conservativeUpperBound: true }),
}

function ports(outputs: ProseOutcome[], seen: ProseRequest[]): ProcedurePorts {
	const registry = new LearningRegistry()
	registerAdaptiveTextProcedures(registry)
	return {
		registry,
		provider: {
			async generate(request) {
				seen.push(request)
				const output = outputs.shift()
				if (output === undefined) throw new Error('unexpected model call')
				return output
			},
		},
		tokens,
		clock: { now: () => '2026-10-10T12:00:00Z' },
	}
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('two-step procedure', () => {
	it('registers and validates as a whole-rewrite procedure with no extra settings', () => {
		const registry = new LearningRegistry()
		registerAdaptiveTextProcedures(registry)
		expect(registry.getRecipe(twoStepRecipeRef)).toBeDefined()
		expect(() => validateTextLearningConfig(config())).not.toThrow()
		expect(() =>
			validateTextLearningConfig(
				config({ memory: { ...config().memory, maxNarrativeTokens: 9_000 } }),
			),
		).toThrow(/maxNarrativeTokens/)
	})

	it('extracts from the batch, then updates the understanding, with the eval prompts', async () => {
		const seen: ProseRequest[] = []
		const proposal = await runTextProcedure(
			run('Routine updates go by email.', ['Prefers Slack for urgent things.', 'The weather was nice.']),
			ports([
				complete('  Urgent matters: Slack.  '),
				complete('\nRoutine updates go by email; urgent matters go to Slack.\n'),
			], seen),
		)
		expect(seen).toHaveLength(2)
		expect(seen[0]).toMatchObject({
			system: `Here is some data. Our job is to extract whatever valuable and relevant pieces of information it has related to this topic:\n${purpose}\n\nReply with the extracted information only, in plain text. If nothing in the data is relevant, reply with exactly: NONE`,
			prompt: 'Data:\nPrefers Slack for urgent things.\n\nThe weather was nice.',
			response: { kind: 'prose', controls: [] },
		})
		expect(seen[1]).toMatchObject({
			system: `Here is information extracted about this topic:\n${purpose}\n\nand here is our existing understanding of it. Update the understanding accordingly.\nReply with the updated understanding only, in plain text.`,
			prompt: 'Existing understanding:\nRoutine updates go by email.\n\nExtracted information:\nUrgent matters: Slack.',
		})
		expect(proposal.result).toMatchObject({
			outcome: 'change',
			patch: { type: 'replace', text: 'Routine updates go by email; urgent matters go to Slack.' },
			expectedMemoryRevision: 3,
			consumedInputIds: ['d-1', 'd-2'],
		})
	})

	it('writes the first understanding from an empty memory', async () => {
		const seen: ProseRequest[] = []
		await runTextProcedure(
			run('', ['Prefers Slack.']),
			ports([complete('Slack.'), complete('Prefers Slack.')], seen),
		)
		expect(seen[1]?.prompt).toBe('Existing understanding:\n(none yet)\n\nExtracted information:\nSlack.')
	})

	it('consumes the batch without an update when nothing is relevant', async () => {
		const seen: ProseRequest[] = []
		const proposal = await runTextProcedure(
			run('Routine updates go by email.', ['The weather was nice.']),
			ports([complete(' NONE ')], seen),
		)
		expect(seen).toHaveLength(1)
		expect(proposal.result).toEqual({
			outcome: 'no_change',
			reason: 'two_step_nothing_relevant',
			consumedInputIds: ['d-1'],
		})
	})

	it('keeps the batch pending when the update is cut off', async () => {
		const proposal = await runTextProcedure(
			run('Routine updates go by email.', ['Prefers Slack.', 'Calls only on Fridays.']),
			ports([complete('Slack; Friday calls.'), cutOff], []),
		)
		expect(proposal.result).toEqual({
			outcome: 'defer',
			reason: 'two_step_update_cut_off',
			pendingInputIds: ['d-1', 'd-2'],
		})
	})

	it('keeps the batch pending when the extract is cut off', async () => {
		const seen: ProseRequest[] = []
		const proposal = await runTextProcedure(
			run('', ['Prefers Slack.']),
			ports([cutOff], seen),
		)
		expect(seen).toHaveLength(1)
		expect(proposal.result).toMatchObject({ outcome: 'defer', reason: 'two_step_extract_cut_off' })
	})

	it('keeps the provider retry classification for other failures', async () => {
		const proposal = await runTextProcedure(
			run('', ['Prefers Slack.']),
			ports([{ status: 'failure', code: 'provider_error', retryable: true }], []),
		)
		expect(proposal.result).toMatchObject({ outcome: 'failure', code: 'provider_error', retryable: true })
	})

	it('never rejects a batch for memory size', async () => {
		const memory = 'A durable preference sentence. '.repeat(1_000).trim()
		const small = config({ memory: { ...config().memory, maxCharacters: 1_000 } })
		const proposal = await runTextProcedure(
			run(memory, ['Prefers Slack.'], small),
			ports([complete('Slack.'), complete(`${memory} Prefers Slack.`)], []),
		)
		expect(proposal.result).toMatchObject({ outcome: 'change' })
		expect(
			fitTextProcedureRequest({ configuration: small, memory: { text: memory, revision: 1 }, inputs: run('', ['x']).inputs }, tokens),
		).toEqual({ status: 'fits' })
	})

	it('reports capacity only when a request cannot fit the loaded context', () => {
		const tight = config({ generation: { ...config().generation, loadedContextTokens: 17_000 } })
		const memory = { text: 'x'.repeat(2_000), revision: 1 }
		expect(fitTextProcedureRequest({ configuration: tight, memory, inputs: run('', ['x']).inputs }, tokens)).toEqual({
			status: 'memory-capacity',
			reason: 'a two-step request exceeds the loaded context',
		})
	})
})

describe('two-step in the adaptive TextNeuron pipeline', () => {
	class Clock {
		value = at
		now(): string { return this.value }
	}

	class Ids {
		#index = 0
		next(kind?: string): string {
			this.#index += 1
			return `${kind ?? 'delivery'}-${this.#index}`
		}
	}

	const legacyLlm: AdaptLLMPlugin = {
		id: 'test',
		model: { toConfig: (input) => input as { plugin: string; provider: string; id: string } },
		async call() { throw new Error('legacy model path must not run') },
	}
	const queryModel = { plugin: 'test', provider: 'test', id: 'query-model' }

	function profile(): TextProfileSnapshot<TextLearningConfig> {
		const ref = { id: 'two-step-profile', version: '1' }
		return {
			ref, revision: 1, configuration: config(), createdAt: at,
			bindings: {
				neuron: { id: 'preferences', incarnation: 'incarnation-1', ownership_revision: 0 },
				profile: ref, profile_revision: 1, procedure: twoStepRecipeRef, model: modelRef,
				registry_lineage: 'two-step-test', referenced_definition_digest: 'two-step-1',
				allowed_catalogue_digest: 'two-step-only',
			},
		}
	}

	function runtime(outputs: ProseOutcome[], seen: ProseRequest[], clock: Clock): AdaptiveTextLearningRuntime {
		const ids = new Ids()
		return {
			models: [{
				ref: modelRef,
				provider: {
					async generate(request) {
						seen.push(request)
						const output = outputs.shift()
						if (output === undefined) throw new Error('unexpected model call')
						return output
					},
				},
				tokens,
			}],
			stateIds: ids,
			inputIds: ids,
			clock,
			scheduler: { schedule: () => undefined, cancel: () => undefined },
			policy: {
				headStateId: 'adaptive:text:head', narrativeMemoryId: 'current',
				stateKind: 'adaptive-text', selectionStateId: 'adaptive:text:selection',
				maxRetainedProfiles: 20, maxFlushRuns: 20,
			},
			countInputTokens: (inputs) => inputs.reduce((total, input) => total + input.text.length, 0),
			onError: (error) => { throw error },
		}
	}

	it('keeps a cut-off batch durable, learns it with later inputs, and restores the understanding', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-two-step-'))
		directories.push(directory)
		const path = join(directory, 'neuron.sqlite')
		const clock = new Clock()
		const seen: ProseRequest[] = []
		const neuron = await TextNeuron.create({
			id: 'preferences', model: queryModel, llm: legacyLlm, store: new SQLiteNeuronStore(path),
			instructions: purpose,
			learning: {
				mode: 'adaptive', initialProfile: profile(),
				runtime: runtime([
					complete('Slack for urgent matters.'),
					cutOff,
					complete('Slack for urgent matters. Calls only on Fridays.'),
					complete('Urgent matters go to Slack; calls happen only on Fridays.'),
				], seen, clock),
			},
		})

		await neuron.learn([{ deliveryId: 'first', text: 'Prefers Slack for urgent things.', observedAt: at }])
		expect((await neuron.flush()).runs[0]).toMatchObject({ status: 'deferred' })
		expect(await neuron.getUnderstanding()).toBe('')
		expect((await neuron.getLearningState()).pendingDeliveryIds).toEqual(['first'])

		await neuron.learn([{ deliveryId: 'second', text: 'Calls only on Fridays.', observedAt: later }])
		clock.value = later
		expect((await neuron.resume()).runs[0]).toMatchObject({ status: 'settled', commit: { status: 'committed' } })
		expect(seen[2]?.prompt).toBe('Data:\nPrefers Slack for urgent things.\n\nCalls only on Fridays.')
		expect(seen[3]?.prompt).toContain('Extracted information:\nSlack for urgent matters. Calls only on Fridays.')
		expect((await neuron.getLearningState()).pendingDeliveryIds).toEqual([])
		await neuron.dispose()

		const restored = await TextNeuron.restore(path, {
			model: queryModel, llm: legacyLlm,
			learning: { mode: 'adaptive', runtime: runtime([], [], clock) },
		})
		expect(await restored.getUnderstanding()).toBe('Urgent matters go to Slack; calls happen only on Fridays.')
		await restored.dispose()
	})
})
