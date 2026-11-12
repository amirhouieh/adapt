/**
 * In-memory brain store implementation — pure TypeScript, zero dependencies.
 *
 * MemoryBrainCollection<T> backs every namespace with a plain array.
 * MemoryBrainStore assembles 5 collections into a BrainStore.
 */

import { guardBrainStore, isPromiseLike } from '../internal/atomic'
import { createBrainStoreCollections } from '../internal/builders'
import type { StoreCollectionSpec } from '../internal/specs'
import type {
	AtomicBrainStore,
	BrainCollection,
	BrainEvolutionRecord,
	BrainEvolutionActivationRecord,
	BrainEvolutionStageRecord,
	BrainMemoryMappingRecord,
	BrainNeuronRecord,
	BrainRegistryHeadRecord,
	BrainRegistryRevisionRecord,
	BrainStateRecord,
	BrainStore,
	DismissedBatchRecord,
	NeuronStore,
} from '../types'
import { MemoryBrainCollection } from './collection'
import { MemoryNeuronStore } from './neuron'

export { MemoryBrainCollection }

function asMemoryCollection<T extends { id: string }>(
	collection: BrainCollection<T>,
): MemoryBrainCollection<T> {
	return collection as MemoryBrainCollection<T>
}

// ── MemoryBrainStore ─────────────────────────────────────────────────────────

export class MemoryBrainStore implements BrainStore {
	state: MemoryBrainCollection<BrainStateRecord>
	neurons: MemoryBrainCollection<BrainNeuronRecord>
	internalNeurons: MemoryBrainCollection<BrainNeuronRecord>
	evolution: MemoryBrainCollection<BrainEvolutionRecord>
	dismissedBatches: MemoryBrainCollection<DismissedBatchRecord>
	registryHeads: MemoryBrainCollection<BrainRegistryHeadRecord>
	registryRevisions: MemoryBrainCollection<BrainRegistryRevisionRecord>
	evolutionActivations: MemoryBrainCollection<BrainEvolutionActivationRecord>
	evolutionStages: MemoryBrainCollection<BrainEvolutionStageRecord>
	memoryMappings: MemoryBrainCollection<BrainMemoryMappingRecord>
	private atomicTail = Promise.resolve()

	// Cached per id — the cache IS the persistence layer for memory: a Brain
	// disposed and restored against the same MemoryBrainStore must see the
	// same neuron data on restore.
	private readonly neuronStores = new Map<string, NeuronStore>()

	constructor() {
		const createCollection = <T extends { id: string }>(
			spec: StoreCollectionSpec<T>,
		): MemoryBrainCollection<T> => new MemoryBrainCollection(spec)
		const collections = createBrainStoreCollections(createCollection)
		this.state = asMemoryCollection(collections.state)
		this.neurons = asMemoryCollection(collections.neurons)
		this.internalNeurons = asMemoryCollection(collections.internalNeurons)
		this.evolution = asMemoryCollection(collections.evolution)
		this.dismissedBatches = asMemoryCollection(collections.dismissedBatches)
		this.registryHeads = asMemoryCollection(collections.registryHeads)
		this.registryRevisions = asMemoryCollection(collections.registryRevisions)
		this.evolutionActivations = asMemoryCollection(
			collections.evolutionActivations,
		)
		this.evolutionStages = asMemoryCollection(collections.evolutionStages)
		this.memoryMappings = asMemoryCollection(collections.memoryMappings)
	}

	getNeuronStore(neuronId: string): NeuronStore {
		let store = this.neuronStores.get(neuronId)
		if (!store) {
			store = new MemoryNeuronStore()
			this.neuronStores.set(neuronId, store)
		}
		return store
	}

	async runAtomic<TResult>(
		operation: (store: AtomicBrainStore) => TResult,
	): Promise<TResult> {
		const previous = this.atomicTail
		let release = () => {}
		this.atomicTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		const state = this.state.snapshot()
		const neurons = this.neurons.snapshot()
		const internalNeurons = this.internalNeurons.snapshot()
		const evolution = this.evolution.snapshot()
		const dismissedBatches = this.dismissedBatches.snapshot()
		const registryHeads = this.registryHeads.snapshot()
		const registryRevisions = this.registryRevisions.snapshot()
		const evolutionActivations = this.evolutionActivations.snapshot()
		const evolutionStages = this.evolutionStages.snapshot()
		const memoryMappings = this.memoryMappings.snapshot()
		const scope = { active: true }
		try {
			const result = operation(
				guardBrainStore(
					{
						state: this.state.atomic(),
						neurons: this.neurons.atomic(),
						internalNeurons: this.internalNeurons.atomic(),
						evolution: this.evolution.atomic(),
						dismissedBatches: this.dismissedBatches.atomic(),
						registryHeads: this.registryHeads.atomic(),
						registryRevisions: this.registryRevisions.atomic(),
						evolutionActivations: this.evolutionActivations.atomic(),
						evolutionStages: this.evolutionStages.atomic(),
						memoryMappings: this.memoryMappings.atomic(),
					},
					scope,
				),
			)
			if (isPromiseLike(result)) {
				void Promise.resolve(result).catch(() => undefined)
				throw new Error('Atomic store operations must be synchronous')
			}
			return result
		} catch (error) {
			this.state.restore(state)
			this.neurons.restore(neurons)
			this.internalNeurons.restore(internalNeurons)
			this.evolution.restore(evolution)
			this.dismissedBatches.restore(dismissedBatches)
			this.registryHeads.restore(registryHeads)
			this.registryRevisions.restore(registryRevisions)
			this.evolutionActivations.restore(evolutionActivations)
			this.evolutionStages.restore(evolutionStages)
			this.memoryMappings.restore(memoryMappings)
			throw error
		} finally {
			scope.active = false
			release()
		}
	}

	async dispose(): Promise<void> {
		/* no-op for in-memory */
	}
}
