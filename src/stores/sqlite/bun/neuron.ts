/**
 * SQLite store implementation — persistent adapter using bun:sqlite.
 */

import { guardNeuronStore, isPromiseLike } from '../../internal/atomic'
import { createNeuronStoreCollections } from '../../internal/builders'
import { createLearningCommitStore } from '../../internal/learning'
import {
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
} from '../../internal/specs'
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
} from '../../types'
import { SQLiteNeuronCollection } from '../core/collection'
import { ensureSqliteCollectionSchema } from '../core/schema'
import type { SQLiteDatabase } from '../core/types'
import { openBunSQLiteDatabase } from './driver'

export { SQLiteNeuronCollection }

function initializeNeuronStoreSchema(db: SQLiteDatabase): void {
	ensureSqliteCollectionSchema(db, observationCollectionSpec)
	ensureSqliteCollectionSchema(db, understandingCollectionSpec)
	ensureSqliteCollectionSchema(db, neuronEvolutionCollectionSpec)
	ensureSqliteCollectionSchema(db, neuronStateCollectionSpec)
	ensureSqliteCollectionSchema(db, learningHistoryCollectionSpec)
	ensureSqliteCollectionSchema(db, memoryChangeCollectionSpec)
	ensureSqliteCollectionSchema(db, pendingWorkCollectionSpec)
	ensureSqliteCollectionSchema(db, pendingInputCollectionSpec)
	ensureSqliteCollectionSchema(db, processedInputCollectionSpec)
	ensureSqliteCollectionSchema(db, outboxCollectionSpec)
	ensureSqliteCollectionSchema(db, learningAttemptCollectionSpec)
	ensureSqliteCollectionSchema(db, learningRevisionCollectionSpec)
}

export class SQLiteNeuronStore implements NeuronStore {
	private readonly db: SQLiteDatabase
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

	constructor(path: string = ':memory:', options: LearningStoreOptions = {}) {
		this.db = openBunSQLiteDatabase(path)
		this.db.exec('PRAGMA journal_mode = WAL')
		initializeNeuronStoreSchema(this.db)

		const createCollection = <T extends { id: string }>(
			spec: StoreCollectionSpec<T>,
		): SQLiteNeuronCollection<T> => new SQLiteNeuronCollection(this.db, spec)
		const collections = createNeuronStoreCollections(createCollection)
		this.observations = collections.observations
		this.understanding = collections.understanding
		this.evolution = collections.evolution
		this.state = collections.state
		this.learningHistory = collections.learningHistory
		this.memoryChanges = collections.memoryChanges
		this.pendingWork = collections.pendingWork
		this.pendingInputs = collections.pendingInputs
		this.processedInputs = collections.processedInputs
		this.outbox = collections.outbox
		this.learningAttempts = collections.learningAttempts
		this.learningRevisions = collections.learningRevisions
		this.learning = createLearningCommitStore(
			(operation) => this.runAtomic(operation),
			options,
		)
	}

	async runAtomic<TResult>(
		operation: (store: AtomicNeuronStore) => TResult,
	): Promise<TResult> {
		return this.db.transaction(() => {
			const scope = { active: true }
			try {
				const result = operation(guardNeuronStore(this.atomicView(), scope))
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch(() => undefined)
					throw new Error('Atomic store operations must be synchronous')
				}
				return result
			} finally {
				scope.active = false
			}
		})()
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
		this.db.close()
	}
}
