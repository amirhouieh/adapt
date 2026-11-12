import type {
	LegacyV006BrainSource,
	LegacyV006BrainStoreReader,
	LegacyV006NeuronSource,
	LegacyV006NeuronStoreReader,
	LegacyV006StoreKind,
} from './contracts'

interface SourceDescriptor {
	sourceId: string
	storeKind: LegacyV006StoreKind
	declaredVersion: string
	assertExclusive(): void | Promise<void>
}

export interface LegacyV006NeuronSourceInput extends SourceDescriptor {
	store: LegacyV006NeuronStoreReader
	lensId: string
	lensType: string
}

export interface LegacyV006BrainSourceInput extends SourceDescriptor {
	store: LegacyV006BrainStoreReader
}

async function readNeuronStore(
	store: LegacyV006NeuronStoreReader,
): Promise<Awaited<ReturnType<LegacyV006NeuronSource['read']>>> {
	const stateCollection = store.state
	const observationCollection = store.observations
	const understandingCollection = store.understanding
	const evolutionCollection = store.evolution
	const [state, observations, understanding, evolution] = await Promise.all([
		stateCollection.list(),
		observationCollection.list(),
		understandingCollection.list(),
		evolutionCollection.list(),
	])
	return structuredClone({ state, observations, understanding, evolution })
}

export function createLegacyV006NeuronSource(
	input: LegacyV006NeuronSourceInput,
): LegacyV006NeuronSource {
	const sourceId = input.sourceId
	const storeKind = input.storeKind
	const declaredVersion = input.declaredVersion
	const lensId = input.lensId
	const lensType = input.lensType
	const assertExclusive = input.assertExclusive
	const store = input.store
	return {
		kind: 'neuron',
		sourceId,
		storeKind,
		declaredVersion,
		lensId,
		lensType,
		async read() {
			await assertExclusive()
			return readNeuronStore(store)
		},
	}
}

export function createLegacyV006BrainSource(
	input: LegacyV006BrainSourceInput,
): LegacyV006BrainSource {
	const sourceId = input.sourceId
	const storeKind = input.storeKind
	const declaredVersion = input.declaredVersion
	const assertExclusive = input.assertExclusive
	const store = input.store
	return {
		kind: 'brain',
		sourceId,
		storeKind,
		declaredVersion,
		async read() {
			await assertExclusive()
			const stateCollection = store.state
			const neuronCollection = store.neurons
			const internalNeuronCollection = store.internalNeurons
			const evolutionCollection = store.evolution
			const dismissedBatchCollection = store.dismissedBatches
			const [state, neurons, internalNeurons, evolution, dismissedBatches] =
				await Promise.all([
					stateCollection.list(),
					neuronCollection.list(),
					internalNeuronCollection.list(),
					evolutionCollection.list(),
					dismissedBatchCollection.list(),
				])
			const lenses = []
			for (const record of neurons) {
				lenses.push({
					record,
					internal: false,
					store: await readNeuronStore(store.getNeuronStore(record.id)),
				})
			}
			for (const record of internalNeurons) {
				lenses.push({
					record,
					internal: true,
					store: await readNeuronStore(store.getNeuronStore(record.id)),
				})
			}
			return structuredClone({
				state,
				neurons,
				internalNeurons,
				evolution,
				dismissedBatches,
				lenses,
			})
		},
	}
}
