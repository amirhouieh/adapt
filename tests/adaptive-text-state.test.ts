import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
	LearningCoordinator,
	TextLearningStateStore,
	type TextCoordinatorConfiguration,
	type TextInput,
	type TextProcedureDecision,
	type TextProfileSnapshot,
	type TextStateScheduler,
} from '../src/learning/text-state'
import { MemoryNeuronStore } from '../src/stores/memory/neuron'
import { SQLiteNeuronStore } from '../src/stores/sqlite/node/neuron'
import type { NeuronStore } from '../src/stores'

class Clock {
	constructor(public value: string) {}
	now(): string { return this.value }
}

class Ids {
	private value = 0
	next(kind: 'work' | 'attempt' | 'run' | 'candidate' | 'history' | 'change' | 'supersede' | 'profile' | 'activation'): string {
		this.value += 1
		return `${kind}-${this.value}`
	}
}

class Scheduler implements TextStateScheduler {
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

const at = '2026-10-10T08:00:00.000Z'
const later = '2026-10-10T08:01:00.000Z'

const configuration: TextCoordinatorConfiguration = {
	batching: { maxItems: 2, maxInputCharacters: 200, maxInputTokens: 200, maxDelayMs: 1000, acceptCallerUrgency: true },
	input: { maxItemCharacters: 120 },
	memory: { maxCharacters: 300, allowExplicitClear: true },
	retries: { maxLogicalAttempts: 3, initialDelayMs: 10, maxDelayMs: 50, terminalAfterMs: 10000 },
	history: { maxEntries: 4, maxCharacters: 2000 },
	idempotence: { processedIdHorizonMs: 10000, maxProcessedIds: 4 },
}

function profile(version = '1', revision = 1): TextProfileSnapshot<TextCoordinatorConfiguration> {
	const ref = { id: 'text-profile', version }
	return {
		ref,
		revision,
		configuration,
		createdAt: at,
		bindings: {
			neuron: { id: 'neuron-1', incarnation: 'incarnation-1', ownership_revision: 1 },
			profile: ref,
			profile_revision: revision,
			procedure: { id: 'direct-revision', version },
			model: { id: 'local-model', version: '1' },
			registry_lineage: 'registry-lineage-1',
			referenced_definition_digest: `definitions-${version}`,
			allowed_catalogue_digest: 'catalogue-1',
		},
	}
}

function input(id: string, text = `source ${id}`): TextInput {
	return { deliveryId: id, eventId: `event-${id}`, text, observedAt: at }
}

const policy = {
	headStateId: 'adaptive-text-head',
	narrativeMemoryId: 'current',
	stateKind: 'adaptive-text-state',
	maxRetainedProfiles: 8,
	maxFlushRuns: 8,
}

function fixture(
	store: NeuronStore,
	decisions: Array<
		TextProcedureDecision | Promise<TextProcedureDecision>
	>,
	clock = new Clock(at),
	ids = new Ids(),
	scheduler = new Scheduler(),
	seenRuns?: string[][],
) {
	const state = new TextLearningStateStore<TextCoordinatorConfiguration>({
		store,
		ids,
		clock,
		policy,
		countInputTokens: (inputs) => inputs.reduce((total, entry) => total + entry.text.length, 0),
		fitsRequest: ({ memory, inputs }) => memory.text.length + inputs.reduce((total, entry) => total + entry.text.length, 0) <= 250
			? { status: 'fits' }
			: { status: 'memory-capacity', reason: 'complete request exceeds supplied context budget' },
	})
	const coordinator = new LearningCoordinator({
		state,
		clock,
		scheduler,
		policy,
		onError(error) { throw error },
		async runProcedure(snapshot) {
			seenRuns?.push(snapshot.inputs.map(({ deliveryId }) => deliveryId))
			const decision = decisions.shift()
			if (!decision) throw new Error('missing test decision')
			return await decision
		},
	})
	return { state, coordinator, clock, ids, scheduler }
}

describe.each([
	['memory', () => new MemoryNeuronStore()],
	['node sqlite', () => new SQLiteNeuronStore()],
] as const)('adaptive text state: %s', (_name, createStore) => {
	it('settles exact source once and disposes transient text', async () => {
		const store = createStore()
		const f = fixture(store, [{ status: 'change', narrative: 'Learned narrative.', proposal: { raw: 'candidate' } }])
		await f.coordinator.initialize(profile())
		expect(await f.coordinator.learn(input('delivery-1'))).toMatchObject({ status: 'queued' })
		const results = await f.coordinator.flush()
		expect(results[0]).toMatchObject({ status: 'settled', commit: { status: 'committed', learned_state_revision: 1 } })
		expect(await store.pendingWork.list()).toEqual([])
		expect(await store.pendingInputs.list()).toEqual([])
		expect((await store.understanding.get('current'))?.data).toBe('Learned narrative.')
		expect(await store.processedInputs.get('delivery-1')).toMatchObject({ outcome: 'change' })
		expect((await store.state.list()).some((record) => JSON.stringify(record.value).includes('source delivery-1'))).toBe(false)
		await store.dispose()
	})
})

describe('adaptive text recovery and activation', () => {
	it('reopens SQLite and commits a durable candidate without another procedure call', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-text-state-'))
		const path = join(directory, 'state.sqlite')
		const ids = new Ids()
		const clock = new Clock(at)
		try {
			let store: NeuronStore = new SQLiteNeuronStore(path)
			let f = fixture(store, [], clock, ids)
			await f.coordinator.initialize(profile())
			await f.state.enqueue(input('crash-delivery'))
			const begun = await f.state.beginRun(true)
			expect(begun.status).toBe('started')
			const candidateId = await f.state.persistCandidate(begun.snapshot!.runId, { status: 'change', narrative: 'Recovered narrative.', proposal: { raw: 'survives crash' } })
			expect(candidateId).toBeTruthy()
			await store.dispose()

			store = new SQLiteNeuronStore(path)
			f = fixture(store, [], clock, ids)
			expect(await f.coordinator.initialize(profile())).toBe('restored')
			expect(await f.coordinator.resume()).toEqual([expect.objectContaining({ status: 'settled' })])
			expect((await store.understanding.get('current'))?.data).toBe('Recovered narrative.')
			expect(await store.pendingWork.list()).toEqual([])
			await store.dispose()
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it('detects delivery-id conflicts within the explicit horizon', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [{ status: 'no_change', proposal: {} }])
		await f.coordinator.initialize(profile())
		expect(await f.coordinator.learn(input('stable-id', 'first body'))).toMatchObject({ status: 'queued' })
		expect(await f.coordinator.learn(input('stable-id', 'first body'))).toMatchObject({ status: 'deduplicated', coverage: 'pending' })
		expect(await f.coordinator.learn(input('stable-id', 'different body'))).toEqual({ status: 'conflict', reason: 'delivery-id-reused' })
		await f.coordinator.flush()
		expect(await f.coordinator.learn(input('stable-id', 'first body'))).toMatchObject({ status: 'deduplicated', coverage: 'processed' })
		expect(await f.coordinator.learn(input('stable-id', 'different body'))).toEqual({ status: 'conflict', reason: 'delivery-id-reused' })
		f.clock.value = later
		expect(await f.coordinator.learn(input('stable-id', 'different body'))).toMatchObject({ status: 'queued' })
	})

	it('keeps selector failure eligible, and distinguishes no-change from clear', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [
			{ status: 'change', narrative: 'Initial memory.', proposal: {} },
			{ status: 'no_change', proposal: {}, reason: 'nothing material' },
			{ status: 'clear', proposal: {}, explanation: 'explicit correction' },
		])
		await f.coordinator.initialize(profile())
		await f.coordinator.learn(input('initial'))
		await f.coordinator.flush()
		await f.coordinator.learn(input('unchanged'))
		const selection = await f.coordinator.review(async () => ({ status: 'failure' as const, code: 'selector_failed' }))
		expect(selection.status).toBe('failure')
		expect((await f.coordinator.snapshot()).pendingDeliveryIds).toContain('unchanged')
		await f.coordinator.flush()
		expect((await store.understanding.get('current'))?.data).toBe('Initial memory.')
		await f.coordinator.learn(input('clear'))
		await f.coordinator.flush()
		expect((await store.understanding.get('current'))?.data).toBe('')
		expect((await store.learningRevisions.get('current'))?.learned_state_revision).toBe(3)
		expect((await store.learningRevisions.get('current'))?.memory_revision).toBe(2)
	})

	it('rejects stale selection and supersedes nonrunning old-profile work atomically', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [{ status: 'no_change', proposal: {} }])
		await f.coordinator.initialize(profile())
		const stale = await f.coordinator.selectionState()
		await f.coordinator.learn(input('advance-state'))
		await f.coordinator.flush()
		expect(await f.coordinator.activate(profile('2', 2), stale)).toEqual({ status: 'stale-selection' })
		await f.coordinator.learn(input('pending-old-profile'))
		const current = await f.coordinator.selectionState()
		const beforeAttempt = (await store.pendingWork.list())[0]!.attempt_id
		expect(await f.coordinator.activate(profile('2', 2), current)).toMatchObject({ status: 'activated', supersededAttempts: 1 })
		const pending = (await store.pendingWork.list())[0]!
		expect(pending.attempt_id).not.toBe(beforeAttempt)
		expect(pending.bindings?.profile).toEqual({ id: 'text-profile', version: '2' })
		expect(pending.inputs?.[0]?.text).toBe('source pending-old-profile')
	})

	it('re-drives older due work on resume and leaves memory-capacity work pending', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [{ status: 'change', narrative: 'old work learned', proposal: {} }])
		await f.coordinator.initialize(profile())
		await f.state.enqueue(input('old-pending'))
		f.clock.value = later
		expect(await f.coordinator.resume()).toEqual([expect.objectContaining({ status: 'settled' })])
		await store.understanding.update('current', { data: 'x'.repeat(245) })
		await f.state.enqueue(input('capacity-pending', 'ten chars!'))
		expect(await f.coordinator.flush()).toEqual([{ status: 'memory-capacity', reason: 'complete request exceeds supplied context budget' }])
		expect((await f.coordinator.snapshot()).pendingDeliveryIds).toContain('capacity-pending')
		expect(f.scheduler.scheduled.filter((entry) => !entry.cancelled)).toEqual([])
	})

	it('resumes persisted due work only when the host-owned scheduler calls back', async () => {
		const store = new MemoryNeuronStore()
		const scheduler = new Scheduler()
		const clock = new Clock(at)
		const f = fixture(store, [{ status: 'no_change', proposal: {} }], clock, new Ids(), scheduler)
		await f.coordinator.initialize(profile())
		await f.coordinator.learn(input('timer-input'))
		const active = scheduler.scheduled.filter((entry) => !entry.cancelled)
		expect(active).toHaveLength(1)
		expect(active[0]!.dueAt).toBe('2026-10-10T08:00:01.000Z')
		clock.value = later
		active[0]!.callback()
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(await store.processedInputs.get('timer-input')).toMatchObject({ outcome: 'no-change' })
		await f.coordinator.dispose()
	})

	it('keeps a public batch together behind an active timer-driven attempt', async () => {
		const store = new MemoryNeuronStore()
		const scheduler = new Scheduler()
		const clock = new Clock(at)
		let releaseFirst: ((decision: TextProcedureDecision) => void) | undefined
		const firstDecision = new Promise<TextProcedureDecision>((resolve) => {
			releaseFirst = resolve
		})
		const seenRuns: string[][] = []
		const f = fixture(
			store,
			[firstDecision, { status: 'no_change', proposal: {} }],
			clock,
			new Ids(),
			scheduler,
			seenRuns,
		)
		await f.coordinator.initialize(profile())
		await f.coordinator.learn(input('timer-active'))
		clock.value = later
		const due = scheduler.scheduled.find((entry) => !entry.cancelled)
		expect(due).toBeDefined()
		due?.callback()
		for (let index = 0; index < 4; index += 1) {
			if ((await f.coordinator.snapshot()).runningRunIds.length > 0) break
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
		}
		expect((await f.coordinator.snapshot()).runningRunIds).toHaveLength(1)

		const batch = f.coordinator.learnBatch([
			input('batch-a'),
			{ ...input('batch-b'), urgency: 'urgent' },
		])
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect((await f.coordinator.snapshot()).pendingDeliveryIds).toEqual([
			'timer-active',
		])
		releaseFirst?.({ status: 'no_change', proposal: {} })
		const result = await batch

		expect(result.enqueued).toEqual([
			expect.objectContaining({ status: 'queued' }),
			expect.objectContaining({ status: 'queued' }),
		])
		expect(seenRuns).toEqual([
			['timer-active'],
			['batch-a', 'batch-b'],
		])
		await f.coordinator.dispose()
	})

	it('waits for a batch enqueue already registered before disposal', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [])
		await f.coordinator.initialize(profile())
		const enqueue = f.state.enqueue.bind(f.state)
		let releaseEnqueue: (() => void) | undefined
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const gate = new Promise<void>((resolve) => {
			releaseEnqueue = resolve
		})
		let blocked = true
		f.state.enqueue = async (value) => {
			if (blocked) {
				blocked = false
				markStarted?.()
				await gate
			}
			return enqueue(value)
		}
		const learning = f.coordinator.learnBatch([
			input('dispose-a'),
			input('dispose-b'),
		])
		await started
		let disposed = false
		const disposing = f.coordinator.dispose().then(() => {
			disposed = true
		})
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(disposed).toBe(false)
		releaseEnqueue?.()
		await learning
		await disposing

		expect(disposed).toBe(true)
		expect((await f.coordinator.snapshot()).pendingDeliveryIds).toEqual([
			'dispose-a',
			'dispose-b',
		])
	})

	it('does not install a timer when its due lookup finishes after disposal', async () => {
		const store = new MemoryNeuronStore()
		const scheduler = new Scheduler()
		const f = fixture(store, [], new Clock(at), new Ids(), scheduler)
		await f.coordinator.initialize(profile())
		let markLookupStarted: (() => void) | undefined
		let resolveDue: ((dueAt: string | undefined) => void) | undefined
		const lookupStarted = new Promise<void>((resolve) => {
			markLookupStarted = resolve
		})
		const due = new Promise<string | undefined>((resolve) => {
			resolveDue = resolve
		})
		f.state.earliestDueAt = async () => {
			markLookupStarted?.()
			return due
		}
		const learning = f.coordinator.learn(input('shutdown-timer'))
		await lookupStarted

		await f.coordinator.dispose()
		resolveDue?.(later)
		await learning

		expect(scheduler.scheduled).toEqual([])
	})

	it('keeps only the newest overlapping timer arm', async () => {
		const store = new MemoryNeuronStore()
		const scheduler = new Scheduler()
		const f = fixture(store, [], new Clock(at), new Ids(), scheduler)
		await f.coordinator.initialize(profile())
		const lookups: Array<(dueAt: string | undefined) => void> = []
		let markTwoLookups: (() => void) | undefined
		const twoLookups = new Promise<void>((resolve) => {
			markTwoLookups = resolve
		})
		f.state.earliestDueAt = () =>
			new Promise<string | undefined>((resolve) => {
				lookups.push(resolve)
				if (lookups.length === 2) markTwoLookups?.()
			})

		const first = f.coordinator.learn(input('timer-first'))
		while (lookups.length < 1)
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
		const second = f.coordinator.learn(input('timer-second'))
		await twoLookups
		lookups[1]?.(later)
		await second
		lookups[0]?.('2026-10-10T08:00:30.000Z')
		await first

		expect(
			scheduler.scheduled.filter((entry) => !entry.cancelled),
		).toEqual([
			expect.objectContaining({ dueAt: later }),
		])
		await f.coordinator.dispose()
	})

	it('does not let flush bypass retry backoff or exhaust retries in one call', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [{ status: 'defer', reason: 'provider busy' }])
		await f.coordinator.initialize(profile())
		await f.state.enqueue(input('retry-input'))
		expect(await f.coordinator.flush()).toEqual([expect.objectContaining({ status: 'deferred' })])
		expect(await f.coordinator.flush()).toEqual([])
		expect((await store.pendingWork.list())[0]).toMatchObject({ retry_count: 1 })
	})

	it('supersedes a recovered candidate whose config CAS became stale', async () => {
		const store = new MemoryNeuronStore()
		const f = fixture(store, [])
		await f.coordinator.initialize(profile())
		await f.state.enqueue(input('stale-candidate'))
		const begun = await f.state.beginRun(true)
		const runId = begun.snapshot!.runId
		await f.state.persistCandidate(runId, { status: 'change', narrative: 'stale output', proposal: {} })
		expect(await store.learning.updateConfigRevision({ expected_config_revision: 0, next_config_revision: 1, updated_at: later })).toEqual({ status: 'updated', config_revision: 1 })
		expect(await f.coordinator.resume()).toEqual([expect.objectContaining({ status: 'superseded' })])
		expect((await store.pendingWork.list())[0]!.inputs?.[0]?.text).toBe('source stale-candidate')
		expect(await store.understanding.get('current')).toBeUndefined()
	})
})
