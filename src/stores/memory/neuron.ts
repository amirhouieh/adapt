/**
 * In-memory store implementation — pure TypeScript, zero dependencies.
 *
 * MemoryNeuronCollection<T> backs every namespace with a plain array.
 * MemoryNeuronStore assembles 4 collections into a Store.
 */

import { guardNeuronStore, isPromiseLike } from '../internal/atomic'
import { createNeuronStoreCollections } from '../internal/builders'
import { createLearningCommitStore } from '../internal/learning'
import { extractStrings } from '../internal/search'
import type { StoreCollectionSpec } from '../internal/specs'
import type {
	AtomicNeuronStore,
	EvolutionRecord,
	LearningAttemptRecord,
	LearningCommitStore,
	LearningHistoryRecord,
	LearningRevisionRecord,
	LearningStoreOptions,
	MemoryChangeRecord,
	NeuronCollection,
	NeuronStore,
	ObservationRecord,
	OutboxRecord,
	PendingInputRecord,
	PendingWorkRecord,
	ProcessedInputRecord,
	StateRecord,
	UnderstandingRecord,
} from '../types'
import { MemoryNeuronCollection } from './collection'

export { extractStrings, MemoryNeuronCollection }

function asMemoryCollection<T extends { id: string }>(
	collection: NeuronCollection<T>,
): MemoryNeuronCollection<T> {
	return collection as MemoryNeuronCollection<T>
}

// ── MemoryNeuronStore ─────────────────────────────────────────────────────────────

export class MemoryNeuronStore implements NeuronStore {
	observations: MemoryNeuronCollection<ObservationRecord>
	understanding: MemoryNeuronCollection<UnderstandingRecord>
	evolution: MemoryNeuronCollection<EvolutionRecord>
	state: MemoryNeuronCollection<StateRecord>
	learningHistory: MemoryNeuronCollection<LearningHistoryRecord>
	memoryChanges: MemoryNeuronCollection<MemoryChangeRecord>
	pendingWork: MemoryNeuronCollection<PendingWorkRecord>
	pendingInputs: MemoryNeuronCollection<PendingInputRecord>
	processedInputs: MemoryNeuronCollection<ProcessedInputRecord>
	outbox: MemoryNeuronCollection<OutboxRecord>
	learningAttempts: MemoryNeuronCollection<LearningAttemptRecord>
	learningRevisions: MemoryNeuronCollection<LearningRevisionRecord>
	learning: LearningCommitStore
	private atomicTail = Promise.resolve()

	constructor(options: LearningStoreOptions = {}) {
		const createCollection = <T extends { id: string }>(
			spec: StoreCollectionSpec<T>,
		): MemoryNeuronCollection<T> => new MemoryNeuronCollection(spec)
		const collections = createNeuronStoreCollections(createCollection)
		this.observations = asMemoryCollection(collections.observations)
		this.understanding = asMemoryCollection(collections.understanding)
		this.evolution = asMemoryCollection(collections.evolution)
		this.state = asMemoryCollection(collections.state)
		this.learningHistory = asMemoryCollection(collections.learningHistory)
		this.memoryChanges = asMemoryCollection(collections.memoryChanges)
		this.pendingWork = asMemoryCollection(collections.pendingWork)
		this.pendingInputs = asMemoryCollection(collections.pendingInputs)
		this.processedInputs = asMemoryCollection(collections.processedInputs)
		this.outbox = asMemoryCollection(collections.outbox)
		this.learningAttempts = asMemoryCollection(collections.learningAttempts)
		this.learningRevisions = asMemoryCollection(collections.learningRevisions)
		this.learning = createLearningCommitStore(
			(operation) => this.runAtomic(operation),
			options,
		)
	}

	async runAtomic<TResult>(
		operation: (store: AtomicNeuronStore) => TResult,
	): Promise<TResult> {
		const previous = this.atomicTail
		let release = () => {}
		this.atomicTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous

		const rollbacks = this.rollbackActions()
		const scope = { active: true }
		try {
			const result = operation(guardNeuronStore(this.atomicView(), scope))
			if (isPromiseLike(result)) {
				void Promise.resolve(result).catch(() => undefined)
				throw new Error('Atomic store operations must be synchronous')
			}
			return result
		} catch (error) {
			for (const rollback of rollbacks) rollback()
			throw error
		} finally {
			scope.active = false
			release()
		}
	}

	private rollbackActions(): Array<() => void> {
		const observations = this.observations.snapshot()
		const understanding = this.understanding.snapshot()
		const evolution = this.evolution.snapshot()
		const state = this.state.snapshot()
		const learningHistory = this.learningHistory.snapshot()
		const memoryChanges = this.memoryChanges.snapshot()
		const pendingWork = this.pendingWork.snapshot()
		const pendingInputs = this.pendingInputs.snapshot()
		const processedInputs = this.processedInputs.snapshot()
		const outbox = this.outbox.snapshot()
		const learningAttempts = this.learningAttempts.snapshot()
		const learningRevisions = this.learningRevisions.snapshot()
		return [
			() => this.observations.restore(observations),
			() => this.understanding.restore(understanding),
			() => this.evolution.restore(evolution),
			() => this.state.restore(state),
			() => this.learningHistory.restore(learningHistory),
			() => this.memoryChanges.restore(memoryChanges),
			() => this.pendingWork.restore(pendingWork),
			() => this.pendingInputs.restore(pendingInputs),
			() => this.processedInputs.restore(processedInputs),
			() => this.outbox.restore(outbox),
			() => this.learningAttempts.restore(learningAttempts),
			() => this.learningRevisions.restore(learningRevisions),
		]
	}

	private atomicView(): AtomicNeuronStore {
		return {
			observations: this.observations.atomic(),
			understanding: this.understanding.atomic(),
			evolution: this.evolution.atomic(),
			state: this.state.atomic(),
			learningHistory: this.learningHistory.atomic(),
			memoryChanges: this.memoryChanges.atomic(),
			pendingWork: this.pendingWork.atomic(),
			pendingInputs: this.pendingInputs.atomic(),
			processedInputs: this.processedInputs.atomic(),
			outbox: this.outbox.atomic(),
			learningAttempts: this.learningAttempts.atomic(),
			learningRevisions: this.learningRevisions.atomic(),
		}
	}

	async dispose(): Promise<void> {
		/* no-op for in-memory */
	}
}
