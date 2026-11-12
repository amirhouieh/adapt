import type {
	BrainEvolutionRecord,
	BrainEvolutionActivationRecord,
	BrainEvolutionStageRecord,
	BrainMemoryMappingRecord,
	BrainNeuronRecord,
	BrainRegistryHeadRecord,
	BrainRegistryRevisionRecord,
	BrainStateRecord,
	DismissedBatchRecord,
	EvolutionRecord,
	LearningAttemptRecord,
	LearningHistoryRecord,
	LearningRevisionRecord,
	MemoryChangeRecord,
	ObservationRecord,
	OutboxRecord,
	PendingInputRecord,
	PendingWorkRecord,
	ProcessedInputRecord,
	StateRecord,
	UnderstandingRecord,
} from '../types'

export type CollectionFieldKind = 'text' | 'real' | 'integer' | 'json'

export interface CollectionFieldSpec<T extends { id: string }> {
	name: keyof T & string
	kind: CollectionFieldKind
	nullable?: boolean
	defaultSql?: string
	preserveNull?: boolean
}

export interface CollectionSearchSpec {
	strategy: 'fulltext'
}

export interface StoreCollectionSpec<T extends { id: string }> {
	table: string
	fields: readonly CollectionFieldSpec<T>[]
	indexes?: readonly (keyof T & string)[]
	search?: CollectionSearchSpec
}

export const observationCollectionSpec: StoreCollectionSpec<ObservationRecord> =
	{
		table: 'observations',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'data', kind: 'json' },
			{ name: 'metadata_importance', kind: 'real' },
			{ name: 'metadata_tokens', kind: 'integer' },
			{ name: 'metadata_status', kind: 'text' },
			{ name: 'metadata_created_at', kind: 'text' },
		],
		indexes: ['metadata_status'],
	}

export const understandingCollectionSpec: StoreCollectionSpec<UnderstandingRecord> =
	{
		table: 'understanding',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'data', kind: 'json' },
			{
				name: 'metadata_confidence',
				kind: 'real',
				nullable: true,
				preserveNull: true,
			},
			{ name: 'metadata_confidence_provenance', kind: 'text', nullable: true },
			{ name: 'metadata_created_at', kind: 'text' },
			{ name: 'metadata_updated_at', kind: 'text' },
		],
		indexes: ['metadata_updated_at'],
		search: { strategy: 'fulltext' },
	}

export const neuronEvolutionCollectionSpec: StoreCollectionSpec<EvolutionRecord> =
	{
		table: 'evolution',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'summary', kind: 'text' },
			{ name: 'reasoning', kind: 'text', nullable: true },
			{ name: 'significance', kind: 'text' },
			{ name: 'created_at', kind: 'text' },
		],
		indexes: ['created_at'],
	}

export const neuronStateCollectionSpec: StoreCollectionSpec<StateRecord> = {
	table: 'state',
	fields: [
		{ name: 'id', kind: 'text' },
		{ name: 'value', kind: 'json' },
		{ name: 'updated_at', kind: 'text' },
	],
	indexes: ['updated_at'],
}

export const learningHistoryCollectionSpec: StoreCollectionSpec<LearningHistoryRecord> =
	{
		table: 'learning_history',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'attempt_id', kind: 'text' },
			{ name: 'outcome', kind: 'text' },
			{ name: 'previous_memory_revision', kind: 'integer' },
			{ name: 'memory_revision', kind: 'integer' },
			{ name: 'config_revision', kind: 'integer' },
			{ name: 'input_ids', kind: 'json' },
			{ name: 'change_ids', kind: 'json' },
			{ name: 'explanation', kind: 'text', nullable: true },
			{ name: 'created_at', kind: 'text' },
			{ name: 'bindings', kind: 'json', nullable: true },
		],
		indexes: ['attempt_id', 'memory_revision', 'created_at'],
	}

export const memoryChangeCollectionSpec: StoreCollectionSpec<MemoryChangeRecord> =
	{
		table: 'memory_changes',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'attempt_id', kind: 'text' },
			{ name: 'memory_revision', kind: 'integer' },
			{ name: 'kind', kind: 'text' },
			{ name: 'affected_memory_ids', kind: 'json' },
			{ name: 'summary', kind: 'text', nullable: true },
			{ name: 'created_at', kind: 'text' },
		],
		indexes: ['attempt_id', 'memory_revision', 'created_at'],
	}

export const pendingWorkCollectionSpec: StoreCollectionSpec<PendingWorkRecord> =
	{
		table: 'pending_learning_work',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'attempt_id', kind: 'text' },
			{ name: 'input_ids', kind: 'json' },
			{ name: 'inputs', kind: 'json', nullable: true },
			{ name: 'bindings', kind: 'json', nullable: true },
			{ name: 'status', kind: 'text' },
			{ name: 'retry_count', kind: 'integer' },
			{ name: 'available_at', kind: 'text' },
			{ name: 'last_error', kind: 'text', nullable: true },
			{ name: 'created_at', kind: 'text' },
			{ name: 'updated_at', kind: 'text' },
		],
		indexes: ['attempt_id', 'status', 'available_at'],
	}

export const pendingInputCollectionSpec: StoreCollectionSpec<PendingInputRecord> =
	{
		table: 'pending_learning_inputs',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'pending_work_id', kind: 'text' },
			{ name: 'attempt_id', kind: 'text' },
			{ name: 'created_at', kind: 'text' },
			{ name: 'identity_digest', kind: 'text', nullable: true },
		],
		indexes: ['pending_work_id', 'attempt_id'],
	}

export const processedInputCollectionSpec: StoreCollectionSpec<ProcessedInputRecord> =
	{
		table: 'processed_learning_inputs',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'attempt_id', kind: 'text' },
			{ name: 'outcome', kind: 'text' },
			{ name: 'memory_revision', kind: 'integer' },
			{ name: 'processed_at', kind: 'text' },
			{ name: 'identity_digest', kind: 'text', nullable: true },
			{ name: 'expires_at', kind: 'text', nullable: true },
		],
		indexes: ['attempt_id', 'memory_revision'],
	}

export const outboxCollectionSpec: StoreCollectionSpec<OutboxRecord> = {
	table: 'learning_outbox',
	fields: [
		{ name: 'id', kind: 'text' },
		{ name: 'kind', kind: 'text' },
		{ name: 'deduplication_key', kind: 'text' },
		{ name: 'change_ids', kind: 'json' },
		{ name: 'status', kind: 'text' },
		{ name: 'attempts', kind: 'integer' },
		{ name: 'available_at', kind: 'text' },
		{ name: 'lease_owner', kind: 'text', nullable: true },
		{ name: 'lease_token', kind: 'text', nullable: true },
		{ name: 'lease_expires_at', kind: 'text', nullable: true },
		{ name: 'last_error', kind: 'text', nullable: true },
		{ name: 'created_at', kind: 'text' },
		{ name: 'updated_at', kind: 'text' },
	],
	indexes: ['deduplication_key', 'status', 'available_at', 'lease_expires_at'],
}

export const learningAttemptCollectionSpec: StoreCollectionSpec<LearningAttemptRecord> =
	{
		table: 'learning_attempts',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'pending_work_id', kind: 'text' },
			{ name: 'input_ids', kind: 'json' },
			{ name: 'status', kind: 'text' },
			{ name: 'memory_revision', kind: 'integer' },
			{ name: 'config_revision', kind: 'integer' },
			{ name: 'history_id', kind: 'text' },
			{ name: 'remaining_work_id', kind: 'text', nullable: true },
			{ name: 'intent_digest', kind: 'text' },
			{ name: 'created_at', kind: 'text' },
			{ name: 'bindings', kind: 'json', nullable: true },
		],
		indexes: ['pending_work_id', 'status', 'created_at'],
	}

export const learningRevisionCollectionSpec: StoreCollectionSpec<LearningRevisionRecord> =
	{
		table: 'learning_revisions',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'memory_revision', kind: 'integer' },
			{ name: 'config_revision', kind: 'integer' },
			{ name: 'learned_state_revision', kind: 'integer', nullable: true },
			{ name: 'active_bindings', kind: 'json', nullable: true },
			{ name: 'updated_at', kind: 'text', nullable: true },
		],
	}

export const brainStateCollectionSpec: StoreCollectionSpec<BrainStateRecord> = {
	table: 'state',
	fields: [
		{ name: 'id', kind: 'text' },
		{ name: 'value', kind: 'json' },
		{ name: 'updated_at', kind: 'text' },
	],
	indexes: ['updated_at'],
}

export const brainNeuronCollectionSpec: StoreCollectionSpec<BrainNeuronRecord> =
	{
		table: 'neurons',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'type', kind: 'text' },
		],
		indexes: ['type'],
	}

export const brainInternalNeuronCollectionSpec: StoreCollectionSpec<BrainNeuronRecord> =
	{
		...brainNeuronCollectionSpec,
		table: 'internal_neurons',
	}

export const brainEvolutionCollectionSpec: StoreCollectionSpec<BrainEvolutionRecord> =
	{
		table: 'evolution',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'decisions', kind: 'json' },
			{ name: 'source', kind: 'text' },
			{ name: 'created_at', kind: 'text' },
		],
		indexes: ['created_at'],
	}

export const dismissedBatchCollectionSpec: StoreCollectionSpec<DismissedBatchRecord> =
	{
		table: 'dismissed_batches',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'data', kind: 'json' },
			{ name: 'gaps', kind: 'json' },
			{ name: 'timestamp', kind: 'text' },
			{ name: 'retryCount', kind: 'integer', defaultSql: '0' },
			{ name: 'status', kind: 'text', defaultSql: "'pending'" },
		],
		indexes: ['status', 'timestamp'],
	}

export const brainRegistryHeadCollectionSpec: StoreCollectionSpec<BrainRegistryHeadRecord> =
	{
		table: 'registry_heads',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'revision_id', kind: 'text' },
			{ name: 'revision', kind: 'integer' },
			{ name: 'updated_at', kind: 'text' },
		],
		indexes: ['revision_id'],
	}

export const brainRegistryRevisionCollectionSpec: StoreCollectionSpec<BrainRegistryRevisionRecord> =
	{
		table: 'registry_revisions',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'revision', kind: 'integer' },
			{ name: 'parent_id', kind: 'text', nullable: true },
			{ name: 'activation_id', kind: 'text', nullable: true },
			{ name: 'lenses', kind: 'json' },
			{ name: 'created_at', kind: 'text' },
		],
		indexes: ['revision', 'activation_id'],
	}

export const brainEvolutionActivationCollectionSpec: StoreCollectionSpec<BrainEvolutionActivationRecord> =
	{
		table: 'evolution_activations',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'proposal_id', kind: 'text' },
			{ name: 'action', kind: 'text' },
			{ name: 'intent_digest', kind: 'text' },
			{ name: 'mode', kind: 'text' },
			{ name: 'base_registry_revision_id', kind: 'text' },
			{ name: 'target_registry', kind: 'json' },
			{ name: 'source_pins', kind: 'json' },
			{ name: 'affected_lens_ids', kind: 'json' },
			{ name: 'staging_policy', kind: 'json' },
			{ name: 'transformation_ref', kind: 'json', nullable: true },
			{ name: 'deletion_mode', kind: 'text', nullable: true },
			{ name: 'status', kind: 'text' },
			{ name: 'error', kind: 'text', nullable: true },
			{ name: 'created_at', kind: 'text' },
			{ name: 'updated_at', kind: 'text' },
		],
		indexes: ['proposal_id', 'status', 'target_registry'],
	}

export const brainEvolutionStageCollectionSpec: StoreCollectionSpec<BrainEvolutionStageRecord> =
	{
		table: 'evolution_stages',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'activation_id', kind: 'text' },
			{ name: 'lens_id', kind: 'text' },
			{ name: 'physical_store_id', kind: 'text' },
			{ name: 'lens', kind: 'json' },
			{ name: 'snapshot', kind: 'json', nullable: true },
			{ name: 'status', kind: 'text' },
			{ name: 'created_at', kind: 'text' },
			{ name: 'updated_at', kind: 'text' },
		],
		indexes: ['activation_id', 'lens_id', 'physical_store_id', 'status'],
	}

export const brainMemoryMappingCollectionSpec: StoreCollectionSpec<BrainMemoryMappingRecord> =
	{
		table: 'evolution_memory_mappings',
		fields: [
			{ name: 'id', kind: 'text' },
			{ name: 'activation_id', kind: 'text' },
			{ name: 'source_lens_id', kind: 'text' },
			{ name: 'source_memory_id', kind: 'text' },
			{ name: 'target_lens_id', kind: 'text', nullable: true },
			{ name: 'target_memory_id', kind: 'text', nullable: true },
			{ name: 'disposition', kind: 'text' },
			{ name: 'history', kind: 'json' },
			{ name: 'created_at', kind: 'text' },
		],
		indexes: [
			'activation_id',
			'source_lens_id',
			'target_lens_id',
			'disposition',
		],
	}
