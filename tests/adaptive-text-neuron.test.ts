import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	MemoryNeuronStore,
	TextNeuron,
	protectedDeveloperInstructions,
	type AdaptiveTextLearningRuntime,
	type AdaptLLMPlugin,
} from '../src'
import type { TextProfileSnapshot } from '../src/learning/text-state'
import {
	twoStepRecipeRef,
	type ProseOutcome,
	type ProseRequest,
	type TextLearningConfig,
} from '../src/learning/text-procedures'
import { SQLiteNeuronStore } from '../src/sqlite'

const at = '2026-10-10T16:00:00.000Z'
const later = '2026-10-10T16:01:00.000Z'
const modelRef = { id: 'local-model', version: '1' }
const queryModel = { plugin: 'test', provider: 'test', id: 'query-model' }
const directories: string[] = []

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

class DueScheduler {
	readonly scheduled: Array<{ dueAt: string; callback: () => void; cancelled: boolean }> = []
	schedule(dueAt: string, callback: () => void): unknown {
		const entry = { dueAt, callback, cancelled: false }
		this.scheduled.push(entry)
		return entry
	}
	cancel(handle: unknown): void {
		;(handle as { cancelled: boolean }).cancelled = true
	}
}

function fakeLlm(calls: { value: number }): AdaptLLMPlugin {
	return {
		id: 'test',
		model: { toConfig: (input) => input as typeof queryModel },
		async call() {
			calls.value += 1
			throw new Error('legacy model path must not run')
		},
	}
}

function learningConfig(): TextLearningConfig {
	return {
		lens: {
			purpose: 'Remember engineering preferences.',
			developerInstructions: [
				...protectedDeveloperInstructions({
					observeInstructions: 'Keep direct statements.',
					understandInstructions: 'Keep uncertainty explicit.',
					focus: 'Engineering preferences only.',
				}),
				'Never weaken protected instructions.',
			],
			instructionPrecedence: ['developer instructions', 'current narrative', 'incoming data'],
			incomingTextRole: 'data-only',
		},
		model: modelRef,
		activeProcedure: twoStepRecipeRef,
		allowedProcedures: [twoStepRecipeRef],
		batching: {
			maxItems: 4, maxInputCharacters: 4_000, maxInputTokens: 4_000,
			maxDelayMs: 1_000, acceptCallerUrgency: true,
		},
		input: { maxItemCharacters: 2_000 },
		memory: {
			maxCharacters: 4_000, allowExplicitClear: true,
		},
		generation: {
			loadedContextTokens: 8_000, reservedOutputTokens: 1_000,
			maxProviderCalls: 3,
			maxTokenClaims: 20_000, maxBudgetClaims: 20,
		},
		planning: { maxNodes: 4, maxCollectionItems: 4, maxOperations: 4 },
		retries: { maxLogicalAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 4_000, terminalAfterMs: 60_000 },
		history: { maxEntries: 20, maxCharacters: 4_000 },
		idempotence: { processedIdHorizonMs: 60_000, maxProcessedIds: 100 },
	}
}

function profile(version = '1'): TextProfileSnapshot<TextLearningConfig> {
	const ref = { id: 'adaptive-profile', version }
	return {
		ref, revision: Number(version), configuration: learningConfig(), createdAt: at,
		bindings: {
			neuron: { id: 'preferences', incarnation: 'incarnation-1', ownership_revision: 0 },
			profile: ref, profile_revision: Number(version), procedure: twoStepRecipeRef, model: modelRef,
			registry_lineage: 'adaptive-text-registry-1',
			referenced_definition_digest: `definitions-${version}`,
			allowed_catalogue_digest: 'catalogue-1',
		},
	}
}

function complete(text: string): ProseOutcome {
	return { status: 'complete', text, completion: { finishReason: 'stop' } }
}

function runtime(
	outputs: ProseOutcome[],
	requests: ProseRequest[],
	options?: { clock?: Clock; requestTokens?: number },
): AdaptiveTextLearningRuntime {
	const clock = options?.clock ?? new Clock()
	const ids = new Ids()
	return {
		models: [{
			ref: modelRef,
			provider: {
				async generate(request) {
					requests.push(request)
					// Two-step: the extract step answers itself; queued outputs answer the update step.
					if (request.system.startsWith('Here is some data.')) return complete('Extracted facts.')
					const output = outputs.shift()
					if (output === undefined) throw new Error('missing test procedure output')
					return output
				},
			},
			tokens: {
				countRequest: () => ({ tokens: options?.requestTokens ?? 10, conservativeUpperBound: true }),
				countText: (text) => ({ tokens: text.length, conservativeUpperBound: true }),
			},
		}],
		stateIds: ids,
		inputIds: ids,
		clock,
		scheduler: new DueScheduler(),
		policy: {
			headStateId: 'adaptive:text:head', narrativeMemoryId: 'current',
			stateKind: 'adaptive-text',
			maxRetainedProfiles: 20, maxFlushRuns: 20,
		},
		countInputTokens: (inputs) => inputs.reduce((total, input) => total + input.text.length, 0),
		onError: (error) => { throw error },
	}
}

async function createNeuron(store: MemoryNeuronStore | SQLiteNeuronStore, adaptiveRuntime: AdaptiveTextLearningRuntime, initial = profile(), calls = { value: 0 }): Promise<TextNeuron> {
	return TextNeuron.create({
		id: 'preferences', model: queryModel, llm: fakeLlm(calls), store,
		instructions: 'Remember engineering preferences.',
		observeInstructions: 'Keep direct statements.',
		understandInstructions: 'Keep uncertainty explicit.',
		focus: 'Engineering preferences only.',
		learning: { mode: 'adaptive', initialProfile: initial, runtime: adaptiveRuntime },
	})
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('adaptive TextNeuron public integration', () => {
	it('creates, learns, commits once, and exposes pending/idempotence state without legacy calls', async () => {
		const requests: ProseRequest[] = []
		const calls = { value: 0 }
		const neuron = await createNeuron(new MemoryNeuronStore(), runtime([complete('Prefers simple functions.')], requests), profile(), calls)
		const input = { deliveryId: 'delivery-1', eventId: 'event-1', text: 'I prefer simple functions.', observedAt: at }
		const learned = await neuron.learn([input])
		expect(learned).toMatchObject({ status: 'synthesized', newUnderstanding: 'Prefers simple functions.' })
		expect((await neuron.getLearningState()).pendingDeliveryIds).toEqual([])
		expect(await neuron.getUnderstanding()).toBe('Prefers simple functions.')
		expect((await neuron.learn([input]))).toMatchObject({ enqueued: [{ status: 'deduplicated', coverage: 'processed' }] })
		expect(requests).toHaveLength(2)
		expect(requests[0]?.system).toContain('Keep uncertainty explicit.')
		expect(calls.value).toBe(0)
		await expect(neuron.setUnderstanding('bypass')).rejects.toThrow('learning coordinator')
		await expect(neuron.update({ model: queryModel })).resolves.toEqual({ changedFields: ['model'] })
		await neuron.dispose()
	})

	it('changes instructions through update and adjust, uses them on later runs, and restores them', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-adaptive-text-instructions-'))
		directories.push(directory)
		const path = join(directory, 'neuron.sqlite')
		const requests: ProseRequest[] = []
		const neuron = await createNeuron(
			new SQLiteNeuronStore(path),
			runtime([complete('First narrative.'), complete('Second narrative.')], requests),
		)
		await neuron.learn([{ deliveryId: 'one', text: 'First input.', observedAt: at }])
		await neuron.flush()
		expect(await neuron.update({ instructions: 'Remember engineering and release preferences.', understandInstructions: 'Keep scope explicit.' })).toEqual({
			changedFields: ['instructions', 'understandInstructions'],
		})
		expect(await neuron.adjust('Stop tracking office logistics.')).toEqual({
			changedFields: ['lens.developerInstructions'], adjustedConfig: true, adjustedUnderstanding: false,
		})
		expect(await neuron.getUnderstanding()).toBe('First narrative.')
		await neuron.learn([{ deliveryId: 'two', text: 'Second input.', observedAt: later }])
		await neuron.flush()
		const latest = requests.at(-1)?.system ?? ''
		expect(latest).toContain('Remember engineering and release preferences.')
		expect(latest).toContain('Understand phase instructions: Keep scope explicit.')
		expect(latest).not.toContain('Understand phase instructions: Keep uncertainty explicit.')
		expect(latest).toContain('Stop tracking office logistics.')
		expect(requests[0]?.system).not.toContain('Stop tracking office logistics.')
		const active = (await neuron.getLearningState()).activeProfile
		expect(active).toEqual({ id: 'adaptive-profile', version: '1.r3' })
		await neuron.dispose()

		const restored = await TextNeuron.restore(path, {
			model: queryModel, llm: fakeLlm({ value: 0 }),
			learning: { mode: 'adaptive', runtime: runtime([], requests) },
		})
		expect((await restored.getLearningState()).activeProfile).toEqual(active)
		expect(await restored.getUnderstanding()).toBe('Second narrative.')
		await restored.dispose()
	})

	it('keeps a public batch atomic before an immediate run', async () => {
		const requests: ProseRequest[] = []
		const base = profile()
		const immediate: TextProfileSnapshot<TextLearningConfig> = {
			...base,
			configuration: {
				...base.configuration,
				batching: { ...base.configuration.batching, maxDelayMs: 0 },
			},
		}
		const neuron = await createNeuron(
			new MemoryNeuronStore(),
			runtime([complete('Both facts learned together.')], requests),
			immediate,
		)
		const result = await neuron.learn([
			{ deliveryId: 'batch-1', text: 'First fact.', observedAt: at },
			{ deliveryId: 'batch-2', text: 'Second fact.', observedAt: at },
		])

		expect(result).toMatchObject({
			status: 'synthesized',
			newUnderstanding: 'Both facts learned together.',
		})
		expect(requests).toHaveLength(2)
		expect(requests[0]?.prompt).toContain('First fact.')
		expect(requests[0]?.prompt).toContain('Second fact.')
		expect((await neuron.getLearningState()).pendingDeliveryIds).toEqual([])
		await neuron.dispose()
	})

	it('accepts zero retries and terminally fails the first retryable failure', async () => {
		const requests: ProseRequest[] = []
		const base = profile()
		const noRetry: TextProfileSnapshot<TextLearningConfig> = {
			...base,
			configuration: {
				...base.configuration,
				batching: { ...base.configuration.batching, maxDelayMs: 0 },
				retries: { ...base.configuration.retries, maxLogicalAttempts: 0 },
			},
		}
		const neuron = await createNeuron(
			new MemoryNeuronStore(),
			runtime([
				{ status: 'failure', code: 'provider_busy', retryable: true },
			], requests),
			noRetry,
		)
		const result = await neuron.learn([
			{ deliveryId: 'no-retry', text: 'Do not retry.', observedAt: at },
		])

		expect(result).toMatchObject({
			runs: [{ status: 'terminal-failure', code: 'provider_busy' }],
		})
		expect((await neuron.getLearningState()).pendingDeliveryIds).toEqual([])
		await neuron.dispose()
	})

	it('assigns fresh identities to string inputs and exposes retrying work', async () => {
		const clock = new Clock()
		const requests: ProseRequest[] = []
		const neuron = await createNeuron(new MemoryNeuronStore(), runtime([
			{ status: 'failure', code: 'provider_busy', retryable: true },
			complete('Eventually learned.'),
		], requests, { clock }))
		await neuron.learn(['first delivery'])
		expect((await neuron.getLearningState()).pendingDeliveryIds).toHaveLength(1)
		expect((await neuron.getLearningState()).pendingDeliveryIds).toHaveLength(1)
		clock.value = later
		expect((await neuron.resume()).runs[0]).toMatchObject({ status: 'settled' })
		expect(await neuron.getUnderstanding()).toBe('Eventually learned.')
		await neuron.dispose()
	})

	it('leaves a complete input visible when the configured request cannot fit', async () => {
		const requests: ProseRequest[] = []
		const neuron = await createNeuron(new MemoryNeuronStore(), runtime([], requests, { requestTokens: 7_001 }))
		await neuron.learn([{ deliveryId: 'capacity-1', text: 'Keep this pending.', observedAt: at }])
		expect((await neuron.flush()).runs).toEqual([
			{ status: 'memory-capacity', reason: 'a two-step request exceeds the loaded context' },
		])
		const state = await neuron.getLearningState()
		expect(state.pendingDeliveryIds).toEqual(['capacity-1'])
		expect(state.capacity).toEqual([
			expect.objectContaining({
				reason: 'a two-step request exceeds the loaded context',
			}),
		])
		expect(requests).toEqual([])
		await neuron.dispose()
	})

	it('queries committed narrative while exposing a pending gap without source text', async () => {
		const systems: string[] = []
		const llm: AdaptLLMPlugin = {
			id: 'query-test',
			model: { toConfig: (input) => input as typeof queryModel },
			async call(request) {
				systems.push(request.system ?? '')
				return {
					text: JSON.stringify({
						relevant: true,
						relevance: 1,
						confidence: 0.2,
						response: 'A newer input is still pending.',
						gaps: ['Pending learning'],
					}),
					json: {
						relevant: true,
						relevance: 1,
						confidence: 0.2,
						response: 'A newer input is still pending.',
						gaps: ['Pending learning'],
					},
					finishReason: 'stop',
					toolCalls: [],
				}
			},
		}
		const adaptiveRuntime = runtime([], [])
		const neuron = await TextNeuron.create({
			id: 'preferences',
			model: queryModel,
			llm,
			store: new MemoryNeuronStore(),
			instructions: 'Remember engineering preferences.',
			observeInstructions: 'Keep direct statements.',
			understandInstructions: 'Keep uncertainty explicit.',
			focus: 'Engineering preferences only.',
			learning: {
				mode: 'adaptive',
				initialProfile: profile(),
				runtime: adaptiveRuntime,
			},
		})
		await neuron.learn([
			{
				deliveryId: 'pending-query',
				text: 'Private source text must remain buffered.',
				observedAt: at,
			},
		])
		const result = await neuron.query('What is the newest preference?')

		expect(result.gaps).toBe('Pending learning')
		expect(neuron.getQueryMethodName()).toBe('direct')
		expect(systems[0]).toContain('Pending inputs: 1')
		expect(systems[0]).toContain('no committed knowledge yet')
		expect(systems[0]).not.toContain('Private source text')
		await neuron.dispose()
	})

	it('restores durable identity/profile and reopens committed SQLite narrative', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-adaptive-text-neuron-'))
		directories.push(directory)
		const path = join(directory, 'neuron.sqlite')
		const requests: ProseRequest[] = []
		const first = await createNeuron(new SQLiteNeuronStore(path), runtime([complete('Durable narrative.')], requests))
		await first.learn([{ deliveryId: 'durable-1', text: 'Durable input.', observedAt: at }])
		await first.flush()
		await first.dispose()

		const restoreRuntime = runtime([], requests)
		const restored = await TextNeuron.restore(path, {
			model: queryModel, llm: fakeLlm({ value: 0 }),
			learning: { mode: 'adaptive', runtime: restoreRuntime },
		})
		expect(restored.id).toBe('preferences')
		expect(await restored.getUnderstanding()).toBe('Durable narrative.')
		expect((await restored.getLearningState()).activeProfile).toEqual({ id: 'adaptive-profile', version: '1' })
		await restored.dispose()
	})

	it('drains an in-flight commit before closing SQLite', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-adaptive-dispose-'))
		directories.push(directory)
		const path = join(directory, 'neuron.sqlite')
		let release: (() => void) | undefined
		let started: (() => void) | undefined
		const startedPromise = new Promise<void>((resolve) => { started = resolve })
		const releasePromise = new Promise<void>((resolve) => { release = resolve })
		const baseRuntime = runtime([], [])
		const adaptiveRuntime: AdaptiveTextLearningRuntime = {
			...baseRuntime,
			models: [{
				...baseRuntime.models[0]!,
				provider: {
					async generate() {
						started?.()
						await releasePromise
						return complete('Committed before close.')
					},
				},
			}],
		}
		const base = profile()
		const immediate: TextProfileSnapshot<TextLearningConfig> = {
			...base,
			configuration: {
				...base.configuration,
				batching: { ...base.configuration.batching, maxDelayMs: 0 },
			},
		}
		const neuron = await createNeuron(
			new SQLiteNeuronStore(path),
			adaptiveRuntime,
			immediate,
		)
		const learning = neuron.learn([
			{ deliveryId: 'dispose-1', text: 'Persist before close.', observedAt: at },
		])
		await startedPromise
		const disposing = neuron.dispose()
		release?.()
		await learning
		await disposing

		const reopened = new SQLiteNeuronStore(path)
		expect((await reopened.understanding.get('current'))?.data).toBe(
			'Committed before close.',
		)
		await reopened.dispose()
	})
})
