import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import {
	MemoryNeuronStore,
	TextNeuron,
	type LearnOutput,
} from '../src'
import {
	createV1TextPhaseDag,
	type V1TextPhaseDagOutput,
} from '../src/learning/v1-text-phases'
import type {
	AdaptLLMPlugin,
	AdaptModelConfig,
	AdaptModelTurnRequest,
} from '../src/llm'
import type { NeuronStore } from '../src/stores'

interface LegacyNeuron {
	learn(batch: unknown[], options?: { forceSynthesize?: boolean }): Promise<LearnOutput>
	getMetrics(): unknown
	dispose(): Promise<void>
}

interface LegacyModule {
	TextNeuron: {
		create(config: Readonly<Record<string, unknown>>): Promise<LegacyNeuron>
	}
	MemoryNeuronStore: new () => NeuronStore
}

interface CapturedRequest {
	readonly system?: string
	readonly messages: unknown
	readonly temperature?: number
}

type QueuedResponse = unknown | Error

function queuedPlugin(responses: readonly QueuedResponse[]): {
	readonly llm: AdaptLLMPlugin
	readonly requests: CapturedRequest[]
} {
	const queue = [...responses]
	const requests: CapturedRequest[] = []
	const llm: AdaptLLMPlugin = {
		id: 'test-v1-phases',
		model: {
			toConfig(input): AdaptModelConfig {
				if (typeof input === 'object' && input !== null && 'id' in input) {
					return input as AdaptModelConfig
				}
				return { plugin: 'test-v1-phases', id: String(input) }
			},
		},
		async call<TJson>(request: AdaptModelTurnRequest): Promise<{ json: TJson }> {
			requests.push({
				system: request.system,
				messages: request.messages,
				temperature: request.settings?.temperature,
			})
			const response = queue.shift()
			if (response instanceof Error) throw response
			if (response === undefined) throw new Error('missing queued response')
			return { json: response as TJson }
		},
	}
	return { llm, requests }
}

const model: AdaptModelConfig = {
	plugin: 'test-v1-phases',
	id: 'deterministic',
}

function identity() {
	return { skills: [], dynamicsSkills: [] }
}

function observed(output: readonly unknown[], importance = 0.9) {
	return { status: 'observed', output, importance, gaps: [] }
}

function synthesized(text = 'Remember compact navigation.') {
	return {
		status: 'synthesized',
		newUnderstanding: text,
		significance: 'routine',
		evolution: 'Recorded the preference.',
		reasoning: 'The observation is durable.',
		output: '',
	}
}

function normalizeStore(records: Awaited<ReturnType<typeof snapshotStore>>) {
	return {
		observations: records.observations.map((record) => ({
			data: record.data,
			importance: record.metadata_importance,
			tokens: record.metadata_tokens,
			status: record.metadata_status,
		})),
		understanding: records.understanding.map((record) => ({ data: record.data })),
		evolution: records.evolution.map((record) => ({
			summary: record.summary,
			significance: record.significance,
			reasoning: record.reasoning,
		})),
	}
}

async function snapshotStore(store: NeuronStore) {
	return {
		observations: await store.observations.list(),
		understanding: await store.understanding.list(),
		evolution: await store.evolution.list(),
	}
}

function result(output: V1TextPhaseDagOutput): LearnOutput {
	if (output.output === undefined) throw new Error('DAG did not return a learn output')
	return output.output
}

const dagConfig = {
	revisions: { memory: 0, configuration: 0, registry: 'v1-text-phase-test' },
	planningLimits: { maxNodes: 2, maxCollectionItems: 1, maxOperations: 2 },
	operationBudget: 2,
} as const

let baseline: LegacyModule

beforeAll(async () => {
	const config = JSON.parse(
		readFileSync(resolve('evals/config/text-dag-comparison.json'), 'utf8'),
	) as { baseline: { root: string; revision: string } }
	const revision = execFileSync('git', ['-C', config.baseline.root, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
	}).trim()
	expect(revision).toBe(config.baseline.revision)
	baseline = await import(
		pathToFileURL(resolve(config.baseline.root, 'src/index.ts')).href
	) as LegacyModule
})

interface ParityCase {
	readonly name: string
	readonly responses: readonly QueuedResponse[]
	readonly batch: readonly string[]
	readonly forceSynthesize: boolean
	readonly config?: Readonly<Record<string, unknown>>
}

const parityCases: readonly ParityCase[] = [
	{
		name: 'normal synthesis',
		responses: [identity(), observed(['Uses compact navigation.']), synthesized()],
		batch: ['I use compact navigation.'],
		forceSynthesize: true,
	},
	{
		name: 'observed below the synthesis threshold',
		responses: [identity(), observed(['Uses compact navigation.'])],
		batch: ['I use compact navigation.'],
		forceSynthesize: false,
		config: { understand: { thresholds: { maxObservations: 10 } } },
	},
	{
		name: 'low-importance dismissal',
		responses: [identity(), observed(['Weak signal.'], 0.1)],
		batch: ['Maybe this matters.'],
		forceSynthesize: false,
		config: { understand: { thresholds: { minImportance: 0.8 } } },
	},
	{
		name: 'observer dismissal',
		responses: [identity(), {
			status: 'dismissed', output: [], importance: 0.5, gaps: ['unrelated'],
		}],
		batch: ['Unrelated input.'],
		forceSynthesize: true,
	},
	{
		name: 'invalid observation response',
		responses: [identity(), observed([{ invalid: true }])],
		batch: ['Invalid structured output.'],
		forceSynthesize: true,
		config: { observationSchema: { type: 'string' } },
	},
	{
		name: 'empty observations',
		responses: [identity(), observed([])],
		batch: ['Nothing extracted.'],
		forceSynthesize: false,
	},
	{
		name: 'observe transport error',
		responses: [identity(), new Error('observer unavailable')],
		batch: ['Input.'],
		forceSynthesize: true,
	},
	{
		name: 'returned synthesis error with processed pending observations',
		responses: [identity(), observed(['Durable fact.']), new Error('synthesis unavailable')],
		batch: ['Durable fact.'],
		forceSynthesize: true,
	},
]

describe('v1 TextNeuron phase DAG', () => {
	for (const parityCase of parityCases) {
		it(`matches committed v1 for ${parityCase.name}`, async () => {
			const baselineRuntime = queuedPlugin(parityCase.responses)
			const currentRuntime = queuedPlugin(parityCase.responses)
			const baselineStore = new baseline.MemoryNeuronStore()
			const currentStore = new MemoryNeuronStore()
			const baselineEvents: Array<{ type: string; payload: unknown }> = []
			const currentEvents: Array<{ type: string; payload: unknown }> = []
			const shared = {
				id: 'parity',
				instructions: 'Remember stable interface preferences.',
				model,
				observationSchema: { type: 'string' },
				...parityCase.config,
			}
			const original = await baseline.TextNeuron.create({
				...shared,
				llm: baselineRuntime.llm,
				store: baselineStore,
				onEvent: (event: { type: string; payload: unknown }) => baselineEvents.push({
					type: event.type, payload: event.payload,
				}),
			})
			const phased = await TextNeuron.create({
				...shared,
				llm: currentRuntime.llm,
				store: currentStore,
				onEvent: (event) => currentEvents.push({ type: event.type, payload: event.payload }),
			})

			const expected = await original.learn([...parityCase.batch], {
				forceSynthesize: parityCase.forceSynthesize,
			})
			const actual = result(await createV1TextPhaseDag(phased, dagConfig).learn({
				batch: parityCase.batch,
				forceSynthesize: parityCase.forceSynthesize,
			}))

			expect(actual).toEqual(expected)
			expect(currentRuntime.requests).toEqual(baselineRuntime.requests)
			expect(currentEvents).toEqual(baselineEvents)
			expect(phased.getMetrics()).toEqual(original.getMetrics())
			expect(normalizeStore(await snapshotStore(currentStore))).toEqual(
				normalizeStore(await snapshotStore(baselineStore)),
			)
			await phased.dispose()
			await original.dispose()
		})
	}

	it('matches committed v1 forced-empty recovery and event order', async () => {
		const responses = [
			identity(), observed(['Uses compact navigation.']), synthesized(),
		]
		const baselineRuntime = queuedPlugin(responses)
		const currentRuntime = queuedPlugin(responses)
		const baselineStore = new baseline.MemoryNeuronStore()
		const currentStore = new MemoryNeuronStore()
		const baselineEvents: string[] = []
		const currentEvents: string[] = []
		const shared = {
			id: 'recovery', instructions: 'Remember preferences.', model,
			observationSchema: { type: 'string' },
			understand: { thresholds: { maxObservations: 10 } },
		}
		const original = await baseline.TextNeuron.create({
			...shared, llm: baselineRuntime.llm, store: baselineStore,
			onEvent: (event: { type: string }) => baselineEvents.push(event.type),
		})
		const phased = await TextNeuron.create({
			...shared, llm: currentRuntime.llm, store: currentStore,
			onEvent: (event) => currentEvents.push(event.type),
		})
		await original.learn(['I use compact navigation.'])
		await createV1TextPhaseDag(phased, dagConfig).learn({
			batch: ['I use compact navigation.'], forceSynthesize: false,
		})

		const expected = await original.learn([], { forceSynthesize: true })
		const actual = result(await createV1TextPhaseDag(phased, dagConfig).learn({
			batch: [], forceSynthesize: true,
		}))

		expect(actual).toEqual(expected)
		expect(currentRuntime.requests).toEqual(baselineRuntime.requests)
		expect(currentEvents).toEqual(baselineEvents)
		expect(phased.getMetrics()).toEqual(original.getMetrics())
		expect(normalizeStore(await snapshotStore(currentStore))).toEqual(
			normalizeStore(await snapshotStore(baselineStore)),
		)
	})

	for (const thrownCase of [
		{ name: 'ordinary synthesis', recovery: false, failureEvents: 1 },
		{ name: 'forced-empty synthesis', recovery: true, failureEvents: 0 },
	] as const) {
		it(`matches committed v1 thrown-error events for ${thrownCase.name}`, async () => {
			const responses = thrownCase.recovery
				? [identity()]
				: [identity(), observed(['Durable fact.'])]
			const baselineRuntime = queuedPlugin(responses)
			const currentRuntime = queuedPlugin(responses)
			const baselineStore = new baseline.MemoryNeuronStore()
			const currentStore = new MemoryNeuronStore()
			const baselineEvents: string[] = []
			const currentEvents: string[] = []
			const shared = {
				id: 'throw-parity', instructions: 'Remember facts.', model,
				observationSchema: { type: 'string' },
			}
			const original = await baseline.TextNeuron.create({
				...shared, llm: baselineRuntime.llm, store: baselineStore,
				onEvent: (event: { type: string }) => baselineEvents.push(event.type),
			})
			const current = await TextNeuron.create({
				...shared, llm: currentRuntime.llm, store: currentStore,
				onEvent: (event) => currentEvents.push(event.type),
			})
			if (thrownCase.recovery) {
				const pending = {
					id: 'pending', data: 'Durable fact.', metadata_importance: 1,
					metadata_tokens: 4, metadata_status: 'pending' as const,
					metadata_created_at: '2026-10-01T00:00:00.000Z',
				}
				await baselineStore.observations.add(pending)
				await currentStore.observations.add(pending)
			}
			const failure = async () => { throw new Error('understanding read failed') }
			baselineStore.understanding.get = failure
			currentStore.understanding.get = failure
			const batch = thrownCase.recovery ? [] : ['Durable fact.']

			await expect(original.learn(batch, { forceSynthesize: true })).rejects.toThrow(
				'understanding read failed',
			)
			await expect(current.learn(batch, { forceSynthesize: true })).rejects.toThrow(
				'understanding read failed',
			)

			expect(currentEvents).toEqual(baselineEvents)
			expect(
				currentEvents.filter((event) => event === 'neuron:learn:failed'),
			).toHaveLength(thrownCase.failureEvents)
		})
	}

	it('honors abort and operation budgets without calling the learner', async () => {
		let prepares = 0
		const learner = {
			async prepareLearning() {
				prepares += 1
				throw new Error('unexpected prepare')
			},
			async completeLearning() {
				throw new Error('unexpected complete')
			},
		}
		const aborted = new AbortController()
		aborted.abort(new Error('stop'))
		const execution = await createV1TextPhaseDag(learner, dagConfig).learn({
			batch: ['input'], forceSynthesize: true, signal: aborted.signal,
		})
		expect(execution.output).toBeUndefined()
		expect(execution.execution.result).toMatchObject({ outcome: 'failure', code: 'cancelled' })
		expect(prepares).toBe(0)

		const budget = {
			claim: () => false,
			snapshot: () => ({ exhausted: true }),
		}
		const deferred = await createV1TextPhaseDag(learner, dagConfig).learn({
			batch: ['input'], forceSynthesize: true, budget,
		})
		expect(deferred.output).toBeUndefined()
		expect(deferred.execution.result).toMatchObject({ outcome: 'defer' })
		expect(prepares).toBe(0)
	})
})
