import type { BrainStore } from '../src/stores'
import {
	createSignalStateStore,
	type RecordAcceptedSignalInput,
	type SignalStatePolicy,
} from '../src/brain/signals'

interface TestApi {
	describe(name: string, body: () => void): void
	it(name: string, body: () => unknown | Promise<unknown>): void
	expect(value: unknown): {
		toBe(expected: unknown): void
		toEqual(expected: unknown): void
		toHaveLength(expected: number): void
		toMatchObject(expected: unknown): void
		toBeUndefined(): void
	}
}

export interface SignalStoreScenario {
	create(): BrainStore
	reopen(): BrainStore
	cleanup(): void
}

const time = {
	created: '2026-10-01T08:00:00.000Z',
	lease: '2026-10-01T08:01:00.000Z',
	complete: '2026-10-01T08:00:10.000Z',
	delivered: '2026-10-01T08:00:20.000Z',
	expired: '2026-10-01T09:00:00.000Z',
}

const basePolicy: SignalStatePolicy = {
	stateRecordId: 'signals-v1',
	maxPendingAssessments: 4,
	maxReceipts: 8,
	maxAcceptedSignals: 8,
	maxDedupRecords: 8,
	maxCooldownRecords: 8,
	maxDeliveries: 8,
	maxSerializedCharacters: 100_000,
	exactDedupRetentionMs: 120_000,
	cooldownMs: 60_000,
	receiptRetentionMs: 120_000,
	acceptedRetentionMs: 120_000,
	deliveredRetentionMs: 30_000,
}

const assessment = {
	id: 'assessment-1',
	policy: { id: 'signal-policy', version: '1' },
	cooldownScopeId: 'project-risk',
	scopedChanges: [
		{ lensId: 'project-a', changeId: 'change-shared-a' },
		{ lensId: 'project-b', changeId: 'change-shared-b' },
	],
	availableAt: time.created,
	createdAt: time.created,
} as const

function accepted(overrides: Partial<RecordAcceptedSignalInput> = {}): RecordAcceptedSignalInput {
	return {
		assessmentId: assessment.id,
		consumerId: 'assessor',
		leaseToken: 'assessment-lease',
		signalId: 'signal-1',
		deliveryId: 'delivery-1',
		proposal: {
			meaning: 'Project A and Project B share a newly changed Team X dependency.',
			materialChange: 'Both current plans now depend on the same team.',
			affectedLensIds: ['project-a', 'project-b'],
			affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }, { lensId: 'project-b', memoryId: 'memory-b' }],
			scopedChanges: assessment.scopedChanges,
			policy: assessment.policy,
			cooldownScopeId: assessment.cooldownScopeId,
		},
		settledSilentChanges: [],
		completedAt: time.complete,
		deliveryAvailableAt: time.complete,
		...overrides,
	}
}

async function claimAssessment(store: ReturnType<typeof createSignalStateStore>, token = 'assessment-lease') {
	return store.claimAssessments({
		consumerId: 'assessor',
		leaseToken: token,
		now: time.created,
		leaseExpiresAt: time.lease,
		limit: 1,
	})
}

export function registerSignalStoreContract(api: TestApi, name: string, scenario: () => SignalStoreScenario): void {
	api.describe(name, () => {
		api.it('atomically records an accepted signal, exact dedup, and leased delivery across reopen', async () => {
			const fixture = scenario()
			let brain = fixture.create()
			try {
				let signals = createSignalStateStore({ store: brain, policy: basePolicy })
				api.expect(await signals.enqueueAssessment(assessment)).toEqual({ status: 'queued' })
				api.expect(await claimAssessment(signals)).toHaveLength(1)
				api.expect(await signals.recordAccepted(accepted())).toEqual({ status: 'recorded', signalId: 'signal-1' })
				api.expect(await signals.recordAccepted(accepted())).toEqual({ status: 'deduplicated', signalId: 'signal-1' })

				await brain.dispose()
				brain = fixture.reopen()
				signals = createSignalStateStore({ store: brain, policy: basePolicy })
				const snapshot = await signals.snapshot()
				api.expect(snapshot.acceptedSignals).toHaveLength(1)
				api.expect(snapshot.dedup).toHaveLength(1)
				api.expect(snapshot.receipts).toHaveLength(1)
				const delivery = await signals.claimDeliveries({ consumerId: 'delivery-worker', leaseToken: 'delivery-lease', now: time.complete, leaseExpiresAt: time.lease, limit: 1 })
				api.expect(delivery).toHaveLength(1)
				api.expect(await signals.settleDelivery({ id: 'delivery-1', consumerId: 'wrong-worker', leaseToken: 'delivery-lease', outcome: 'delivered', settledAt: time.delivered })).toBeUndefined()
				api.expect(await signals.settleDelivery({ id: 'delivery-1', consumerId: 'delivery-worker', leaseToken: 'delivery-lease', outcome: 'delivered', settledAt: time.delivered })).toMatchObject({ status: 'delivered', attempts: 1 })
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('rejects immutable assessment reuse and preserves leased work on result-capacity backpressure', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: { ...basePolicy, maxAcceptedSignals: 1, maxDeliveries: 1 } })
				api.expect(await signals.enqueueAssessment(assessment)).toEqual({ status: 'queued' })
				api.expect(await signals.enqueueAssessment({ ...assessment, scopedChanges: [{ lensId: 'different', changeId: 'change' }] })).toEqual({ status: 'conflict', reason: 'assessment-id-reused' })
				await claimAssessment(signals)
				api.expect(await signals.recordAccepted(accepted())).toMatchObject({ status: 'recorded' })

				const second = { ...assessment, id: 'assessment-2', cooldownScopeId: 'other-capacity-scope', scopedChanges: [{ lensId: 'project-c', changeId: 'change-c' }] }
				api.expect(await signals.enqueueAssessment(second)).toEqual({ status: 'queued' })
				await claimAssessment(signals, 'second-lease')
				const result = await signals.recordAccepted(accepted({
					assessmentId: second.id, leaseToken: 'second-lease', signalId: 'signal-2', deliveryId: 'delivery-2',
					proposal: { ...accepted().proposal, cooldownScopeId: second.cooldownScopeId, affectedLensIds: ['project-c'], affectedMemories: [{ lensId: 'project-c', memoryId: 'memory-c' }], scopedChanges: second.scopedChanges },
				}))
				api.expect(result).toEqual({ status: 'backpressure', reason: 'accepted-capacity' })
				const snapshot = await signals.snapshot()
				api.expect(snapshot.pendingAssessments.find((item) => item.id === second.id)).toMatchObject({ status: 'assessing', leaseToken: 'second-lease' })
				api.expect(snapshot.acceptedSignals).toHaveLength(1)
				api.expect(snapshot.deliveries).toHaveLength(1)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('deduplicates only the same policy, declared scope, and scoped change set', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: basePolicy })
				await signals.enqueueAssessment(assessment)
				await claimAssessment(signals)
				await signals.recordAccepted(accepted())

				const same = { ...assessment, id: 'assessment-same' }
				await signals.enqueueAssessment(same)
				await claimAssessment(signals, 'same-lease')
				api.expect(await signals.recordAccepted(accepted({ assessmentId: same.id, leaseToken: 'same-lease', signalId: 'unused-signal', deliveryId: 'unused-delivery' }))).toEqual({ status: 'deduplicated', signalId: 'signal-1' })

				const otherScope = { ...assessment, id: 'assessment-other', cooldownScopeId: 'other-project-risk' }
				await signals.enqueueAssessment(otherScope)
				await claimAssessment(signals, 'other-lease')
				api.expect(await signals.recordAccepted(accepted({
					assessmentId: otherScope.id, leaseToken: 'other-lease', signalId: 'signal-other', deliveryId: 'delivery-other',
					proposal: { ...accepted().proposal, cooldownScopeId: otherScope.cooldownScopeId },
				}))).toEqual({ status: 'recorded', signalId: 'signal-other' })
				api.expect((await signals.snapshot()).acceptedSignals).toHaveLength(2)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('applies cooldown to new changes only within the declared scope', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: basePolicy })
				await signals.enqueueAssessment(assessment)
				await claimAssessment(signals)
				await signals.recordAccepted(accepted())
				const later = { ...assessment, id: 'assessment-later', scopedChanges: [{ lensId: 'project-a', changeId: 'new-change' }] }
				await signals.enqueueAssessment(later)
				await claimAssessment(signals, 'later-lease')
				api.expect(await signals.recordAccepted(accepted({
					assessmentId: later.id, leaseToken: 'later-lease', signalId: 'signal-later', deliveryId: 'delivery-later',
					proposal: { ...accepted().proposal, affectedLensIds: ['project-a'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }], scopedChanges: later.scopedChanges },
				}))).toEqual({ status: 'suppressed', signalId: 'signal-1', reason: 'cooldown' })
				api.expect((await signals.snapshot()).pendingAssessments).toHaveLength(0)
				api.expect((await signals.snapshot()).acceptedSignals).toHaveLength(1)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('does not prune pending assessments or undelivered accepted signals', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: { ...basePolicy, exactDedupRetentionMs: 0, cooldownMs: 0, acceptedRetentionMs: 0, receiptRetentionMs: 0, deliveredRetentionMs: 0 } })
				await signals.enqueueAssessment(assessment)
				await claimAssessment(signals)
				await signals.recordAccepted(accepted())
				await signals.enqueueAssessment({ ...assessment, id: 'still-unassessed', scopedChanges: [{ lensId: 'project-z', changeId: 'change-z' }] })
				const snapshot = await signals.prune(time.expired)
				api.expect(snapshot.pendingAssessments).toHaveLength(1)
				api.expect(snapshot.acceptedSignals).toHaveLength(1)
				api.expect(snapshot.deliveries).toHaveLength(1)
				api.expect(snapshot.dedup).toHaveLength(1)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('requires an explicit full change partition before clearing assessed work', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: basePolicy })
				await signals.enqueueAssessment(assessment)
				await claimAssessment(signals)
				const partial = accepted({
					proposal: {
						...accepted().proposal,
						affectedLensIds: ['project-a'],
						affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }],
						scopedChanges: [assessment.scopedChanges[0]],
					},
				})
				api.expect(await signals.recordAccepted(partial)).toEqual({ status: 'conflict', reason: 'accepted outcome must explicitly settle every assessed change exactly once' })
				api.expect((await signals.snapshot()).pendingAssessments).toHaveLength(1)
				api.expect(await signals.recordAccepted({ ...partial, settledSilentChanges: [assessment.scopedChanges[1]] })).toEqual({ status: 'recorded', signalId: 'signal-1' })
				api.expect((await signals.snapshot()).pendingAssessments).toHaveLength(0)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('requires explicit full settlement for a silent outcome', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: basePolicy })
				await signals.enqueueAssessment(assessment)
				await claimAssessment(signals)
				api.expect(await signals.recordSilent({
					assessmentId: assessment.id, consumerId: 'assessor', leaseToken: 'assessment-lease',
					settledChanges: [assessment.scopedChanges[0]], completedAt: time.complete,
				})).toEqual({ status: 'conflict', reason: 'silent outcome must explicitly settle every assessed change' })
				api.expect((await signals.snapshot()).pendingAssessments).toHaveLength(1)
				api.expect(await signals.recordSilent({
					assessmentId: assessment.id, consumerId: 'assessor', leaseToken: 'assessment-lease',
					settledChanges: assessment.scopedChanges, completedAt: time.complete,
				})).toEqual({ status: 'recorded' })
				api.expect((await signals.snapshot()).pendingAssessments).toHaveLength(0)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('snapshots mutable policy, assessment, and accepted-result inputs before queued work', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const mutablePolicy = structuredClone(basePolicy)
				const signals = createSignalStateStore({ store: brain, policy: mutablePolicy })
				mutablePolicy.stateRecordId = 'mutated-state-id'
				mutablePolicy.maxPendingAssessments = 1
				const mutableAssessment = structuredClone(assessment)
				const enqueue = signals.enqueueAssessment(mutableAssessment)
				mutableAssessment.scopedChanges[0]!.lensId = 'mutated-lens'
				api.expect(await enqueue).toEqual({ status: 'queued' })
				await claimAssessment(signals)
				const mutableAccepted = structuredClone(accepted())
				const recording = signals.recordAccepted(mutableAccepted)
				mutableAccepted.proposal.meaning = 'mutated after call'
				api.expect(await recording).toEqual({ status: 'recorded', signalId: 'signal-1' })
				const snapshot = await signals.snapshot()
				api.expect(snapshot.acceptedSignals[0]).toMatchObject({ meaning: 'Project A and Project B share a newly changed Team X dependency.', scopedChanges: assessment.scopedChanges })
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})

		api.it('rejects oversized lease and error mutations without changing durable state', async () => {
			const fixture = scenario()
			const brain = fixture.create()
			try {
				const signals = createSignalStateStore({ store: brain, policy: basePolicy })
				await signals.enqueueAssessment(assessment)
				let before = await signals.snapshot()
				let bounded = createSignalStateStore({ store: brain, policy: { ...basePolicy, maxSerializedCharacters: JSON.stringify(before).length + 20 } })
				let failure: unknown
				try {
					await bounded.claimAssessments({ consumerId: 'assessor', leaseToken: 'x'.repeat(1000), now: time.created, leaseExpiresAt: time.lease, limit: 1 })
				} catch (error) { failure = error }
				api.expect(failure).toMatchObject({ name: 'SignalStateCapacityError' })
				api.expect(await signals.snapshot()).toEqual(before)

				await claimAssessment(signals)
				before = await signals.snapshot()
				bounded = createSignalStateStore({ store: brain, policy: { ...basePolicy, maxSerializedCharacters: JSON.stringify(before).length + 20 } })
				failure = undefined
				try {
					await bounded.retryAssessment({ assessmentId: assessment.id, consumerId: 'assessor', leaseToken: 'assessment-lease', retryAt: '2026-10-01T08:00:30.000Z', settledAt: time.delivered, error: 'x'.repeat(1000) })
				} catch (error) { failure = error }
				api.expect(failure).toMatchObject({ name: 'SignalStateCapacityError' })
				api.expect(await signals.snapshot()).toEqual(before)

				await signals.recordAccepted(accepted())
				before = await signals.snapshot()
				bounded = createSignalStateStore({ store: brain, policy: { ...basePolicy, maxSerializedCharacters: JSON.stringify(before).length + 20 } })
				failure = undefined
				try {
					await bounded.claimDeliveries({ consumerId: 'delivery-worker', leaseToken: 'x'.repeat(1000), now: time.complete, leaseExpiresAt: time.lease, limit: 1 })
				} catch (error) { failure = error }
				api.expect(failure).toMatchObject({ name: 'SignalStateCapacityError' })
				api.expect(await signals.snapshot()).toEqual(before)

				await signals.claimDeliveries({ consumerId: 'delivery-worker', leaseToken: 'delivery-lease', now: time.complete, leaseExpiresAt: time.lease, limit: 1 })
				before = await signals.snapshot()
				bounded = createSignalStateStore({ store: brain, policy: { ...basePolicy, maxSerializedCharacters: JSON.stringify(before).length + 20 } })
				failure = undefined
				try {
					await bounded.settleDelivery({ id: 'delivery-1', consumerId: 'delivery-worker', leaseToken: 'delivery-lease', outcome: 'retry', settledAt: time.delivered, retryAt: '2026-10-01T08:00:30.000Z', error: 'x'.repeat(1000) })
				} catch (error) { failure = error }
				api.expect(failure).toMatchObject({ name: 'SignalStateCapacityError' })
				api.expect(await signals.snapshot()).toEqual(before)
			} finally {
				await brain.dispose()
				fixture.cleanup()
			}
		})
	})
}
