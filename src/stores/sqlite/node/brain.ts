/**
 * SQLite brain store implementation — persistent adapter using better-sqlite3.
 */

import * as path from 'node:path'
import { guardBrainStore, isPromiseLike } from '../../internal/atomic'
import { createBrainStoreCollections } from '../../internal/builders'
import {
	brainEvolutionCollectionSpec,
	brainInternalNeuronCollectionSpec,
	brainNeuronCollectionSpec,
	brainStateCollectionSpec,
	dismissedBatchCollectionSpec,
	type StoreCollectionSpec,
} from '../../internal/specs'
import type {
	AtomicBrainStore,
	BrainCollection,
	BrainEvolutionRecord,
	BrainNeuronRecord,
	BrainStateRecord,
	BrainStore,
	DismissedBatchRecord,
	NeuronStore,
} from '../../types'
import { SQLiteBrainCollection } from '../core/collection'
import { ensureSqliteCollectionSchema } from '../core/schema'
import type { SQLiteDatabase } from '../core/types'
import { openNodeSQLiteDatabase } from './driver'
import { SQLiteNeuronStore } from './neuron'

export { SQLiteBrainCollection }

function initializeBrainStoreSchema(db: SQLiteDatabase): void {
	ensureSqliteCollectionSchema(db, brainStateCollectionSpec)
	ensureSqliteCollectionSchema(db, brainNeuronCollectionSpec)
	ensureSqliteCollectionSchema(db, brainInternalNeuronCollectionSpec)
	ensureSqliteCollectionSchema(db, brainEvolutionCollectionSpec)
	ensureSqliteCollectionSchema(db, dismissedBatchCollectionSpec)
}

export class SQLiteBrainStore implements BrainStore {
	private readonly db: SQLiteDatabase
	private readonly path: string
	private readonly neuronStores = new Map<string, SQLiteNeuronStore>()
	state: BrainCollection<BrainStateRecord>
	neurons: BrainCollection<BrainNeuronRecord>
	internalNeurons: BrainCollection<BrainNeuronRecord>
	evolution: BrainCollection<BrainEvolutionRecord>
	dismissedBatches: BrainCollection<DismissedBatchRecord>

	constructor(dbPath: string = ':memory:') {
		this.path = dbPath
		this.db = openNodeSQLiteDatabase(dbPath)
		this.db.exec('PRAGMA journal_mode = WAL')
		initializeBrainStoreSchema(this.db)

		const createCollection = <T extends { id: string }>(
			spec: StoreCollectionSpec<T>,
		): BrainCollection<T> => new SQLiteBrainCollection(this.db, spec)
		const collections = createBrainStoreCollections(createCollection)
		this.state = collections.state
		this.neurons = collections.neurons
		this.internalNeurons = collections.internalNeurons
		this.evolution = collections.evolution
		this.dismissedBatches = collections.dismissedBatches
	}

	getNeuronStore(neuronId: string): NeuronStore {
		let store = this.neuronStores.get(neuronId)
		if (!store) {
			store = new SQLiteNeuronStore(neuronStorePath(this.path, neuronId))
			this.neuronStores.set(neuronId, store)
		}
		return store
	}

	async runAtomic<TResult>(
		operation: (store: AtomicBrainStore) => TResult,
	): Promise<TResult> {
		return this.db.transaction(() => {
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
						},
						scope,
					),
				)
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

	async dispose(): Promise<void> {
		for (const store of this.neuronStores.values()) {
			await store.dispose()
		}
		this.neuronStores.clear()
		this.db.close()
	}
}

/**
 * Sibling file with the brain DB's stem as prefix:
 * `/data/brain.db` + `coding` → `/data/brain.coding.db`
 * `:memory:` keeps the per-process file-less convention.
 */
function neuronStorePath(brainPath: string, neuronId: string): string {
	if (brainPath === ':memory:') return ':memory:'
	const dir = path.dirname(brainPath)
	const base = path.basename(brainPath)
	const ext = path.extname(base)
	const stem = ext ? base.slice(0, -ext.length) : base
	return path.join(dir, `${stem}.${neuronId}${ext}`)
}
