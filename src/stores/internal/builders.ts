import type {
	BrainCollection,
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
	NeuronCollection,
	ObservationRecord,
	OutboxRecord,
	PendingInputRecord,
	PendingWorkRecord,
	ProcessedInputRecord,
	StateRecord,
	UnderstandingRecord,
} from '../types'
import {
	brainEvolutionCollectionSpec,
	brainEvolutionActivationCollectionSpec,
	brainEvolutionStageCollectionSpec,
	brainInternalNeuronCollectionSpec,
	brainMemoryMappingCollectionSpec,
	brainNeuronCollectionSpec,
	brainRegistryHeadCollectionSpec,
	brainRegistryRevisionCollectionSpec,
	brainStateCollectionSpec,
	dismissedBatchCollectionSpec,
	learningAttemptCollectionSpec,
	learningHistoryCollectionSpec,
	learningRevisionCollectionSpec,
	memoryChangeCollectionSpec,
	neuronEvolutionCollectionSpec,
	neuronStateCollectionSpec,
	observationCollectionSpec,
	outboxCollectionSpec,
	pendingInputCollectionSpec,
	pendingWorkCollectionSpec,
	processedInputCollectionSpec,
	type StoreCollectionSpec,
	understandingCollectionSpec,
} from './specs'

export interface NeuronStoreCollections {
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
}

export interface BrainStoreCollections {
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
}

export type NeuronCollectionFactory = <T extends { id: string }>(
	spec: StoreCollectionSpec<T>,
) => NeuronCollection<T>

export type BrainCollectionFactory = <T extends { id: string }>(
	spec: StoreCollectionSpec<T>,
) => BrainCollection<T>

export function createNeuronStoreCollections(
	createCollection: NeuronCollectionFactory,
): NeuronStoreCollections {
	return {
		observations: createCollection(observationCollectionSpec),
		understanding: createCollection(understandingCollectionSpec),
		evolution: createCollection(neuronEvolutionCollectionSpec),
		state: createCollection(neuronStateCollectionSpec),
		learningHistory: createCollection(learningHistoryCollectionSpec),
		memoryChanges: createCollection(memoryChangeCollectionSpec),
		pendingWork: createCollection(pendingWorkCollectionSpec),
		pendingInputs: createCollection(pendingInputCollectionSpec),
		processedInputs: createCollection(processedInputCollectionSpec),
		outbox: createCollection(outboxCollectionSpec),
		learningAttempts: createCollection(learningAttemptCollectionSpec),
		learningRevisions: createCollection(learningRevisionCollectionSpec),
	}
}

export function createBrainStoreCollections(
	createCollection: BrainCollectionFactory,
): BrainStoreCollections {
	return {
		state: createCollection(brainStateCollectionSpec),
		neurons: createCollection(brainNeuronCollectionSpec),
		internalNeurons: createCollection(brainInternalNeuronCollectionSpec),
		evolution: createCollection(brainEvolutionCollectionSpec),
		dismissedBatches: createCollection(dismissedBatchCollectionSpec),
		registryHeads: createCollection(brainRegistryHeadCollectionSpec),
		registryRevisions: createCollection(brainRegistryRevisionCollectionSpec),
		evolutionActivations: createCollection(
			brainEvolutionActivationCollectionSpec,
		),
		evolutionStages: createCollection(brainEvolutionStageCollectionSpec),
		memoryMappings: createCollection(brainMemoryMappingCollectionSpec),
	}
}
