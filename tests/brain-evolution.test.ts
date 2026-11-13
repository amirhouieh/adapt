import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain'
import { leftoverEntry } from '../src/brain/evolution'
import type { LanguageModel } from '../src/llm'
import { MemoryBrainStore } from '../src/stores'

const usage: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

type Turn = Array<{ tool: string; input: object }> | string

/**
 * One model for everything. Evolution calls (they carry tools) get `turns`
 * in order; the prompt-context call gets JSON; learning calls get `learn`.
 */
function scriptedModel(
	turns: Turn[],
	learn: (prompt: string) => string,
	evolutionPrompts: string[],
): LanguageModel {
	let turn = 0
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'test',
		modelId: 'scripted',
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions) {
			const prompt = JSON.stringify(options.prompt)
			let content: LanguageModelV3Content[]
			if (options.tools?.length) {
				evolutionPrompts.push(prompt)
				const next = turns[turn++] ?? 'Done.'
				content =
					typeof next === 'string'
						? [{ type: 'text', text: next }]
						: next.map((call, i) => ({
								type: 'tool-call',
								toolCallId: `t${turn}-${i}`,
								toolName: call.tool,
								input: JSON.stringify(call.input),
							}))
			} else if (options.responseFormat?.type === 'json') {
				content = [
					{
						type: 'text',
						text: JSON.stringify({ purpose: 'Track things.', synthesisDirective: null }),
					},
				]
			} else {
				content = [{ type: 'text', text: learn(prompt) }]
			}
			const toolCall = content.some((c) => c.type === 'tool-call')
			return {
				content,
				finishReason: toolCall
					? { unified: 'tool-calls', raw: 'tool_calls' }
					: { unified: 'stop', raw: 'stop' },
				usage,
				warnings: [],
				request: {},
				response: { id: `r-${turn}`, timestamp: new Date(), modelId: 'scripted' },
			}
		},
		async doStream(): Promise<never> {
			throw new Error('not implemented')
		},
	}
	return model as unknown as LanguageModel
}

const neuron = (id: string) => ({
	id,
	name: id,
	description: `Knows ${id}`,
	instructions: `Track ${id}.`,
})

const noInternalNeurons = {
	globalUnderstanding: false,
	globalQueryUnderstanding: false,
	injectionGaps: false,
	queryGaps: false,
}

describe('Brain evolution', () => {
	it('applies create, merge and update from one loop and retries gaps on changed neurons', async () => {
		const evolutionPrompts: string[] = []
		const model = scriptedModel(
			[
				[{ tool: 'readMemory', input: { id: 'a' } }],
				[
					{
						tool: 'createNeuron',
						input: {
							id: 'languages',
							name: 'Languages',
							description: 'Programming languages the user learns',
							instructions: 'Track languages the user learns.',
						},
					},
					{
						tool: 'mergeNeurons',
						input: { ids: ['a', 'b'], id: 'ab', name: 'AB', description: 'a and b', instructions: 'Track a and b.' },
					},
					{
						tool: 'updateNeuron',
						input: { id: 'c', name: 'C2', description: 'Knows c2', instructions: 'Track c2.' },
					},
					{ tool: 'removeNeuron', input: { id: 'missing' } },
				],
				'Done.',
			],
			(prompt) => (prompt.includes('Track languages') ? 'Learning Rust.' : 'NONE'),
			evolutionPrompts,
		)
		const store = new MemoryBrainStore()
		const brain = await Brain.create({
			prompt: 'Track what the user does.',
			model,
			autoSetup: false,
			store,
			neurons: [neuron('a'), neuron('b'), neuron('c')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
		})
		await brain.getNeuron('a')?.setUnderstanding('A memory')
		await brain.getNeuron('b')?.setUnderstanding('B memory')
		await store.dismissedBatches.add({
			id: 'batch_1',
			data: ['I started learning Rust.'],
			gaps: [],
			timestamp: new Date().toISOString(),
			retryCount: 0,
			status: 'pending',
		})
		const events: string[] = []
		brain.on((event) => {
			if (event.type.startsWith('evolution:')) events.push(event.type)
		})

		const result = await brain.evolve()

		expect(evolutionPrompts[0]).toContain('I started learning Rust.')
		expect(result.changes).toEqual([
			{ action: 'create', neuronId: 'languages' },
			{ action: 'merge', neuronId: 'ab', mergedIds: ['a', 'b'] },
			{ action: 'update', neuronId: 'c' },
		])
		expect(result.reasoning).toBe('Done.')
		expect(events).toEqual([
			'evolution:started',
			'evolution:change',
			'evolution:change',
			'evolution:change',
			'evolution:completed',
		])
		expect(brain.getNeurons().map((n) => n.id).sort()).toEqual(['ab', 'c', 'languages'])
		expect(await brain.getNeuron('ab')?.getUnderstanding()).toBe('A memory\n\nB memory')
		expect(brain.getNeuron('c')?.name).toBe('C2')
		expect(brain.getNeuron('c')?.instructions).toBe('Track c2.')
		// The gap was retried on the new neuron and absorbed
		expect(await brain.getNeuron('languages')?.getUnderstanding()).toBe('Learning Rust.')
		expect(await store.dismissedBatches.count()).toBe(0)
		expect(await store.evolution.count()).toBe(1)
		await brain.dispose()
	})

	it('runs by itself when buffered signals reach the threshold', async () => {
		const brain = await Brain.create({
			prompt: 'Track things.',
			model: scriptedModel(['Nothing to change.'], () => 'NONE', []),
			autoSetup: false,
			store: new MemoryBrainStore(),
			neurons: [neuron('a')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, evaluatorSignalThreshold: 2 },
		})
		const completed = new Promise<unknown>((resolve) =>
			brain.on('evolution:completed', resolve),
		)
		const started: number[] = []
		brain.on('evolution:started', (e) => started.push(e.signalCount))

		brain.signal({ source: 'test', description: 'one' })
		expect(started).toEqual([])
		brain.signal({ source: 'test', description: 'two' })

		expect(await completed).toEqual({ changes: [], reasoning: 'Nothing to change.' })
		expect(started).toEqual([2])
		await brain.dispose()
	})

	it('throws when evolution is disabled, and merge needs two neurons', async () => {
		const brain = await Brain.create({
			prompt: 'Track things.',
			model: scriptedModel([], () => 'NONE', []),
			autoSetup: false,
			store: new MemoryBrainStore(),
			neurons: [neuron('a')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: false },
		})
		await expect(brain.evolve()).rejects.toThrow('not enabled')
		await expect(brain.mergeNeurons(['a', 'a'], neuron('x'))).rejects.toThrow('two or more')
		await expect(brain.addNeuron(neuron('a'))).rejects.toThrow('already exists')
		await brain.dispose()
	})

	it('does not report an update that changes nothing', async () => {
		const brain = await Brain.create({
			prompt: 'Track things.',
			model: scriptedModel([[{ tool: 'updateNeuron', input: neuron('a') }], 'Done.'], () => 'NONE', []),
			autoSetup: false,
			store: new MemoryBrainStore(),
			neurons: [neuron('a')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
		})
		const result = await brain.evolve()
		expect(result.changes).toEqual([])
		await brain.dispose()
	})
})

/**
 * Learning replies by step. Extract and update reply with `notes[topic]` for
 * the neuron whose instructions name the topic, else NONE; the leftover call
 * replies with `leftover()`. Every call is logged in `calls`.
 */
function learnScript(notes: Record<string, string>, leftover: () => string, calls: string[]) {
	return (prompt: string): string => {
		if (prompt.includes('Here are some entries')) {
			calls.push(`leftover:${prompt}`)
			return leftover()
		}
		const step = prompt.includes('Our job is to extract') ? 'extract' : 'update'
		const topic = Object.keys(notes).find((t) => prompt.includes(`Track ${t}`))
		calls.push(`${step}:${topic ?? 'none'}`)
		return topic ? notes[topic] : 'NONE'
	}
}

const coding = 'I always use strict TypeScript.'
const ramen = 'Dinner last night: vegetarian ramen.'

describe('Brain gaps in batches some neuron took', () => {
	it('finds the leftover, signals it, and retries it only on the neuron evolution creates', async () => {
		const calls: string[] = []
		const evolutionPrompts: string[] = []
		const model = scriptedModel(
			[
				[
					{
						tool: 'createNeuron',
						input: { id: 'food', name: 'Food', description: 'Food habits', instructions: 'Track food.' },
					},
					{
						tool: 'updateNeuron',
						input: { id: 'coding', name: 'Coding', description: 'Coding', instructions: 'Track coding and tools.' },
					},
				],
				'Done.',
			],
			learnScript(
				{ coding: 'Uses strict TypeScript.', food: 'Eats vegetarian ramen.' },
				() => `Entry 1:\n${ramen}`,
				calls,
			),
			evolutionPrompts,
		)
		const store = new MemoryBrainStore()
		const brain = await Brain.create({
			prompt: 'Track my coding and my food.',
			model,
			autoSetup: false,
			store,
			neurons: [neuron('coding')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
		})
		const signals: string[] = []
		brain.on('brain:signal:received', (s) => signals.push(s.description))

		await brain.inject([coding, ramen])
		// Below chunkChars: buffered, no leftover call yet
		expect(calls).toEqual(['extract:coding', 'update:coding'])
		expect(await store.dismissedBatches.count()).toBe(0)

		calls.length = 0
		const result = await brain.evolve()

		// evolve() flushed the buffer first: one leftover call, one signal
		expect(calls[0]).toContain(`Data:\\n${coding}\\n${ramen}`)
		expect(calls[0]).toContain('Notes already taken:\\nUses strict TypeScript.')
		expect(signals).toEqual([`Entry 1:\n${ramen}`])
		expect(evolutionPrompts[0]).toContain(`# Inputs no neuron took (oldest first)\\n\\n- Entry 1:\\n${ramen}`)
		expect(result.changes).toEqual([
			{ action: 'create', neuronId: 'food' },
			{ action: 'update', neuronId: 'coding' },
		])
		// Retried on the new food neuron only, never on coding (which took it)
		expect(calls.slice(1)).toEqual(['extract:food', 'update:food'])
		expect(await brain.getNeuron('food')?.getUnderstanding()).toBe('Eats vegetarian ramen.')
		expect(await brain.getNeuron('coding')?.getUnderstanding()).toBe('Uses strict TypeScript.')
		expect(await store.dismissedBatches.count()).toBe(0)
		await brain.dispose()
	})

	it.each(['', 'Entry 1: NONE', 'Entry 1:\nNONE'])('is no gap when the leftover reply is %j', async (reply) => {
		const calls: string[] = []
		const store = new MemoryBrainStore()
		const brain = await Brain.create({
			prompt: 'Track my coding and my food.',
			model: scriptedModel(
				[],
				learnScript({ coding: 'Uses strict TypeScript.', food: 'Eats ramen.' }, () => reply, calls),
				[],
			),
			autoSetup: false,
			store,
			neurons: [neuron('coding'), neuron('food')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
			gaps: { chunkChars: 1 },
		})
		const signals: string[] = []
		brain.on('brain:signal:received', (s) => signals.push(s.description))

		await brain.inject([coding, ramen])

		expect(calls.filter((c) => c.startsWith('leftover:'))).toHaveLength(1)
		expect(signals).toEqual([])
		expect(await store.dismissedBatches.count()).toBe(0)
		await brain.dispose()
	})

	it('collects batches until their length reaches chunkChars, then makes one leftover call', async () => {
		const calls: string[] = []
		const store = new MemoryBrainStore()
		const first = leftoverEntry([coding, ramen], ['Uses strict TypeScript.'])
		const leftover = `Entry 1:\n${ramen}\nEntry 2:\n${ramen}`
		const brain = await Brain.create({
			prompt: 'Track my coding.',
			model: scriptedModel([], learnScript({ coding: 'Uses strict TypeScript.' }, () => leftover, calls), []),
			autoSetup: false,
			store,
			neurons: [neuron('coding')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
			gaps: { chunkChars: first.length + 1 },
		})
		const leftoverCalls = () => calls.filter((c) => c.startsWith('leftover:'))

		await brain.inject([coding, ramen])
		expect(leftoverCalls()).toHaveLength(0)
		await brain.inject([coding, ramen])
		expect(leftoverCalls()).toHaveLength(1)
		expect(leftoverCalls()[0]).toContain('<Entry 2>')

		const [record] = await store.dismissedBatches.list()
		expect(record.data).toEqual([coding, ramen, coding, ramen])
		expect(record.gaps).toEqual([leftover])
		await brain.dispose()
	})

	it('keeps a whole-batch gap with no leftover call when no neuron takes the batch', async () => {
		const calls: string[] = []
		const store = new MemoryBrainStore()
		const brain = await Brain.create({
			prompt: 'Track my coding.',
			model: scriptedModel([], learnScript({}, () => 'unused', calls), []),
			autoSetup: false,
			store,
			neurons: [neuron('coding')],
			internalNeurons: noInternalNeurons,
			evolution: { enabled: true, autoEvaluate: false },
			gaps: { chunkChars: 1 },
		})
		await brain.inject([ramen])
		expect(calls).toEqual(['extract:none'])
		const [record] = await store.dismissedBatches.list()
		expect(record.data).toEqual([ramen])
		expect(record.gaps).toEqual([])
		await brain.dispose()
	})
})
