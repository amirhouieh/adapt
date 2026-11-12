/**
 * Store types — persistence layer interfaces for both Neurons and Brain.
 */

import type { Significance } from '../neurons/types'

// ═══════════════════════════════════════════════════════════════════════════════
// Neuron Store Types
// ═══════════════════════════════════════════════════════════════════════════════

// ── Collection ──────────────────────────────────────────────────────────────

/**
 * Universal CRUD interface for all store namespaces.
 * Every record must have a string `id` field.
 * All methods are async for adapter compatibility (in-memory returns resolved promises).
 */
export interface NeuronCollection<T extends { id: string }> {
	add(item: T): Promise<void>
	get(id: string): Promise<T | undefined>
	list(filter?: Record<string, unknown>): Promise<T[]>
	update(id: string, changes: Partial<Omit<T, 'id'>>): Promise<void>
	delete(id: string): Promise<void>
	clear(): Promise<void>
	count(filter?: Record<string, unknown>): Promise<number>
	search(query: string): Promise<T[]>
	addBatch(items: T[]): Promise<void>
	/** Synchronous view used only inside the owning store's runAtomic callback. */
	atomic(): AtomicCollection<T>
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * NeuronStore — no type parameter. UnderstandingRecord is universal.
 * Injected into neuron. Caller decides the adapter.
 */
export interface NeuronStore {
	observations: NeuronCollection<ObservationRecord>
	understanding: NeuronCollection<UnderstandingRecord>
	evolution: NeuronCollection<EvolutionRecord>
	state: NeuronCollection<StateRecord>
	learningHistory: NeuronCollection<LearningHistoryRecord>
	memoryChanges: NeuronCollection<MemoryChangeRecord>
	pendingWork: NeuronCollection<PendingWorkRecord>
	pendingInputs: NeuronCollection<PendingInputRecord>
	processedInputs: NeuronCollection<ProcessedInputRecord>
	outbox: NeuronCollection<OutboxRecord>
	learningAttempts: NeuronCollection<LearningAttemptRecord>
	learningRevisions: NeuronCollection<LearningRevisionRecord>
	learning: LearningCommitStore
	runAtomic<TResult>(
		operation: (store: AtomicNeuronStore) => TResult,
	): Promise<TResult>
	dispose(): Promise<void>
}

// ── Record types ────────────────────────────────────────────────────────────

/**
 * Buffered observer output — retained derived neuron record.
 * After understand, marked metadata_status='processed', not deleted.
 */
export interface ObservationRecord {
	id: string
	data: unknown
	metadata_importance: number
	metadata_tokens: number
	metadata_status: 'pending' | 'processed'
	metadata_created_at: string // ISO 8601
}

/**
 * Universal understanding record — same shape for all neuron types.
 * Only `data` varies (text = string, list = object per item).
 * LLM-specific fields (e.g. list item `signals`) live inside `data`.
 */
export interface UnderstandingRecord {
	id: string
	data: unknown
	metadata_confidence: number | null // 0-1 when known; null means unknown
	metadata_confidence_provenance?:
		| 'generated'
		| 'token-probability'
		| 'calibrated'
		| 'legacy-touch-count'
		| 'legacy-default'
		| 'unknown'
	metadata_created_at: string // ISO 8601
	metadata_updated_at: string // ISO 8601
}

/**
 * Change history entry — fully flat, no data wrapper, no metadata prefix.
 */
export interface EvolutionRecord {
	id: string
	summary: string
	reasoning?: string
	significance: Significance
	created_at: string // ISO 8601
}

/**
 * Key-value state (config + runtime: prompts, identities, schemas).
 * The neuron knows the semantics, the store doesn't.
 */
export interface StateRecord {
	id: string // acts as key name (e.g. "identity", "observe_prompt")
	value: unknown
	updated_at: string // ISO 8601
}

// ── V2 learning commit records ─────────────────────────────────────────────

export interface LearningHistoryRecord {
	id: string
	attempt_id: string
	outcome: 'change' | 'no-change'
	previous_memory_revision: number
	memory_revision: number
	config_revision: number
	input_ids: string[]
	change_ids: string[]
	explanation?: string
	created_at: string
	bindings?: LearningVersionBindings
}

export interface MemoryChangeRecord {
	id: string
	attempt_id: string
	memory_revision: number
	kind: string
	affected_memory_ids: string[]
	summary?: string
	created_at: string
}

export interface PendingWorkRecord {
	id: string
	attempt_id: string
	input_ids: string[]
	/** Temporary text for unfinished inputs, keyed by input id. */
	inputs?: Array<{
		id: string
		text: string
		event_id?: string
		observed_at?: string
		urgency?: 'normal' | 'urgent'
		identity_digest?: string
	}>
	bindings?: LearningVersionBindings
	status: 'pending' | 'deleted'
	retry_count: number
	available_at: string
	last_error?: string
	created_at: string
	updated_at: string
}

/** Durable uniqueness index for source versions waiting to be processed. */
export interface PendingInputRecord {
	id: string
	pending_work_id: string
	attempt_id: string
	created_at: string
	identity_digest?: string
}

/** Durable uniqueness index for source versions already consumed. */
export interface ProcessedInputRecord {
	id: string
	attempt_id: string
	outcome: 'change' | 'no-change' | 'terminal-failure'
	memory_revision: number
	processed_at: string
	identity_digest?: string
	expires_at?: string
}

export type OutboxStatus = 'pending' | 'delivering' | 'delivered' | 'discarded'

export interface OutboxRecord {
	id: string
	kind: string
	deduplication_key: string
	change_ids: string[]
	status: OutboxStatus
	attempts: number
	available_at: string
	lease_owner?: string
	lease_token?: string
	lease_expires_at?: string
	last_error?: string
	created_at: string
	updated_at: string
}

export interface LearningAttemptRecord {
	id: string
	pending_work_id: string
	input_ids: string[]
	status: 'committed' | 'no-change'
	memory_revision: number
	config_revision: number
	history_id: string
	remaining_work_id?: string
	/** Digest of the compact learned commit intent; never the source payload. */
	intent_digest: string
	created_at: string
	bindings?: LearningVersionBindings
}

export interface LearningRevisionRecord {
	id: 'current'
	memory_revision: number
	config_revision: number
	learned_state_revision?: number
	active_bindings?: LearningVersionBindings
	updated_at?: string
}

export interface StoredVersionRef {
	id: string
	version: string
}

/** Commit-relevant adaptive pins. Registry is retained as lineage, not global CAS. */
export interface LearningVersionBindings {
	neuron: { id: string; incarnation: string; ownership_revision: number }
	profile: StoredVersionRef
	profile_revision: number
	procedure: StoredVersionRef
	model: StoredVersionRef
	registry_lineage: string
	referenced_definition_digest: string
	allowed_catalogue_digest: string
}

export type UnderstandingPatch =
	| { type: 'replace'; records: UnderstandingRecord[] }
	| {
			type: 'operations'
			upsert: UnderstandingRecord[]
			delete_ids: string[]
	  }

/** Atomic changes to retained, derived neuron observations. */
export interface ObservationCommitPatch {
	/** New observer output. Records enter the synthesis buffer as pending. */
	add: ObservationRecord[]
	/** Existing pending observations settled by synthesis or explicit dismissal. */
	mark_processed_ids: string[]
}

export interface EnqueueLearningWorkInput {
	work: PendingWorkRecord
}

/** Caller-supplied identity for residual work; the store transfers its text. */
export type PendingWorkContinuation = Omit<PendingWorkRecord, 'inputs'>

export type EnqueueLearningWorkResult =
	| { status: 'queued'; pending_work_id: string }
	| { status: 'deduplicated'; pending_work_id?: string; attempt_id?: string }
	| {
			status: 'conflict'
			reason:
				| 'partial-input-overlap'
				| 'attempt-id-reused'
				| 'delivery-id-reused'
	  }
	| { status: 'failure'; error: string }

export interface LearningCommitInput {
	logical_attempt_id: string
	pending_work_id: string
	expected_memory_revision: number
	expected_config_revision: number
	expected_learned_state_revision?: number
	bindings?: LearningVersionBindings
	input_ids: string[]
	remaining_work?: PendingWorkContinuation
	outcome: 'change' | 'no-change'
	patch?: UnderstandingPatch
	observations?: ObservationCommitPatch
	evolution_records?: EvolutionRecord[]
	history: LearningHistoryRecord
	changes: MemoryChangeRecord[]
	outbox: OutboxRecord[]
	committed_at: string
	transient_state_ids?: string[]
	retention?: {
		max_history_entries: number
		max_history_characters: number
		processed_expires_at: string
		max_processed_ids: number
	}
}

export type LearningCommitResult =
	| {
			status: 'committed' | 'no-change'
			memory_revision: number
			config_revision: number
			learned_state_revision?: number
			deduplicated: boolean
			remaining_work_id?: string
	  }
	| {
			status: 'conflict'
			reason:
				| 'memory-revision'
				| 'config-revision'
				| 'input-overlap'
				| 'pending-work'
				| 'learned-state-revision'
				| 'profile'
			memory_revision: number
			config_revision: number
			learned_state_revision?: number
	  }
	| { status: 'failure'; error: string }

export interface UpdateLearningConfigRevisionInput {
	expected_config_revision: number
	next_config_revision: number
	updated_at: string
}

export type UpdateLearningConfigRevisionResult =
	| { status: 'updated'; config_revision: number }
	| { status: 'conflict'; config_revision: number }
	| { status: 'failure'; error: string }

export interface ClaimOutboxInput {
	consumer_id: string
	lease_token: string
	now: string
	lease_expires_at: string
	limit: number
}

export interface SettleOutboxInput {
	id: string
	consumer_id: string
	lease_token: string
	outcome: 'delivered' | 'retry'
	settled_at: string
	retry_at?: string
	error?: string
}

export interface LearningCommitStore {
	enqueue(input: EnqueueLearningWorkInput): Promise<EnqueueLearningWorkResult>
	commit(input: LearningCommitInput): Promise<LearningCommitResult>
	getRevisions(): Promise<LearningRevisionRecord>
	updateConfigRevision(
		input: UpdateLearningConfigRevisionInput,
	): Promise<UpdateLearningConfigRevisionResult>
	claimOutbox(input: ClaimOutboxInput): Promise<OutboxRecord[]>
	settleOutbox(input: SettleOutboxInput): Promise<OutboxRecord | undefined>
}

/** Synchronous transaction view. Returning a Promise is rejected at runtime. */
export interface AtomicCollection<T extends { id: string }> {
	add(item: T): void
	get(id: string): T | undefined
	list(filter?: Record<string, unknown>): T[]
	update(id: string, changes: Partial<Omit<T, 'id'>>): void
	delete(id: string): void
	clear(): void
}

export interface AtomicNeuronStore {
	observations: AtomicCollection<ObservationRecord>
	understanding: AtomicCollection<UnderstandingRecord>
	evolution: AtomicCollection<EvolutionRecord>
	state: AtomicCollection<StateRecord>
	learningHistory: AtomicCollection<LearningHistoryRecord>
	memoryChanges: AtomicCollection<MemoryChangeRecord>
	pendingWork: AtomicCollection<PendingWorkRecord>
	pendingInputs: AtomicCollection<PendingInputRecord>
	processedInputs: AtomicCollection<ProcessedInputRecord>
	outbox: AtomicCollection<OutboxRecord>
	learningAttempts: AtomicCollection<LearningAttemptRecord>
	learningRevisions: AtomicCollection<LearningRevisionRecord>
}

export type LearningCommitStage =
	| 'after-memory'
	| 'after-history'
	| 'before-complete'

export interface LearningStoreOptions {
	onCommitStage?: (stage: LearningCommitStage) => void
}

// ═══════════════════════════════════════════════════════════════════════════════
// Brain Store Types
// ═══════════════════════════════════════════════════════════════════════════════

// ── Collection Interface ─────────────────────────────────────────────────────

export interface BrainCollection<T extends { id: string }> {
	add(item: T): Promise<void>
	get(id: string): Promise<T | undefined>
	list(filter?: Record<string, unknown>): Promise<T[]>
	update(id: string, changes: Partial<Omit<T, 'id'>>): Promise<void>
	delete(id: string): Promise<void>
	clear(): Promise<void>
	count(filter?: Record<string, unknown>): Promise<number>
	addBatch(items: T[]): Promise<void>
	dispose(): Promise<void>
	/** Synchronous view used only inside the owning store's runAtomic callback. */
	atomic(): AtomicCollection<T>
}

// ── Store Interface ──────────────────────────────────────────────────────────

export interface BrainStore {
	state: BrainCollection<BrainStateRecord>
	neurons: BrainCollection<BrainNeuronRecord>
	internalNeurons: BrainCollection<BrainNeuronRecord>
	evolution: BrainCollection<BrainEvolutionRecord>
	dismissedBatches: BrainCollection<DismissedBatchRecord>
	registryHeads: BrainCollection<BrainRegistryHeadRecord>
	registryRevisions: BrainCollection<BrainRegistryRevisionRecord>
	evolutionActivations: BrainCollection<BrainEvolutionActivationRecord>
	evolutionStages: BrainCollection<BrainEvolutionStageRecord>
	memoryMappings: BrainCollection<BrainMemoryMappingRecord>
	/**
	 * Resolve the persistence store for a given neuron id. Same code path on
	 * Brain.create and Brain.restore so the two cannot disagree on where the
	 * neuron's data lives.
	 */
	getNeuronStore(neuronId: string): NeuronStore
	runAtomic<TResult>(
		operation: (store: AtomicBrainStore) => TResult,
	): Promise<TResult>
	dispose(): Promise<void>
}

export interface AtomicBrainStore {
	state: AtomicCollection<BrainStateRecord>
	neurons: AtomicCollection<BrainNeuronRecord>
	internalNeurons: AtomicCollection<BrainNeuronRecord>
	evolution: AtomicCollection<BrainEvolutionRecord>
	dismissedBatches: AtomicCollection<DismissedBatchRecord>
	registryHeads: AtomicCollection<BrainRegistryHeadRecord>
	registryRevisions: AtomicCollection<BrainRegistryRevisionRecord>
	evolutionActivations: AtomicCollection<BrainEvolutionActivationRecord>
	evolutionStages: AtomicCollection<BrainEvolutionStageRecord>
	memoryMappings: AtomicCollection<BrainMemoryMappingRecord>
}

// ── Record Types ─────────────────────────────────────────────────────────────

/** Key-value pairs for Brain config and runtime state */
export interface BrainStateRecord {
	id: string // key name: 'prompt', 'config', 'coverage_gap_state', etc.
	value: unknown // serialized value
	updated_at: string
}

/**
 * Lifecycle status for a Brain-managed neuron.
 * - 'active': fully participating in inject fan-out and evolution evaluation
 * - 'inactive': skipped during inject and evolution; queries still hit it
 *
 * Open enum: future states (archived, frozen, etc.) can be added without
 * breaking persisted records. Missing/undefined is treated as 'active' so
 * pre-existing records continue to work.
 */
export type NeuronStatus = 'active' | 'inactive'

/** One record per neuron — minimal ref, neuron's own store has everything else */
export interface BrainNeuronRecord {
	id: string // neuron ID
	type: string // 'text' | 'list' | future types
	status?: NeuronStatus // defaults to 'active' when missing
}

/** Evaluator decisions history */
export interface BrainEvolutionRecord {
	id: string
	decisions: unknown // serialized EvolutionDecision[]
	source: string // 'auto' | 'manual'
	created_at: string
}

/** Dismissed injection batch — stored when all external neurons dismiss */
export interface DismissedBatchRecord {
	id: string // batchId
	data: unknown // JSON-serialized original items
	gaps: unknown // JSON-serialized string[]
	timestamp: string
	retryCount: number
	status: string // 'pending' | 'retried'
}

export interface BrainRegistryLensRecord {
	id: string
	physical_store_id: string
	type: string
	config: unknown
	dependencies: string[]
}

export interface BrainRegistryHeadRecord {
	id: 'current'
	revision_id: string
	revision: number
	updated_at: string
}

export interface BrainRegistryRevisionRecord {
	id: string
	revision: number
	parent_id?: string
	activation_id?: string
	lenses: BrainRegistryLensRecord[]
	created_at: string
}

export type BrainEvolutionActivationStatus =
	| 'preparing'
	| 'staged'
	| 'activated'
	| 'abandoning'
	| 'completed'
	| 'abandoned'
	| 'failed'

export interface BrainEvolutionSourcePin {
	lens_id: string
	physical_store_id: string
	memory_revision: number
	config_revision: number
	/** Digest of every namespace in the atomically captured neuron snapshot. */
	state_digest: string
}

export interface NeuronStoreSnapshot {
	observations: ObservationRecord[]
	understanding: UnderstandingRecord[]
	evolution: EvolutionRecord[]
	state: StateRecord[]
	learningHistory: LearningHistoryRecord[]
	memoryChanges: MemoryChangeRecord[]
	pendingWork: PendingWorkRecord[]
	pendingInputs: PendingInputRecord[]
	processedInputs: ProcessedInputRecord[]
	outbox: OutboxRecord[]
	learningAttempts: LearningAttemptRecord[]
	learningRevisions: LearningRevisionRecord[]
}

export interface BrainEvolutionActivationRecord {
	id: string
	proposal_id: string
	action: 'create' | 'update' | 'merge' | 'split' | 'delete'
	/** Binds an activation id to the complete immutable activation request. */
	intent_digest: string
	mode: 'evolution' | 'rollback'
	base_registry_revision_id: string
	target_registry: BrainRegistryRevisionRecord
	source_pins: BrainEvolutionSourcePin[]
	affected_lens_ids: string[]
	staging_policy: {
		max_targets: number
		max_snapshot_records: number
		max_snapshot_chars: number
	}
	transformation_ref?: { id: string; version: string }
	deletion_mode?: 'lens-only' | 'lens-and-retained-knowledge'
	status: BrainEvolutionActivationStatus
	error?: string
	created_at: string
	updated_at: string
}

export interface BrainEvolutionStageRecord {
	id: string
	activation_id: string
	lens_id: string
	physical_store_id: string
	lens: BrainRegistryLensRecord
	snapshot?: NeuronStoreSnapshot
	status: 'pending' | 'writing' | 'ready' | 'consumed' | 'abandoned'
	created_at: string
	updated_at: string
}

export interface BrainHistoryIdentityMapping {
	source_history_id: string
	target_history_id: string
}

export interface BrainMemoryMappingRecord {
	id: string
	activation_id: string
	source_lens_id: string
	source_memory_id: string
	target_lens_id?: string
	target_memory_id?: string
	disposition: 'transferred' | 'retained' | 'deleted'
	history: BrainHistoryIdentityMapping[]
	created_at: string
}
