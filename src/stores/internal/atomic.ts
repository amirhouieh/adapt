import type {
	AtomicBrainStore,
	AtomicCollection,
	AtomicNeuronStore,
} from '../types'

export interface AtomicScope {
	active: boolean
}

function ensureActive(scope: AtomicScope): void {
	if (!scope.active)
		throw new Error('Atomic store transaction is no longer active')
}

function guardCollection<T extends { id: string }>(
	collection: AtomicCollection<T>,
	scope: AtomicScope,
): AtomicCollection<T> {
	return {
		add: (item) => {
			ensureActive(scope)
			collection.add(item)
		},
		get: (id) => {
			ensureActive(scope)
			return collection.get(id)
		},
		list: (filter) => {
			ensureActive(scope)
			return collection.list(filter)
		},
		update: (id, changes) => {
			ensureActive(scope)
			collection.update(id, changes)
		},
		delete: (id) => {
			ensureActive(scope)
			collection.delete(id)
		},
		clear: () => {
			ensureActive(scope)
			collection.clear()
		},
	}
}

export function guardNeuronStore(
	store: AtomicNeuronStore,
	scope: AtomicScope,
): AtomicNeuronStore {
	return {
		observations: guardCollection(store.observations, scope),
		understanding: guardCollection(store.understanding, scope),
		evolution: guardCollection(store.evolution, scope),
		state: guardCollection(store.state, scope),
		learningHistory: guardCollection(store.learningHistory, scope),
		memoryChanges: guardCollection(store.memoryChanges, scope),
		pendingWork: guardCollection(store.pendingWork, scope),
		pendingInputs: guardCollection(store.pendingInputs, scope),
		processedInputs: guardCollection(store.processedInputs, scope),
		outbox: guardCollection(store.outbox, scope),
		learningAttempts: guardCollection(store.learningAttempts, scope),
		learningRevisions: guardCollection(store.learningRevisions, scope),
	}
}

export function guardBrainStore(
	store: AtomicBrainStore,
	scope: AtomicScope,
): AtomicBrainStore {
	return {
		state: guardCollection(store.state, scope),
		neurons: guardCollection(store.neurons, scope),
		internalNeurons: guardCollection(store.internalNeurons, scope),
		evolution: guardCollection(store.evolution, scope),
		dismissedBatches: guardCollection(store.dismissedBatches, scope),
		registryHeads: guardCollection(store.registryHeads, scope),
		registryRevisions: guardCollection(store.registryRevisions, scope),
		evolutionActivations: guardCollection(store.evolutionActivations, scope),
		evolutionStages: guardCollection(store.evolutionStages, scope),
		memoryMappings: guardCollection(store.memoryMappings, scope),
	}
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		'then' in value &&
		typeof value.then === 'function'
	)
}
