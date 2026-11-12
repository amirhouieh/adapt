import type { LearningModelCapability } from '../../learning/recipes/types'
import type { AdaptUsage, JsonValue } from '../../llm'
import type { BrainStore } from '../../stores'

export interface SignalPolicyRef {
	readonly id: string
	readonly version: string
}

export interface ScopedChangeIdentity {
	readonly lensId: string
	readonly changeId: string
}

export interface ScopedMemoryIdentity {
	readonly lensId: string
	readonly memoryId: string
}

export interface SignalCommittedChange extends ScopedChangeIdentity {
	readonly memoryId: string
	readonly memoryRevision: number
	readonly kind: string
	readonly summary: string
	readonly affectedMemoryIds: readonly string[]
}

export interface SignalMemoryView {
	readonly lensId: string
	readonly memoryId: string
	readonly memoryRevision: number
	readonly memoryType: string
	readonly purpose: string
	readonly content: JsonValue
}

export interface PriorAcceptedSignalView {
	readonly id: string
	readonly meaning: string
	readonly affectedLensIds: readonly string[]
	readonly affectedMemories: readonly ScopedMemoryIdentity[]
	readonly scopedChanges: readonly ScopedChangeIdentity[]
	readonly createdAt: string
}

export interface SignalAssessmentPolicy extends SignalPolicyRef {
	readonly instructions: string
	readonly cooldownScopeId: string
	readonly maxChanges: number
	readonly maxMemories: number
	readonly maxPriorSignals: number
	readonly maxContextCharacters: number
	readonly maxRequestCharacters: number
	readonly maxSignalCharacters: number
}

export interface SignalAssessmentInput {
	readonly assessmentId: string
	readonly changes: readonly SignalCommittedChange[]
	readonly memories: readonly SignalMemoryView[]
	readonly priorSignals: readonly PriorAcceptedSignalView[]
	readonly policy: SignalAssessmentPolicy
	readonly model: Pick<LearningModelCapability, 'generate'>
	readonly signal: AbortSignal
}

export interface SignalProposal {
	readonly meaning: string
	readonly materialChange: string
	readonly affectedLensIds: readonly string[]
	readonly affectedMemories: readonly ScopedMemoryIdentity[]
	readonly scopedChanges: readonly ScopedChangeIdentity[]
	readonly policy: SignalPolicyRef
	readonly cooldownScopeId: string
}

export type SignalAssessmentResult =
	| {
			readonly status: 'proposed'
			readonly proposal: SignalProposal
			readonly settledSilentChanges: readonly ScopedChangeIdentity[]
			readonly raw: unknown
			readonly usage?: AdaptUsage
	  }
	| {
			readonly status: 'silent'
			readonly reason: string
			readonly scopedChanges: readonly ScopedChangeIdentity[]
			readonly raw: unknown
			readonly usage?: AdaptUsage
	  }
	| {
			readonly status: 'defer'
			readonly code: 'request_bound' | 'cancelled' | 'semantic_unknown'
			readonly reason: string
			readonly pendingChanges: readonly ScopedChangeIdentity[]
			readonly raw?: unknown
			readonly usage?: AdaptUsage
	  }
	| {
			readonly status: 'failure'
			readonly code: 'invalid_input' | 'invalid_result' | 'provider_failure'
			readonly reason: string
			readonly cause?: unknown
			readonly raw?: unknown
			readonly usage?: AdaptUsage
	  }

export interface PendingSignalAssessment {
	readonly id: string
	readonly intentDigest: string
	readonly policy: SignalPolicyRef
	readonly cooldownScopeId: string
	readonly scopedChanges: readonly ScopedChangeIdentity[]
	readonly status: 'pending' | 'assessing'
	readonly attempts: number
	readonly availableAt: string
	readonly leaseOwner?: string
	readonly leaseToken?: string
	readonly leaseExpiresAt?: string
	readonly lastError?: string
	readonly createdAt: string
	readonly updatedAt: string
}

export interface AcceptedSignal extends SignalProposal {
	readonly id: string
	readonly assessmentId: string
	readonly createdAt: string
}

export interface SignalAssessmentReceipt {
	readonly id: string
	readonly intentDigest: string
	readonly outcomeDigest: string
	readonly outcome: 'accepted' | 'silent' | 'suppressed'
	readonly signalId?: string
	readonly completedAt: string
}

export interface SignalDedupRecord {
	readonly key: string
	readonly policy: SignalPolicyRef
	readonly cooldownScopeId: string
	readonly scopedChanges: readonly ScopedChangeIdentity[]
	readonly signalId: string
	readonly createdAt: string
	readonly expiresAt: string
}

export interface SignalCooldownRecord {
	readonly key: string
	readonly policy: SignalPolicyRef
	readonly cooldownScopeId: string
	readonly signalId: string
	readonly createdAt: string
	readonly expiresAt: string
}

export interface SignalDeliveryRecord {
	readonly id: string
	readonly signalId: string
	readonly status: 'pending' | 'delivering' | 'delivered' | 'discarded'
	readonly attempts: number
	readonly availableAt: string
	readonly leaseOwner?: string
	readonly leaseToken?: string
	readonly leaseExpiresAt?: string
	readonly lastError?: string
	readonly createdAt: string
	readonly updatedAt: string
}

export interface SignalStateSnapshot {
	readonly version: 1
	readonly pendingAssessments: readonly PendingSignalAssessment[]
	readonly receipts: readonly SignalAssessmentReceipt[]
	readonly acceptedSignals: readonly AcceptedSignal[]
	readonly dedup: readonly SignalDedupRecord[]
	readonly cooldowns: readonly SignalCooldownRecord[]
	readonly deliveries: readonly SignalDeliveryRecord[]
}

export interface SignalStatePolicy {
	readonly stateRecordId: string
	readonly maxPendingAssessments: number
	readonly maxReceipts: number
	readonly maxAcceptedSignals: number
	readonly maxDedupRecords: number
	readonly maxCooldownRecords: number
	readonly maxDeliveries: number
	readonly maxSerializedCharacters: number
	readonly exactDedupRetentionMs: number
	readonly cooldownMs: number
	readonly receiptRetentionMs: number
	readonly acceptedRetentionMs: number
	readonly deliveredRetentionMs: number
}

export interface SignalStateStoreInput {
	readonly store: BrainStore
	readonly policy: SignalStatePolicy
}

export interface EnqueueSignalAssessmentInput {
	readonly id: string
	readonly policy: SignalPolicyRef
	readonly cooldownScopeId: string
	readonly scopedChanges: readonly ScopedChangeIdentity[]
	readonly availableAt: string
	readonly createdAt: string
}

export type EnqueueSignalAssessmentResult =
	| { readonly status: 'queued' }
	| { readonly status: 'deduplicated' }
	| { readonly status: 'conflict'; readonly reason: 'assessment-id-reused' }
	| {
			readonly status: 'backpressure'
			readonly reason: 'pending-capacity' | 'state-size'
	  }

export interface ClaimSignalWorkInput {
	readonly consumerId: string
	readonly leaseToken: string
	readonly now: string
	readonly leaseExpiresAt: string
	readonly limit: number
}

export interface RecordAcceptedSignalInput {
	readonly assessmentId: string
	readonly consumerId: string
	readonly leaseToken: string
	readonly signalId: string
	readonly deliveryId: string
	readonly proposal: SignalProposal
	readonly settledSilentChanges: readonly ScopedChangeIdentity[]
	readonly completedAt: string
	readonly deliveryAvailableAt: string
}

export type RecordSignalOutcomeResult =
	| { readonly status: 'recorded'; readonly signalId?: string }
	| { readonly status: 'deduplicated'; readonly signalId?: string }
	| {
			readonly status: 'suppressed'
			readonly signalId: string
			readonly reason: 'cooldown'
	  }
	| { readonly status: 'conflict'; readonly reason: string }
	| {
			readonly status: 'backpressure'
			readonly reason:
				| 'accepted-capacity'
				| 'receipt-capacity'
				| 'dedup-capacity'
				| 'cooldown-capacity'
				| 'delivery-capacity'
				| 'state-size'
	  }

export interface RecordSilentSignalInput {
	readonly assessmentId: string
	readonly consumerId: string
	readonly leaseToken: string
	readonly settledChanges: readonly ScopedChangeIdentity[]
	readonly completedAt: string
}

export interface RetrySignalAssessmentInput {
	readonly assessmentId: string
	readonly consumerId: string
	readonly leaseToken: string
	readonly retryAt: string
	readonly settledAt: string
	readonly error?: string
}

export interface SettleSignalDeliveryInput {
	readonly id: string
	readonly consumerId: string
	readonly leaseToken: string
	readonly outcome: 'delivered' | 'retry' | 'discarded'
	readonly settledAt: string
	readonly retryAt?: string
	readonly error?: string
}

export interface SignalStateStore {
	enqueueAssessment(
		input: EnqueueSignalAssessmentInput,
	): Promise<EnqueueSignalAssessmentResult>
	claimAssessments(
		input: ClaimSignalWorkInput,
	): Promise<readonly PendingSignalAssessment[]>
	recordAccepted(
		input: RecordAcceptedSignalInput,
	): Promise<RecordSignalOutcomeResult>
	recordSilent(
		input: RecordSilentSignalInput,
	): Promise<RecordSignalOutcomeResult>
	retryAssessment(
		input: RetrySignalAssessmentInput,
	): Promise<PendingSignalAssessment | undefined>
	claimDeliveries(
		input: ClaimSignalWorkInput,
	): Promise<readonly SignalDeliveryRecord[]>
	settleDelivery(
		input: SettleSignalDeliveryInput,
	): Promise<SignalDeliveryRecord | undefined>
	prune(now: string): Promise<SignalStateSnapshot>
	snapshot(): Promise<SignalStateSnapshot>
}
