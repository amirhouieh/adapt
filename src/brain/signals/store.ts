import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AtomicBrainStore } from '../../stores'
import type {
	AcceptedSignal,
	ClaimSignalWorkInput,
	EnqueueSignalAssessmentInput,
	EnqueueSignalAssessmentResult,
	PendingSignalAssessment,
	RecordAcceptedSignalInput,
	RecordSignalOutcomeResult,
	RetrySignalAssessmentInput,
	ScopedChangeIdentity,
	SettleSignalDeliveryInput,
	SignalAssessmentReceipt,
	SignalCooldownRecord,
	SignalDedupRecord,
	SignalDeliveryRecord,
	SignalStatePolicy,
	SignalStateSnapshot,
	SignalStateStore,
	SignalStateStoreInput,
} from './contracts'

const scopedChangeSchema = z
	.object({ lensId: z.string().min(1), changeId: z.string().min(1) })
	.strict()
const policyRefSchema = z
	.object({ id: z.string().min(1), version: z.string().min(1) })
	.strict()
const pendingSchema = z
	.object({
		id: z.string().min(1),
		intentDigest: z.string().min(1),
		policy: policyRefSchema,
		cooldownScopeId: z.string().min(1),
		scopedChanges: z.array(scopedChangeSchema).min(1),
		status: z.enum(['pending', 'assessing']),
		attempts: z.number().int().nonnegative(),
		availableAt: z.string().min(1),
		leaseOwner: z.string().min(1).optional(),
		leaseToken: z.string().min(1).optional(),
		leaseExpiresAt: z.string().min(1).optional(),
		lastError: z.string().optional(),
		createdAt: z.string().min(1),
		updatedAt: z.string().min(1),
	})
	.strict()
const acceptedSchema = z
	.object({
		id: z.string().min(1),
		assessmentId: z.string().min(1),
		meaning: z.string().min(1),
		materialChange: z.string().min(1),
		affectedLensIds: z.array(z.string().min(1)).min(1),
		affectedMemories: z
			.array(
				z
					.object({ lensId: z.string().min(1), memoryId: z.string().min(1) })
					.strict(),
			)
			.min(1),
		scopedChanges: z.array(scopedChangeSchema).min(1),
		policy: policyRefSchema,
		cooldownScopeId: z.string().min(1),
		createdAt: z.string().min(1),
	})
	.strict()
const receiptSchema = z
	.object({
		id: z.string().min(1),
		intentDigest: z.string().min(1),
		outcomeDigest: z.string().min(1),
		outcome: z.enum(['accepted', 'silent', 'suppressed']),
		signalId: z.string().min(1).optional(),
		completedAt: z.string().min(1),
	})
	.strict()
const dedupSchema = z
	.object({
		key: z.string().min(1),
		policy: policyRefSchema,
		cooldownScopeId: z.string().min(1),
		scopedChanges: z.array(scopedChangeSchema).min(1),
		signalId: z.string().min(1),
		createdAt: z.string().min(1),
		expiresAt: z.string().min(1),
	})
	.strict()
const cooldownSchema = z
	.object({
		key: z.string().min(1),
		policy: policyRefSchema,
		cooldownScopeId: z.string().min(1),
		signalId: z.string().min(1),
		createdAt: z.string().min(1),
		expiresAt: z.string().min(1),
	})
	.strict()
const deliverySchema = z
	.object({
		id: z.string().min(1),
		signalId: z.string().min(1),
		status: z.enum(['pending', 'delivering', 'delivered', 'discarded']),
		attempts: z.number().int().nonnegative(),
		availableAt: z.string().min(1),
		leaseOwner: z.string().min(1).optional(),
		leaseToken: z.string().min(1).optional(),
		leaseExpiresAt: z.string().min(1).optional(),
		lastError: z.string().optional(),
		createdAt: z.string().min(1),
		updatedAt: z.string().min(1),
	})
	.strict()
const snapshotSchema = z
	.object({
		version: z.literal(1),
		pendingAssessments: z.array(pendingSchema),
		receipts: z.array(receiptSchema),
		acceptedSignals: z.array(acceptedSchema),
		dedup: z.array(dedupSchema),
		cooldowns: z.array(cooldownSchema),
		deliveries: z.array(deliverySchema),
	})
	.strict()

function emptySnapshot(): SignalStateSnapshot {
	return {
		version: 1,
		pendingAssessments: [],
		receipts: [],
		acceptedSignals: [],
		dedup: [],
		cooldowns: [],
		deliveries: [],
	}
}

function timestamp(value: string, name: string): void {
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
		throw new Error(`${name} must be a normalized UTC ISO timestamp`)
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${name} must be a positive safe integer`)
}

function nonnegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a nonnegative safe integer`)
}

function validatePolicy(policy: SignalStatePolicy): void {
	if (!policy.stateRecordId) throw new Error('stateRecordId is required')
	positiveInteger(policy.maxPendingAssessments, 'maxPendingAssessments')
	positiveInteger(policy.maxReceipts, 'maxReceipts')
	positiveInteger(policy.maxAcceptedSignals, 'maxAcceptedSignals')
	positiveInteger(policy.maxDedupRecords, 'maxDedupRecords')
	positiveInteger(policy.maxCooldownRecords, 'maxCooldownRecords')
	positiveInteger(policy.maxDeliveries, 'maxDeliveries')
	positiveInteger(policy.maxSerializedCharacters, 'maxSerializedCharacters')
	nonnegativeInteger(policy.exactDedupRetentionMs, 'exactDedupRetentionMs')
	nonnegativeInteger(policy.cooldownMs, 'cooldownMs')
	nonnegativeInteger(policy.receiptRetentionMs, 'receiptRetentionMs')
	nonnegativeInteger(policy.acceptedRetentionMs, 'acceptedRetentionMs')
	nonnegativeInteger(policy.deliveredRetentionMs, 'deliveredRetentionMs')
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonical(record[key])]),
		)
	}
	return value
}

function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

function sortChanges(
	changes: readonly ScopedChangeIdentity[],
): ScopedChangeIdentity[] {
	return [...changes].sort(
		(left, right) =>
			left.lensId.localeCompare(right.lensId) ||
			left.changeId.localeCompare(right.changeId),
	)
}

function scopedChangeKey(change: ScopedChangeIdentity): string {
	return JSON.stringify([change.lensId, change.changeId])
}

function requireChanges(
	changes: readonly ScopedChangeIdentity[],
): ScopedChangeIdentity[] {
	if (changes.length === 0)
		throw new Error('at least one scoped change is required')
	const sorted = sortChanges(changes)
	for (const change of sorted)
		if (!change.lensId || !change.changeId)
			throw new Error('scoped change identities are required')
	for (let index = 1; index < sorted.length; index += 1) {
		const previous = sorted[index - 1]
		const current = sorted[index]
		if (
			previous &&
			current &&
			previous.lensId === current.lensId &&
			previous.changeId === current.changeId
		)
			throw new Error('scoped change identities must be unique')
	}
	return sorted
}

function assessmentIntent(input: EnqueueSignalAssessmentInput): unknown {
	return {
		policy: input.policy,
		cooldownScopeId: input.cooldownScopeId,
		scopedChanges: sortChanges(input.scopedChanges),
	}
}

function proposalIntent(input: RecordAcceptedSignalInput): unknown {
	return {
		signalId: input.signalId,
		deliveryId: input.deliveryId,
		proposal: {
			...input.proposal,
			scopedChanges: sortChanges(input.proposal.scopedChanges),
		},
		settledSilentChanges: sortChanges(input.settledSilentChanges),
	}
}

function plusMilliseconds(value: string, milliseconds: number): string {
	return new Date(Date.parse(value) + milliseconds).toISOString()
}

function exceedsStateSize(
	snapshot: SignalStateSnapshot,
	policy: SignalStatePolicy,
): boolean {
	return JSON.stringify(snapshot).length > policy.maxSerializedCharacters
}

function hasLiveDelivery(
	snapshot: SignalStateSnapshot,
	signalId: string,
): boolean {
	return snapshot.deliveries.some(
		(delivery) =>
			delivery.signalId === signalId &&
			(delivery.status === 'pending' || delivery.status === 'delivering'),
	)
}

function pruneSnapshot(
	snapshot: SignalStateSnapshot,
	now: string,
	policy: SignalStatePolicy,
): SignalStateSnapshot {
	const nowMs = Date.parse(now)
	const deliveries = snapshot.deliveries.filter((delivery) => {
		if (delivery.status === 'pending' || delivery.status === 'delivering')
			return true
		return nowMs < Date.parse(delivery.updatedAt) + policy.deliveredRetentionMs
	})
	const liveSignalIds = new Set(
		deliveries
			.filter(
				(delivery) =>
					delivery.status === 'pending' || delivery.status === 'delivering',
			)
			.map((delivery) => delivery.signalId),
	)
	const dedup = snapshot.dedup.filter(
		(record) =>
			Date.parse(record.expiresAt) > nowMs ||
			liveSignalIds.has(record.signalId),
	)
	const cooldowns = snapshot.cooldowns.filter(
		(record) =>
			Date.parse(record.expiresAt) > nowMs ||
			liveSignalIds.has(record.signalId),
	)
	const dedupSignalIds = new Set(dedup.map((record) => record.signalId))
	const cooldownSignalIds = new Set(cooldowns.map((record) => record.signalId))
	const acceptedSignals = snapshot.acceptedSignals.filter(
		(signal) =>
			liveSignalIds.has(signal.id) ||
			dedupSignalIds.has(signal.id) ||
			cooldownSignalIds.has(signal.id) ||
			nowMs < Date.parse(signal.createdAt) + policy.acceptedRetentionMs,
	)
	const acceptedIds = new Set(acceptedSignals.map((signal) => signal.id))
	const receipts = snapshot.receipts.filter(
		(receipt) =>
			acceptedIds.has(receipt.signalId ?? '') ||
			nowMs < Date.parse(receipt.completedAt) + policy.receiptRetentionMs,
	)
	return {
		...snapshot,
		receipts,
		acceptedSignals,
		dedup,
		cooldowns,
		deliveries,
	}
}

function stateWith(
	snapshot: SignalStateSnapshot,
	changes: Partial<SignalStateSnapshot>,
): SignalStateSnapshot {
	return { ...snapshot, ...changes, version: 1 }
}

function readAtomic(
	store: AtomicBrainStore,
	recordId: string,
): SignalStateSnapshot {
	const record = store.state.get(recordId)
	return record ? parseSnapshot(record.value) : emptySnapshot()
}

export class SignalStateCapacityError extends Error {
	constructor() {
		super('signal state exceeds maxSerializedCharacters')
		this.name = 'SignalStateCapacityError'
	}
}

function writeAtomic(
	store: AtomicBrainStore,
	recordId: string,
	snapshot: SignalStateSnapshot,
	updatedAt: string,
	policy: SignalStatePolicy,
): void {
	if (exceedsStateSize(snapshot, policy)) throw new SignalStateCapacityError()
	const existing = store.state.get(recordId)
	if (existing)
		store.state.update(recordId, { value: snapshot, updated_at: updatedAt })
	else store.state.add({ id: recordId, value: snapshot, updated_at: updatedAt })
}

function ensureLease(
	record: PendingSignalAssessment,
	consumerId: string,
	leaseToken: string,
): boolean {
	return (
		record.status === 'assessing' &&
		record.leaseOwner === consumerId &&
		record.leaseToken === leaseToken
	)
}

function resultCapacity(
	snapshot: SignalStateSnapshot,
	policy: SignalStatePolicy,
): RecordSignalOutcomeResult | undefined {
	if (snapshot.receipts.length > policy.maxReceipts)
		return { status: 'backpressure', reason: 'receipt-capacity' }
	if (snapshot.acceptedSignals.length > policy.maxAcceptedSignals)
		return { status: 'backpressure', reason: 'accepted-capacity' }
	if (snapshot.dedup.length > policy.maxDedupRecords)
		return { status: 'backpressure', reason: 'dedup-capacity' }
	if (snapshot.cooldowns.length > policy.maxCooldownRecords)
		return { status: 'backpressure', reason: 'cooldown-capacity' }
	if (snapshot.deliveries.length > policy.maxDeliveries)
		return { status: 'backpressure', reason: 'delivery-capacity' }
	if (exceedsStateSize(snapshot, policy))
		return { status: 'backpressure', reason: 'state-size' }
	return undefined
}

export function createSignalStateStore(
	input: SignalStateStoreInput,
): SignalStateStore {
	validatePolicy(input.policy)
	const store = input.store
	const policy = Object.freeze(structuredClone(input.policy))

	return {
		async enqueueAssessment(
			assessment,
		): Promise<EnqueueSignalAssessmentResult> {
			const stable = structuredClone(assessment)
			if (
				!stable.id ||
				!stable.policy.id ||
				!stable.policy.version ||
				!stable.cooldownScopeId
			)
				throw new Error(
					'assessment identity, policy, and cooldown scope are required',
				)
			timestamp(stable.availableAt, 'availableAt')
			timestamp(stable.createdAt, 'createdAt')
			const scopedChanges = requireChanges(stable.scopedChanges)
			const intentDigest = digest(
				assessmentIntent({ ...stable, scopedChanges }),
			)
			return store.runAtomic((atomic) => {
				const current = pruneSnapshot(
					readAtomic(atomic, policy.stateRecordId),
					stable.createdAt,
					policy,
				)
				const existing = current.pendingAssessments.find(
					(record) => record.id === stable.id,
				)
				const receipt = current.receipts.find(
					(record) => record.id === stable.id,
				)
				if (existing || receipt)
					return (existing?.intentDigest ?? receipt?.intentDigest) ===
						intentDigest
						? { status: 'deduplicated' }
						: { status: 'conflict', reason: 'assessment-id-reused' }
				if (current.pendingAssessments.length >= policy.maxPendingAssessments)
					return { status: 'backpressure', reason: 'pending-capacity' }
				const pending: PendingSignalAssessment = {
					id: stable.id,
					intentDigest,
					policy: stable.policy,
					cooldownScopeId: stable.cooldownScopeId,
					scopedChanges,
					status: 'pending',
					attempts: 0,
					availableAt: stable.availableAt,
					createdAt: stable.createdAt,
					updatedAt: stable.createdAt,
				}
				const next = stateWith(current, {
					pendingAssessments: [...current.pendingAssessments, pending],
				})
				if (exceedsStateSize(next, policy))
					return { status: 'backpressure', reason: 'state-size' }
				writeAtomic(
					atomic,
					policy.stateRecordId,
					next,
					stable.createdAt,
					policy,
				)
				return { status: 'queued' }
			})
		},

		async claimAssessments(claim): Promise<readonly PendingSignalAssessment[]> {
			const stable = structuredClone(claim)
			validateClaim(stable)
			return store.runAtomic((atomic) => {
				const current = pruneSnapshot(
					readAtomic(atomic, policy.stateRecordId),
					stable.now,
					policy,
				)
				const selected = current.pendingAssessments
					.filter(
						(record) =>
							(record.status === 'pending' &&
								record.availableAt <= stable.now) ||
							(record.status === 'assessing' &&
								record.leaseExpiresAt !== undefined &&
								record.leaseExpiresAt <= stable.now),
					)
					.slice(0, stable.limit)
				const selectedIds = new Set(selected.map((record) => record.id))
				const pendingAssessments = current.pendingAssessments.map(
					(record): PendingSignalAssessment =>
						selectedIds.has(record.id)
							? {
									...record,
									status: 'assessing',
									attempts: record.attempts + 1,
									leaseOwner: stable.consumerId,
									leaseToken: stable.leaseToken,
									leaseExpiresAt: stable.leaseExpiresAt,
									updatedAt: stable.now,
								}
							: record,
				)
				const next = stateWith(current, { pendingAssessments })
				writeAtomic(atomic, policy.stateRecordId, next, stable.now, policy)
				return pendingAssessments.filter((record) => selectedIds.has(record.id))
			})
		},

		async recordAccepted(accepted): Promise<RecordSignalOutcomeResult> {
			const stable = structuredClone(accepted)
			validateAccepted(stable)
			return store.runAtomic((atomic) => {
				const current = pruneSnapshot(
					readAtomic(atomic, policy.stateRecordId),
					stable.completedAt,
					policy,
				)
				const outcomeDigest = digest(proposalIntent(stable))
				const receipt = current.receipts.find(
					(record) => record.id === stable.assessmentId,
				)
				if (receipt) {
					if (receipt.outcomeDigest !== outcomeDigest)
						return {
							status: 'conflict',
							reason: 'assessment outcome differs from recorded intent',
						}
					if (receipt.outcome === 'accepted')
						return { status: 'deduplicated', signalId: receipt.signalId }
					if (receipt.outcome === 'suppressed' && receipt.signalId)
						return {
							status: 'suppressed',
							signalId: receipt.signalId,
							reason: 'cooldown',
						}
					return {
						status: 'conflict',
						reason: 'assessment outcome differs from recorded intent',
					}
				}
				const pending = current.pendingAssessments.find(
					(record) => record.id === stable.assessmentId,
				)
				if (
					!pending ||
					!ensureLease(pending, stable.consumerId, stable.leaseToken)
				)
					return { status: 'conflict', reason: 'assessment lease is not owned' }
				if (
					pending.policy.id !== stable.proposal.policy.id ||
					pending.policy.version !== stable.proposal.policy.version ||
					pending.cooldownScopeId !== stable.proposal.cooldownScopeId
				)
					return {
						status: 'conflict',
						reason: 'proposal policy or cooldown scope differs from assessment',
					}
				const proposalChanges = requireChanges(stable.proposal.scopedChanges)
				const silentChanges =
					stable.settledSilentChanges.length === 0
						? []
						: requireChanges(stable.settledSilentChanges)
				if (
					proposalChanges.some(
						(change) =>
							!pending.scopedChanges.some(
								(item) =>
									item.lensId === change.lensId &&
									item.changeId === change.changeId,
							),
					)
				)
					return {
						status: 'conflict',
						reason: 'proposal references changes outside assessment',
					}
				const settledKeys = [...proposalChanges, ...silentChanges].map(
					scopedChangeKey,
				)
				if (
					new Set(settledKeys).size !== settledKeys.length ||
					settledKeys.length !== pending.scopedChanges.length ||
					pending.scopedChanges.some(
						(change) => !settledKeys.includes(scopedChangeKey(change)),
					)
				)
					return {
						status: 'conflict',
						reason:
							'accepted outcome must explicitly settle every assessed change exactly once',
					}

				const dedupKey = digest({
					policy: pending.policy,
					cooldownScopeId: pending.cooldownScopeId,
					scopedChanges: proposalChanges,
				})
				const cooldownKey = digest({
					policy: pending.policy,
					cooldownScopeId: pending.cooldownScopeId,
				})
				const duplicate = current.dedup.find(
					(record) =>
						record.key === dedupKey &&
						(record.expiresAt > stable.completedAt ||
							hasLiveDelivery(current, record.signalId)),
				)
				const baseReceipt: SignalAssessmentReceipt = {
					id: pending.id,
					intentDigest: pending.intentDigest,
					outcomeDigest,
					outcome: 'accepted',
					signalId: duplicate?.signalId ?? stable.signalId,
					completedAt: stable.completedAt,
				}
				if (duplicate) {
					const next = stateWith(current, {
						pendingAssessments: current.pendingAssessments.filter(
							(record) => record.id !== pending.id,
						),
						receipts: [...current.receipts, baseReceipt],
					})
					const capacity = resultCapacity(next, policy)
					if (capacity) return capacity
					writeAtomic(
						atomic,
						policy.stateRecordId,
						next,
						stable.completedAt,
						policy,
					)
					return { status: 'deduplicated', signalId: duplicate.signalId }
				}
				const cooldown = current.cooldowns.find(
					(record) =>
						record.key === cooldownKey &&
						(record.expiresAt > stable.completedAt ||
							hasLiveDelivery(current, record.signalId)),
				)
				if (cooldown) {
					const suppressedReceipt: SignalAssessmentReceipt = {
						...baseReceipt,
						outcome: 'suppressed',
						signalId: cooldown.signalId,
					}
					const next = stateWith(current, {
						pendingAssessments: current.pendingAssessments.filter(
							(record) => record.id !== pending.id,
						),
						receipts: [...current.receipts, suppressedReceipt],
					})
					const capacity = resultCapacity(next, policy)
					if (capacity) return capacity
					writeAtomic(
						atomic,
						policy.stateRecordId,
						next,
						stable.completedAt,
						policy,
					)
					return {
						status: 'suppressed',
						signalId: cooldown.signalId,
						reason: 'cooldown',
					}
				}
				if (
					current.acceptedSignals.some(
						(record) => record.id === stable.signalId,
					)
				)
					return { status: 'conflict', reason: 'signal id already exists' }
				if (
					current.deliveries.some((record) => record.id === stable.deliveryId)
				)
					return { status: 'conflict', reason: 'delivery id already exists' }
				const signalRecord: AcceptedSignal = {
					...stable.proposal,
					scopedChanges: proposalChanges,
					id: stable.signalId,
					assessmentId: stable.assessmentId,
					createdAt: stable.completedAt,
				}
				const dedupRecord: SignalDedupRecord = {
					key: dedupKey,
					policy: pending.policy,
					cooldownScopeId: pending.cooldownScopeId,
					scopedChanges: proposalChanges,
					signalId: stable.signalId,
					createdAt: stable.completedAt,
					expiresAt: plusMilliseconds(
						stable.completedAt,
						policy.exactDedupRetentionMs,
					),
				}
				const cooldownRecord: SignalCooldownRecord = {
					key: cooldownKey,
					policy: pending.policy,
					cooldownScopeId: pending.cooldownScopeId,
					signalId: stable.signalId,
					createdAt: stable.completedAt,
					expiresAt: plusMilliseconds(stable.completedAt, policy.cooldownMs),
				}
				const delivery: SignalDeliveryRecord = {
					id: stable.deliveryId,
					signalId: stable.signalId,
					status: 'pending',
					attempts: 0,
					availableAt: stable.deliveryAvailableAt,
					createdAt: stable.completedAt,
					updatedAt: stable.completedAt,
				}
				const next = stateWith(current, {
					pendingAssessments: current.pendingAssessments.filter(
						(record) => record.id !== pending.id,
					),
					receipts: [...current.receipts, baseReceipt],
					acceptedSignals: [...current.acceptedSignals, signalRecord],
					dedup: [
						...current.dedup.filter((record) => record.key !== dedupKey),
						dedupRecord,
					],
					cooldowns: [
						...current.cooldowns.filter((record) => record.key !== cooldownKey),
						cooldownRecord,
					],
					deliveries: [...current.deliveries, delivery],
				})
				const capacity = resultCapacity(next, policy)
				if (capacity) return capacity
				writeAtomic(
					atomic,
					policy.stateRecordId,
					next,
					stable.completedAt,
					policy,
				)
				return { status: 'recorded', signalId: stable.signalId }
			})
		},

		async recordSilent(silent): Promise<RecordSignalOutcomeResult> {
			const stable = structuredClone(silent)
			timestamp(stable.completedAt, 'completedAt')
			const settledChanges = requireChanges(stable.settledChanges)
			return store.runAtomic((atomic) => {
				const current = pruneSnapshot(
					readAtomic(atomic, policy.stateRecordId),
					stable.completedAt,
					policy,
				)
				const outcomeDigest = digest({ outcome: 'silent', settledChanges })
				const receipt = current.receipts.find(
					(record) => record.id === stable.assessmentId,
				)
				if (receipt)
					return receipt.outcome === 'silent' &&
						receipt.outcomeDigest === outcomeDigest
						? { status: 'deduplicated' }
						: {
								status: 'conflict',
								reason: 'assessment outcome differs from recorded intent',
							}
				const pending = current.pendingAssessments.find(
					(record) => record.id === stable.assessmentId,
				)
				if (
					!pending ||
					!ensureLease(pending, stable.consumerId, stable.leaseToken)
				)
					return { status: 'conflict', reason: 'assessment lease is not owned' }
				if (!sameScopedChangeSet(pending.scopedChanges, settledChanges))
					return {
						status: 'conflict',
						reason:
							'silent outcome must explicitly settle every assessed change',
					}
				const result: SignalAssessmentReceipt = {
					id: pending.id,
					intentDigest: pending.intentDigest,
					outcomeDigest,
					outcome: 'silent',
					completedAt: stable.completedAt,
				}
				const next = stateWith(current, {
					pendingAssessments: current.pendingAssessments.filter(
						(record) => record.id !== pending.id,
					),
					receipts: [...current.receipts, result],
				})
				const capacity = resultCapacity(next, policy)
				if (capacity) return capacity
				writeAtomic(
					atomic,
					policy.stateRecordId,
					next,
					stable.completedAt,
					policy,
				)
				return { status: 'recorded' }
			})
		},

		async retryAssessment(retry): Promise<PendingSignalAssessment | undefined> {
			const stable = structuredClone(retry)
			validateRetry(stable)
			return store.runAtomic((atomic) => {
				const current = readAtomic(atomic, policy.stateRecordId)
				const existing = current.pendingAssessments.find(
					(record) => record.id === stable.assessmentId,
				)
				if (
					!existing ||
					!ensureLease(existing, stable.consumerId, stable.leaseToken)
				)
					return undefined
				const updated: PendingSignalAssessment = {
					...existing,
					status: 'pending',
					availableAt: stable.retryAt,
					updatedAt: stable.settledAt,
					lastError: stable.error,
					leaseOwner: undefined,
					leaseToken: undefined,
					leaseExpiresAt: undefined,
				}
				const next = stateWith(current, {
					pendingAssessments: current.pendingAssessments.map((record) =>
						record.id === updated.id ? updated : record,
					),
				})
				writeAtomic(
					atomic,
					policy.stateRecordId,
					next,
					stable.settledAt,
					policy,
				)
				return updated
			})
		},

		async claimDeliveries(claim): Promise<readonly SignalDeliveryRecord[]> {
			const stable = structuredClone(claim)
			validateClaim(stable)
			return store.runAtomic((atomic) => {
				const current = pruneSnapshot(
					readAtomic(atomic, policy.stateRecordId),
					stable.now,
					policy,
				)
				const selected = current.deliveries
					.filter(
						(record) =>
							(record.status === 'pending' &&
								record.availableAt <= stable.now) ||
							(record.status === 'delivering' &&
								record.leaseExpiresAt !== undefined &&
								record.leaseExpiresAt <= stable.now),
					)
					.slice(0, stable.limit)
				const selectedIds = new Set(selected.map((record) => record.id))
				const deliveries = current.deliveries.map(
					(record): SignalDeliveryRecord =>
						selectedIds.has(record.id)
							? {
									...record,
									status: 'delivering',
									attempts: record.attempts + 1,
									leaseOwner: stable.consumerId,
									leaseToken: stable.leaseToken,
									leaseExpiresAt: stable.leaseExpiresAt,
									updatedAt: stable.now,
								}
							: record,
				)
				const next = stateWith(current, { deliveries })
				writeAtomic(atomic, policy.stateRecordId, next, stable.now, policy)
				return deliveries.filter((record) => selectedIds.has(record.id))
			})
		},

		async settleDelivery(settle): Promise<SignalDeliveryRecord | undefined> {
			const stable = structuredClone(settle)
			validateSettle(stable)
			return store.runAtomic((atomic) => {
				const current = readAtomic(atomic, policy.stateRecordId)
				const existing = current.deliveries.find(
					(record) => record.id === stable.id,
				)
				if (
					!existing ||
					existing.status !== 'delivering' ||
					existing.leaseOwner !== stable.consumerId ||
					existing.leaseToken !== stable.leaseToken
				)
					return undefined
				const updated: SignalDeliveryRecord = {
					...existing,
					status: stable.outcome === 'retry' ? 'pending' : stable.outcome,
					availableAt: stable.retryAt ?? existing.availableAt,
					updatedAt: stable.settledAt,
					lastError: stable.error,
					leaseOwner: undefined,
					leaseToken: undefined,
					leaseExpiresAt: undefined,
				}
				const next = stateWith(current, {
					deliveries: current.deliveries.map((record) =>
						record.id === updated.id ? updated : record,
					),
				})
				writeAtomic(
					atomic,
					policy.stateRecordId,
					next,
					stable.settledAt,
					policy,
				)
				return updated
			})
		},

		async prune(now): Promise<SignalStateSnapshot> {
			timestamp(now, 'now')
			return store.runAtomic((atomic) => {
				const current = readAtomic(atomic, policy.stateRecordId)
				const next = pruneSnapshot(current, now, policy)
				writeAtomic(atomic, policy.stateRecordId, next, now, policy)
				return next
			})
		},

		async snapshot(): Promise<SignalStateSnapshot> {
			const record = await store.state.get(policy.stateRecordId)
			return record ? parseSnapshot(record.value) : emptySnapshot()
		},
	}
}

function sameScopedChangeSet(
	left: readonly ScopedChangeIdentity[],
	right: readonly ScopedChangeIdentity[],
): boolean {
	if (left.length !== right.length) return false
	const rightKeys = new Set(right.map(scopedChangeKey))
	return (
		rightKeys.size === right.length &&
		left.every((change) => rightKeys.has(scopedChangeKey(change)))
	)
}

function parseSnapshot(value: unknown): SignalStateSnapshot {
	const snapshot = snapshotSchema.parse(value) as SignalStateSnapshot
	for (const [name, ids] of [
		[
			'pending assessment',
			snapshot.pendingAssessments.map((record) => record.id),
		],
		['assessment receipt', snapshot.receipts.map((record) => record.id)],
		['accepted signal', snapshot.acceptedSignals.map((record) => record.id)],
		['dedup', snapshot.dedup.map((record) => record.key)],
		['cooldown', snapshot.cooldowns.map((record) => record.key)],
		['delivery', snapshot.deliveries.map((record) => record.id)],
	] as const)
		if (new Set(ids).size !== ids.length)
			throw new Error(`${name} identities must be unique`)
	const acceptedIds = new Set(
		snapshot.acceptedSignals.map((record) => record.id),
	)
	const receiptIds = new Set(snapshot.receipts.map((record) => record.id))
	if (snapshot.pendingAssessments.some((record) => receiptIds.has(record.id)))
		throw new Error('an assessment cannot be pending and terminal')
	for (const pending of snapshot.pendingAssessments) {
		timestamp(pending.availableAt, 'pending availableAt')
		timestamp(pending.createdAt, 'pending createdAt')
		timestamp(pending.updatedAt, 'pending updatedAt')
		if (pending.leaseExpiresAt)
			timestamp(pending.leaseExpiresAt, 'pending leaseExpiresAt')
		const hasLease =
			pending.leaseOwner !== undefined &&
			pending.leaseToken !== undefined &&
			pending.leaseExpiresAt !== undefined
		if ((pending.status === 'assessing') !== hasLease)
			throw new Error('assessment lease fields must match status')
	}
	for (const receipt of snapshot.receipts) {
		timestamp(receipt.completedAt, 'receipt completedAt')
		if (
			receipt.outcome === 'silent'
				? receipt.signalId !== undefined
				: receipt.signalId === undefined || !acceptedIds.has(receipt.signalId)
		)
			throw new Error('assessment receipt signal reference is invalid')
	}
	for (const accepted of snapshot.acceptedSignals) {
		timestamp(accepted.createdAt, 'signal createdAt')
		if (!receiptIds.has(accepted.assessmentId))
			throw new Error('accepted signal requires its assessment receipt')
	}
	for (const record of [...snapshot.dedup, ...snapshot.cooldowns]) {
		timestamp(record.createdAt, 'suppression createdAt')
		timestamp(record.expiresAt, 'suppression expiresAt')
		if (!acceptedIds.has(record.signalId))
			throw new Error('suppression record references an unknown signal')
	}
	for (const delivery of snapshot.deliveries) {
		timestamp(delivery.availableAt, 'delivery availableAt')
		timestamp(delivery.createdAt, 'delivery createdAt')
		timestamp(delivery.updatedAt, 'delivery updatedAt')
		if (delivery.leaseExpiresAt)
			timestamp(delivery.leaseExpiresAt, 'delivery leaseExpiresAt')
		if (!acceptedIds.has(delivery.signalId))
			throw new Error('delivery references an unknown signal')
		const hasLease =
			delivery.leaseOwner !== undefined &&
			delivery.leaseToken !== undefined &&
			delivery.leaseExpiresAt !== undefined
		if ((delivery.status === 'delivering') !== hasLease)
			throw new Error('delivery lease fields must match status')
	}
	return snapshot
}

function validateClaim(input: ClaimSignalWorkInput): void {
	if (!input.consumerId || !input.leaseToken)
		throw new Error('consumerId and leaseToken are required')
	positiveInteger(input.limit, 'limit')
	timestamp(input.now, 'now')
	timestamp(input.leaseExpiresAt, 'leaseExpiresAt')
	if (input.leaseExpiresAt <= input.now)
		throw new Error('leaseExpiresAt must be after now')
}

function validateAccepted(input: RecordAcceptedSignalInput): void {
	if (
		!input.assessmentId ||
		!input.consumerId ||
		!input.leaseToken ||
		!input.signalId ||
		!input.deliveryId
	)
		throw new Error(
			'assessment, lease, signal, and delivery identities are required',
		)
	timestamp(input.completedAt, 'completedAt')
	timestamp(input.deliveryAvailableAt, 'deliveryAvailableAt')
	if (
		!input.proposal.meaning ||
		!input.proposal.materialChange ||
		!input.proposal.policy.id ||
		!input.proposal.policy.version ||
		!input.proposal.cooldownScopeId
	)
		throw new Error('complete signal proposal is required')
	if (
		input.proposal.affectedLensIds.length === 0 ||
		input.proposal.affectedMemories.length === 0
	)
		throw new Error('affected lens and memory ids are required')
	const scopedMemoryIds = input.proposal.affectedMemories.map(
		(memory) => `${memory.lensId}\u0000${memory.memoryId}`,
	)
	if (
		new Set(input.proposal.affectedLensIds).size !==
			input.proposal.affectedLensIds.length ||
		new Set(scopedMemoryIds).size !== scopedMemoryIds.length
	)
		throw new Error('affected ids must be unique')
}

function validateRetry(input: RetrySignalAssessmentInput): void {
	if (!input.assessmentId || !input.consumerId || !input.leaseToken)
		throw new Error('assessment and lease identity are required')
	timestamp(input.retryAt, 'retryAt')
	timestamp(input.settledAt, 'settledAt')
}

function validateSettle(input: SettleSignalDeliveryInput): void {
	if (!input.id || !input.consumerId || !input.leaseToken)
		throw new Error('delivery and lease identity are required')
	timestamp(input.settledAt, 'settledAt')
	if (input.outcome === 'retry') {
		if (!input.retryAt) throw new Error('retryAt is required for retry')
		timestamp(input.retryAt, 'retryAt')
	} else if (input.retryAt) throw new Error('retryAt is only valid for retry')
}
