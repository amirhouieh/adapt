import type {
	EvolutionRecord,
	LearningCommitInput,
	LearningStoreOptions,
	NeuronStore,
	ObservationRecord,
	PendingWorkRecord,
	UnderstandingRecord,
} from '../src/stores'

interface TestApi {
	describe: (name: string, fn: () => void) => void
	it: (name: string, fn: () => Promise<void> | void) => void
	expect: any
}

export interface LearningStoreScenario {
	create(options?: LearningStoreOptions): NeuronStore
	reopen(options?: LearningStoreOptions): NeuronStore
	cleanup(): void
}

const time = {
	created: '2026-09-30T08:00:00.000Z',
	committed: '2026-09-30T08:01:00.000Z',
	claimed: '2026-09-30T08:02:00.000Z',
	lease: '2026-09-30T08:03:00.000Z',
	reclaimed: '2026-09-30T08:04:00.000Z',
	secondLease: '2026-09-30T08:05:00.000Z',
	settled: '2026-09-30T08:06:00.000Z',
}

function pending(id: string, attemptId: string, inputIds: string[]): PendingWorkRecord {
	return {
		id,
		attempt_id: attemptId,
		input_ids: inputIds,
		inputs: inputIds.map((inputId) => ({ id: inputId, text: `temporary source text for ${inputId}` })),
		status: 'pending',
		retry_count: 0,
		available_at: time.created,
		created_at: time.created,
		updated_at: time.created,
	}
}

function memory(id: string, data: unknown): UnderstandingRecord {
	return {
		id,
		data,
		metadata_confidence: null,
		metadata_confidence_provenance: 'unknown',
		metadata_created_at: time.created,
		metadata_updated_at: time.committed,
	}
}

function changeCommit(attemptId: string, workId: string, inputIds: string[], expectedRevision: number): LearningCommitInput {
	const nextRevision = expectedRevision + 1
	const changeId = `change-${attemptId}`
	return {
		logical_attempt_id: attemptId,
		pending_work_id: workId,
		expected_memory_revision: expectedRevision,
		expected_config_revision: 0,
		input_ids: inputIds,
		outcome: 'change',
		patch: { type: 'replace', records: [memory('current', `learned understanding ${attemptId}`)] },
		history: {
			id: `history-${attemptId}`,
			attempt_id: attemptId,
			outcome: 'change',
			previous_memory_revision: expectedRevision,
			memory_revision: nextRevision,
			config_revision: 0,
			input_ids: inputIds,
			change_ids: [changeId],
			explanation: 'Learned a durable understanding.',
			created_at: time.committed,
		},
		changes: [{
			id: changeId,
			attempt_id: attemptId,
			memory_revision: nextRevision,
			kind: 'narrative-revision',
			affected_memory_ids: ['current'],
			summary: 'Changed learned understanding.',
			created_at: time.committed,
		}],
		outbox: [{
			id: `outbox-${attemptId}`,
			kind: 'memory-change',
			deduplication_key: `memory-change-${attemptId}`,
			change_ids: [changeId],
			status: 'pending',
			attempts: 0,
			available_at: time.committed,
			created_at: time.committed,
			updated_at: time.committed,
		}],
		committed_at: time.committed,
	}
}

function noChangeCommit(attemptId: string, workId: string, inputIds: string[], revision: number): LearningCommitInput {
	return {
		logical_attempt_id: attemptId,
		pending_work_id: workId,
		expected_memory_revision: revision,
		expected_config_revision: 0,
		input_ids: inputIds,
		outcome: 'no-change',
		history: {
			id: `history-${attemptId}`,
			attempt_id: attemptId,
			outcome: 'no-change',
			previous_memory_revision: revision,
			memory_revision: revision,
			config_revision: 0,
			input_ids: inputIds,
			change_ids: [],
			created_at: time.committed,
		},
		changes: [],
		outbox: [],
		committed_at: time.committed,
	}
}

async function addObservation(store: NeuronStore, id: string): Promise<void> {
	await store.observations.add(observation(id))
}

function observation(id: string, data: unknown = `derived observation ${id}`): ObservationRecord {
	return {
		id,
		data,
		metadata_importance: 1,
		metadata_tokens: 3,
		metadata_status: 'pending',
		metadata_created_at: time.created,
	}
}

function evolution(id: string): EvolutionRecord {
	return {
		id,
		summary: `learned evolution ${id}`,
		reasoning: 'The settled observations changed the understanding.',
		significance: 'notable',
		created_at: time.committed,
	}
}

export function registerLearningStoreContract(api: TestApi, adapterName: string, createScenario: () => LearningStoreScenario): void {
	const { describe, it, expect } = api
	describe(`${adapterName} v2 learning commit`, () => {
		it('commits observer and synthesis stages without retaining consumed source text', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-observer', 'attempt-observer', ['source-input-1']) })
				const observerCommit = noChangeCommit('attempt-observer', 'work-observer', ['source-input-1'], 0)
				observerCommit.outcome = 'change'
				observerCommit.history.outcome = 'change'
				observerCommit.history.memory_revision = 1
				observerCommit.observations = { add: [observation('observation-1')], mark_processed_ids: [] }
				expect(await store.learning.commit(observerCommit)).toMatchObject({ status: 'committed', memory_revision: 1 })
				expect(await store.learning.commit(observerCommit)).toMatchObject({ status: 'committed', memory_revision: 1, deduplicated: true })
				const changedObserverIntent = structuredClone(observerCommit)
				changedObserverIntent.observations!.add[0]!.data = 'changed derived observation'
				expect(await store.learning.commit(changedObserverIntent)).toMatchObject({ status: 'conflict', reason: 'input-overlap' })
				expect(await store.pendingWork.list()).toEqual([])
				expect(await store.pendingInputs.list()).toEqual([])
				expect(await store.observations.get('observation-1')).toEqual(observation('observation-1'))
				expect(await store.memoryChanges.count()).toBe(0)

				await store.learning.enqueue({ work: { ...pending('work-synthesis', 'attempt-synthesis', ['observation-1']), inputs: undefined } })
				const synthesisCommit = changeCommit('attempt-synthesis', 'work-synthesis', ['observation-1'], 1)
				synthesisCommit.observations = { add: [], mark_processed_ids: ['observation-1'] }
				synthesisCommit.evolution_records = [evolution('evolution-1')]
				const result = await store.learning.commit(synthesisCommit)
				expect(result).toMatchObject({ status: 'committed', memory_revision: 2, deduplicated: false })
				expect((await store.observations.get('observation-1'))?.metadata_status).toBe('processed')
				expect((await store.understanding.get('current'))?.data).toBe('learned understanding attempt-synthesis')
				expect(await store.evolution.get('evolution-1')).toEqual(evolution('evolution-1'))
				expect(await store.learningHistory.count()).toBe(2)
				expect(await store.memoryChanges.count()).toBe(1)
				expect(await store.outbox.count()).toBe(1)
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('rolls back observations, understanding, evolution, history, and raw disposal together', async () => {
			const scenario = createScenario()
			let interrupt = false
			const options: LearningStoreOptions = {
				onCommitStage(stage) {
					if (interrupt && stage === 'before-complete') throw new Error('injected observation interruption')
				},
			}
			const store = scenario.create(options)
			try {
				const work = pending('work-observer', 'attempt-observer', ['source-input-1'])
				await store.learning.enqueue({ work })
				const commit = changeCommit('attempt-observer', 'work-observer', ['source-input-1'], 0)
				commit.observations = { add: [observation('observation-1')], mark_processed_ids: [] }
				commit.evolution_records = [evolution('evolution-1')]
				interrupt = true
				expect(await store.learning.commit(commit)).toEqual({ status: 'failure', error: 'injected observation interruption' })
				interrupt = false
				expect(await store.pendingWork.get(work.id)).toEqual(work)
				expect(await store.observations.get('observation-1')).toBeUndefined()
				expect(await store.understanding.get('current')).toBeUndefined()
				expect(await store.evolution.get('evolution-1')).toBeUndefined()
				expect(await store.learningHistory.get('history-attempt-observer')).toBeUndefined()
				expect((await store.learning.getRevisions()).memory_revision).toBe(0)

				await store.dispose()
				const reopened = scenario.reopen(options)
				expect(await reopened.learning.commit(commit)).toMatchObject({ status: 'committed', memory_revision: 1, deduplicated: false })
				expect(await reopened.learning.commit(commit)).toMatchObject({ status: 'committed', memory_revision: 1, deduplicated: true })
				expect(await reopened.pendingWork.get(work.id)).toBeUndefined()
				expect(await reopened.observations.get('observation-1')).toEqual(observation('observation-1'))
				await reopened.dispose()
			} finally {
				scenario.cleanup()
			}
		})

		it('settles only explicitly supplied pending observations without cosmetic change records', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await addObservation(store, 'observation-settled')
				await addObservation(store, 'observation-still-pending')
				await store.learning.enqueue({
					work: { ...pending('work-dismissal', 'attempt-dismissal', ['observation-settled']), inputs: undefined },
				})
				const commit = noChangeCommit('attempt-dismissal', 'work-dismissal', ['observation-settled'], 0)
				commit.outcome = 'change'
				commit.history.outcome = 'change'
				commit.history.memory_revision = 1
				commit.observations = { add: [], mark_processed_ids: ['observation-settled'] }
				expect(await store.learning.commit(commit)).toMatchObject({ status: 'committed', memory_revision: 1 })
				expect((await store.observations.get('observation-settled'))?.metadata_status).toBe('processed')
				expect((await store.observations.get('observation-still-pending'))?.metadata_status).toBe('pending')
				expect(await store.understanding.count()).toBe(0)
				expect(await store.memoryChanges.count()).toBe(0)
				expect(await store.outbox.count()).toBe(0)
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('rejects learned-record overwrite and invalid observation settlement without consuming work', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await addObservation(store, 'observation-existing')
				await store.learning.enqueue({ work: pending('work-add', 'attempt-add', ['source-add']) })
				const addCommit = changeCommit('attempt-add', 'work-add', ['source-add'], 0)
				addCommit.observations = { add: [observation('observation-existing', 'forged replacement')], mark_processed_ids: [] }
				expect(await store.learning.commit(addCommit)).toEqual({ status: 'failure', error: 'Observation observation-existing already exists' })
				expect(await store.pendingWork.get('work-add')).toBeDefined()

				await store.learning.enqueue({ work: { ...pending('work-settle', 'attempt-settle', ['observation-missing']), inputs: undefined } })
				const settleCommit = changeCommit('attempt-settle', 'work-settle', ['observation-missing'], 0)
				settleCommit.observations = { add: [], mark_processed_ids: ['observation-missing'] }
				expect(await store.learning.commit(settleCommit)).toEqual({ status: 'failure', error: 'Observation observation-missing is not pending' })
				expect(await store.pendingWork.get('work-settle')).toBeDefined()

				await store.evolution.add(evolution('evolution-existing'))
				await store.learning.enqueue({ work: pending('work-evolution', 'attempt-evolution', ['source-evolution']) })
				const evolutionCommit = changeCommit('attempt-evolution', 'work-evolution', ['source-evolution'], 0)
				evolutionCommit.evolution_records = [evolution('evolution-existing')]
				expect(await store.learning.commit(evolutionCommit)).toEqual({ status: 'failure', error: 'Evolution record evolution-existing already exists' })
				expect(await store.pendingWork.get('work-evolution')).toBeDefined()
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('moves only unresolved source text into residual work', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-parent', 'attempt-parent', ['input-a', 'input-b']) })
				const commit = noChangeCommit('attempt-parent', 'work-parent', ['input-a'], 0)
				commit.remaining_work = {
					id: 'work-residual', attempt_id: 'attempt-residual', input_ids: ['input-b'], status: 'pending',
					retry_count: 0, available_at: time.committed, created_at: time.committed, updated_at: time.committed,
				}
				expect(await store.learning.commit(commit)).toMatchObject({ status: 'no-change', remaining_work_id: 'work-residual' })
				expect(await store.pendingWork.get('work-parent')).toBeUndefined()
				expect(await store.pendingWork.get('work-residual')).toEqual({ ...commit.remaining_work, inputs: [{ id: 'input-b', text: 'temporary source text for input-b' }] })
				expect(await store.processedInputs.get('input-a')).toMatchObject({ attempt_id: 'attempt-parent' })
				expect(await store.pendingInputs.get('input-b')).toMatchObject({ pending_work_id: 'work-residual', attempt_id: 'attempt-residual' })
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('rejects caller-supplied residual source content', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-parent', 'attempt-parent', ['input-a', 'input-b']) })
				const commit = noChangeCommit('attempt-parent', 'work-parent', ['input-a'], 0)
				commit.remaining_work = {
					id: 'work-residual', attempt_id: 'attempt-residual', input_ids: ['input-b'], status: 'pending',
					retry_count: 0, available_at: time.committed, created_at: time.committed, updated_at: time.committed,
					inputs: [{ id: 'input-a', text: 'forged' }],
				} as never
				expect(await store.learning.commit(commit)).toEqual({ status: 'failure', error: 'remaining_work cannot supply source content' })
				expect(await store.pendingWork.get('work-parent')).toEqual(pending('work-parent', 'attempt-parent', ['input-a', 'input-b']))
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('rolls back learned state, consumption, and residual transfer on interruption', async () => {
			const scenario = createScenario()
			const store = scenario.create({ onCommitStage(stage) { if (stage === 'before-complete') throw new Error('injected interruption') } })
			try {
				await store.learning.enqueue({ work: pending('work-parent', 'attempt-parent', ['input-a', 'input-b']) })
				const commit = changeCommit('attempt-parent', 'work-parent', ['input-a'], 0)
				commit.remaining_work = {
					id: 'work-residual', attempt_id: 'attempt-residual', input_ids: ['input-b'], status: 'pending',
					retry_count: 0, available_at: time.committed, created_at: time.committed, updated_at: time.committed,
				}
				expect(await store.learning.commit(commit)).toEqual({ status: 'failure', error: 'injected interruption' })
				await store.dispose()
				const reopened = scenario.reopen()
				expect(await reopened.pendingWork.get('work-parent')).toEqual(pending('work-parent', 'attempt-parent', ['input-a', 'input-b']))
				expect(await reopened.pendingWork.get('work-residual')).toBeUndefined()
				expect(await reopened.understanding.count()).toBe(0)
				expect((await reopened.learning.getRevisions()).memory_revision).toBe(0)
				await reopened.dispose()
			} finally {
				scenario.cleanup()
			}
		})

		it('binds completed attempt replay to the full compact intent', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-1', 'attempt-1', ['input-1']) })
				const commit = changeCommit('attempt-1', 'work-1', ['input-1'], 0)
				expect(await store.learning.commit(commit)).toMatchObject({ status: 'committed', deduplicated: false })
				expect(await store.learning.commit(commit)).toMatchObject({ status: 'committed', deduplicated: true })
				const changed = structuredClone(commit)
				changed.history.explanation = 'different learned intent'
				expect(await store.learning.commit(changed)).toMatchObject({ status: 'conflict', reason: 'input-overlap' })
				expect((await store.learning.getRevisions()).memory_revision).toBe(1)
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('detects mixed processed and pending input overlap without mutation', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-a', 'attempt-a', ['input-a']) })
				await store.learning.commit(noChangeCommit('attempt-a', 'work-a', ['input-a'], 0))
				await store.learning.enqueue({ work: pending('work-b', 'attempt-b', ['input-b']) })
				expect(await store.learning.enqueue({ work: pending('work-mixed', 'attempt-mixed', ['input-a', 'input-b']) })).toEqual({ status: 'conflict', reason: 'partial-input-overlap' })
				expect(await store.pendingWork.get('work-mixed')).toBeUndefined()
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('snapshots caller input and stores only the explicit pending text shape', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				const work = pending('work-1', 'attempt-1', ['input-1'])
				;(work.inputs![0] as { id: string; text: string; extra?: string }).extra = 'must not persist'
				const enqueue = store.learning.enqueue({ work })
				work.inputs![0]!.text = 'mutated after enqueue call'
				await enqueue
				expect(await store.pendingWork.get('work-1')).toEqual(pending('work-1', 'attempt-1', ['input-1']))

				const commit = changeCommit('attempt-1', 'work-1', ['input-1'], 0)
				const original = structuredClone(commit)
				const committing = store.learning.commit(commit)
				commit.history.explanation = 'mutated after commit call'
				await committing
				expect((await store.learningHistory.get('history-attempt-1'))?.explanation).toBe('Learned a durable understanding.')
				expect(await store.learning.commit(original)).toMatchObject({ status: 'committed', deduplicated: true })
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})

		it('uses lease tokens to reject stale outbox settlement after reclaim', async () => {
			const scenario = createScenario()
			const store = scenario.create()
			try {
				await store.learning.enqueue({ work: pending('work-1', 'attempt-1', ['input-1']) })
				await store.learning.commit(changeCommit('attempt-1', 'work-1', ['input-1'], 0))
				await store.learning.claimOutbox({ consumer_id: 'consumer', lease_token: 'lease-one', now: time.claimed, lease_expires_at: time.lease, limit: 1 })
				await store.learning.claimOutbox({ consumer_id: 'consumer', lease_token: 'lease-two', now: time.reclaimed, lease_expires_at: time.secondLease, limit: 1 })
				expect(await store.learning.settleOutbox({ id: 'outbox-attempt-1', consumer_id: 'consumer', lease_token: 'lease-one', outcome: 'delivered', settled_at: time.settled })).toBeUndefined()
				expect(await store.learning.settleOutbox({ id: 'outbox-attempt-1', consumer_id: 'consumer', lease_token: 'lease-two', outcome: 'delivered', settled_at: time.settled })).toMatchObject({ status: 'delivered', attempts: 2 })
			} finally {
				await store.dispose()
				scenario.cleanup()
			}
		})
	})
}
