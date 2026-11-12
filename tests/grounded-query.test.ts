import { describe, expect, it } from 'vitest'

import {
	runGroundedQuery,
	type GroundedQuerySnapshot,
	type QueryCandidateSelector,
	type QueryMemorySnapshot,
	type QueryModel,
} from '../src/brain/query/index'

const now = '2026-09-30T12:00:00.000Z'

function snapshot(): GroundedQuerySnapshot {
	return {
		registry: {
			revision: 'registry-4',
			entries: [
				{ memoryId: 'memory-a', lensId: 'lens-a', memoryRevision: 7, configurationRevision: 3 },
				{ memoryId: 'memory-b', lensId: 'lens-b', memoryRevision: 2, configurationRevision: 3 },
			],
		},
		memories: [
			{
				memoryId: 'memory-a', lensId: 'lens-a', registryRevision: 'registry-4',
				memoryRevision: 7, configurationRevision: 3, purpose: 'Track deployment commitments',
				memoryType: 'text', content: 'Production deploys require an audit record.',
			},
			{
				memoryId: 'memory-b', lensId: 'lens-b', registryRevision: 'registry-4',
				memoryRevision: 2, configurationRevision: 3, purpose: 'Track release safeguards',
				memoryType: 'list', content: { rule: 'Keep a rollback plan.' },
			},
		],
		pendingLearning: [
			{
				id: 'pending-1', lensId: 'lens-a', memoryId: 'memory-a',
				inputIds: ['input-new'], reason: 'learning paused',
			},
		],
	}
}

const policy = {
	instructions: 'Answer only what current committed learned memory establishes.',
	maxCandidates: 4,
	maxSelectedCandidates: 2,
	maxCandidateCharacters: 1000,
	maxContextCharacters: 3000,
	maxRequestCharacters: 10000,
	maxAnswerCharacters: 1000,
} as const

function selector(ids: readonly string[]): QueryCandidateSelector {
	return {
		async select() {
			return { value: { selectedMemoryIds: ids, reason: 'fixture selection' }, raw: { ids } }
		},
	}
}

function model(value: unknown, prompt?: (value: string, system: string) => void): QueryModel {
	return {
		async generate<T>(request: { prompt: string; system: string }) {
			prompt?.(request.prompt, request.system)
			return { value: value as T, raw: { value } }
		},
	} as QueryModel
}

function input(overrides: Partial<Parameters<typeof runGroundedQuery>[0]> = {}) {
	return {
		snapshot: snapshot(),
		question: 'What safeguards apply to production deploys?',
		userConstraints: 'Use only learned memory.',
		policy,
		selector: selector(['memory-a', 'memory-b']),
		model: model({
			relevant: true, sufficient: true, reason: '',
			answer: 'Keep an audit record and rollback plan.',
			usedMemoryIds: ['memory-a', 'memory-b'],
			gaps: [],
		}),
		clock: { now: () => now },
		signal: new AbortController().signal,
		...overrides,
	}
}

describe('grounded query', () => {
	it('answers from learned memory without original inputs or excerpts', async () => {
		let answerPrompt = ''
		const result = await runGroundedQuery(input({
			model: model({
				relevant: true, sufficient: true, reason: '',
				answer: 'Keep an audit record and rollback plan.',
				usedMemoryIds: ['memory-a', 'memory-b'],
				gaps: [],
			}, (prompt) => { answerPrompt = prompt }),
		}))
		expect(result.status).toBe('answered')
		if (result.status !== 'answered') return
		expect(result.scope).toBe('committed_state')
		expect(result.usedMemoryIds).toEqual(['memory-a', 'memory-b'])
		expect(result.revisions.memories).toEqual(snapshot().registry.entries)
		expect(result.gaps).toContain(
			'Learning is pending for used memory; this answer uses its current committed revision only.',
		)
		expect(answerPrompt).toContain('"memoryRevision":7')
		expect(answerPrompt).not.toContain('sourceId')
		expect(answerPrompt).not.toContain('excerpt')
		expect(answerPrompt).not.toContain('pendingLearning')
	})

	it('returns a gap when selected memory is relevant but insufficient', async () => {
		const result = await runGroundedQuery(input({
			selector: selector(['memory-a']),
			question: 'Which airline should be booked?',
			model: model({
				relevant: true,
				sufficient: false,
				answer: '',
				reason: 'The learned deployment memory does not establish an airline.',
				usedMemoryIds: ['memory-a'],
				gaps: ['Airline preference is unknown.'],
			}),
		}))
		expect(result).toMatchObject({
			status: 'gap',
			reason: 'The learned deployment memory does not establish an airline.',
			usedMemoryIds: ['memory-a'],
		})
	})

	it('gives the specialist explicit sufficient, insufficient, and unrelated output rules', async () => {
		let system = ''
		const result = await runGroundedQuery(input({
			selector: selector(['memory-a']),
			model: model({
				relevant: true, sufficient: true, answer: 'An audit record is required.',
				reason: '', usedMemoryIds: ['memory-a'], gaps: [],
			}, (_prompt, value) => { system = value }),
		}))
		expect(result.status).toBe('answered')
		expect(system).toContain('Sufficiency is relative to the exact question')
		expect(system).toContain('"relevant":true,"sufficient":true')
		expect(system).toContain('"relevant":true,"sufficient":false,"answer":""')
		expect(system).toContain('"relevant":false,"sufficient":false,"answer":""')
		expect(system).toContain('do not invent additional requirements')
	})

	it('does not let unrelated pending or omitted memory block a known answer', async () => {
		const base = snapshot()
		const value: GroundedQuerySnapshot = {
			...base,
			pendingLearning: [{
				id: 'pending-2', lensId: 'lens-b', memoryId: 'memory-b',
				inputIds: ['input-later'], reason: 'scheduled learning',
			}],
		}
		const result = await runGroundedQuery(input({
			snapshot: value,
			selector: selector(['memory-a']),
			model: model({
				relevant: true, sufficient: true, reason: '', answer: 'An audit record is required.',
				usedMemoryIds: ['memory-a'], gaps: [],
			}),
		}))
		expect(result).toMatchObject({
			status: 'answered',
			usedMemoryIds: ['memory-a'],
			omittedMemoryIds: ['memory-b'],
			gaps: [],
		})
	})

	it('preserves an explicit ambiguity and its learned-memory basis', async () => {
		const result = await runGroundedQuery(input({
			selector: selector(['memory-a']),
			model: model({
				relevant: true, sufficient: false, answer: '',
				reason: 'The committed memory does not establish an approved exception.',
				usedMemoryIds: ['memory-a'],
				gaps: ['Whether an exception was approved is unknown.'],
			}),
		}))
		expect(result).toMatchObject({
			status: 'gap',
			usedMemoryIds: ['memory-a'],
			reason: 'The committed memory does not establish an approved exception.',
			gaps: [
				'Whether an exception was approved is unknown.',
				'Learning is pending for used memory; this answer uses its current committed revision only.',
			],
		})
	})

	it('rejects a half-commit revision mismatch before selector or model calls', async () => {
		const original = snapshot()
		const value: GroundedQuerySnapshot = {
			...original,
			memories: [
				{ ...original.memories[0]!, memoryRevision: 8 },
				original.memories[1]!,
			],
		}
		let calls = 0
		const result = await runGroundedQuery(input({
			snapshot: value,
			selector: { async select() { calls += 1; return selector([]).select({} as never) } },
			model: model({}, () => { calls += 1 }),
		}))
		expect(result).toMatchObject({ status: 'failure', code: 'invalid_snapshot' })
		expect(calls).toBe(0)
	})

	it('omits overlong candidate content and reports the bounded context gap', async () => {
		const result = await runGroundedQuery(input({
			policy: { ...policy, maxCandidateCharacters: 20 },
		}))
		expect(result).toMatchObject({
			status: 'gap',
			usedMemoryIds: [],
			omittedMemoryIds: ['memory-a', 'memory-b'],
		})
	})

	it('rejects a used memory ID outside the selected set', async () => {
		const result = await runGroundedQuery(input({
			selector: selector(['memory-a']),
			model: model({
				relevant: true, sufficient: true, reason: '', answer: 'Bad grounding.',
				usedMemoryIds: ['memory-b'], gaps: [],
			}),
		}))
		expect(result).toMatchObject({ status: 'failure', code: 'invalid_answer' })
	})

	it('defers without provider calls when constraints exceed the request bound', async () => {
		let calls = 0
		const result = await runGroundedQuery(input({
			userConstraints: 'x'.repeat(1000),
			policy: { ...policy, maxRequestCharacters: 200 },
			selector: { async select() { calls += 1; return selector([]).select({} as never) } },
			model: model({}, () => { calls += 1 }),
		}))
		expect(result).toMatchObject({ status: 'defer', code: 'request_bound' })
		expect(calls).toBe(0)
	})

	it('does not accept a successful selection returned after cancellation', async () => {
		const controller = new AbortController()
		let modelCalls = 0
		const result = await runGroundedQuery(input({
			signal: controller.signal,
			selector: {
				async select() {
					controller.abort()
					return {
						value: { selectedMemoryIds: ['memory-a'], reason: 'late selection' },
						raw: { stage: 'selection', completed: true },
					}
				},
			},
			model: model({}, () => { modelCalls += 1 }),
		}))
		expect(result).toMatchObject({
			status: 'defer',
			code: 'cancelled',
			raw: { selection: { stage: 'selection', completed: true } },
		})
		expect(modelCalls).toBe(0)
	})

	it('does not publish a successful answer returned after cancellation', async () => {
		const controller = new AbortController()
		const result = await runGroundedQuery(input({
			signal: controller.signal,
			selector: selector(['memory-a']),
			model: {
				async generate<T>() {
					controller.abort()
					return {
						value: {
							relevant: true, sufficient: true, reason: '', answer: 'Audit record.',
							usedMemoryIds: ['memory-a'], gaps: [],
						} as T,
						raw: { stage: 'answer', completed: true },
					}
				},
			},
		}))
		expect(result).toMatchObject({
			status: 'defer',
			code: 'cancelled',
			raw: {
				answer: { stage: 'answer', completed: true },
			},
		})
	})

	it('pins mutable learned memory before asynchronous selection completes', async () => {
		const value = snapshot()
		let release: (() => void) | undefined
		const waiting = new Promise<void>((resolve) => { release = resolve })
		let answerPrompt = ''
		const running = runGroundedQuery(input({
			snapshot: value,
			selector: {
				async select() {
					await waiting
					return {
						value: { selectedMemoryIds: ['memory-a'], reason: 'selected' },
						raw: {},
					}
				},
			},
			model: model({
				relevant: true, sufficient: true, reason: '', answer: 'Audit record.',
				usedMemoryIds: ['memory-a'], gaps: [],
			}, (prompt) => { answerPrompt = prompt }),
		}))
		;(value.memories as QueryMemorySnapshot[])[0] = {
			...value.memories[0]!,
			content: 'mutated after start',
		}
		release?.()
		await running
		expect(answerPrompt).toContain('Production deploys require an audit record.')
		expect(answerPrompt).not.toContain('mutated after start')
	})
})
