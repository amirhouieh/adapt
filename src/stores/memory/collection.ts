import { matchesSearchQuery } from '../internal/search'
import type { StoreCollectionSpec } from '../internal/specs'
import type {
	AtomicCollection,
	BrainCollection,
	NeuronCollection,
} from '../types'

class MemoryRecordCollection<T extends { id: string }> {
	private items: T[] = []

	constructor(protected readonly spec?: StoreCollectionSpec<T>) {}

	async add(item: T): Promise<void> {
		this.atomic().add(item)
	}

	async get(id: string): Promise<T | undefined> {
		return this.atomic().get(id)
	}

	async list(filter?: Record<string, unknown>): Promise<T[]> {
		return this.atomic().list(filter)
	}

	async update(id: string, changes: Partial<Omit<T, 'id'>>): Promise<void> {
		this.atomic().update(id, changes)
	}

	async delete(id: string): Promise<void> {
		this.atomic().delete(id)
	}

	async clear(): Promise<void> {
		this.atomic().clear()
	}

	async count(filter?: Record<string, unknown>): Promise<number> {
		if (!filter) return this.items.length
		const filtered = this.items.filter((item) =>
			Object.entries(filter).every(
				([key, value]) => (item as Record<string, unknown>)[key] === value,
			),
		)
		return filtered.length
	}

	async search(query: string): Promise<T[]> {
		return structuredClone(
			this.items.filter((item) => matchesSearchQuery(item, query)),
		)
	}

	async addBatch(items: T[]): Promise<void> {
		const atomic = this.atomic()
		for (const item of items) atomic.add(item)
	}

	async dispose(): Promise<void> {
		/* no-op for in-memory */
	}

	atomic(): AtomicCollection<T> {
		return {
			add: (item) => {
				if (this.items.some((existing) => existing.id === item.id)) {
					throw new Error(`Record with id "${item.id}" already exists`)
				}
				this.items.push(structuredClone(item))
			},
			get: (id) => {
				const item = this.items.find((record) => record.id === id)
				return item ? structuredClone(item) : undefined
			},
			list: (filter) => {
				const matches =
					!filter || Object.keys(filter).length === 0
						? this.items
						: this.items.filter((item) =>
								Object.entries(filter).every(
									([key, value]) =>
										(item as Record<string, unknown>)[key] === value,
								),
							)
				return structuredClone(matches)
			},
			update: (id, changes) => {
				const index = this.items.findIndex((item) => item.id === id)
				if (index === -1) throw new Error(`Record with id "${id}" not found`)
				this.items[index] = structuredClone({
					...this.items[index],
					...changes,
				})
			},
			delete: (id) => {
				const index = this.items.findIndex((item) => item.id === id)
				if (index === -1) throw new Error(`Record with id "${id}" not found`)
				this.items.splice(index, 1)
			},
			clear: () => {
				this.items = []
			},
		}
	}

	snapshot(): T[] {
		return structuredClone(this.items)
	}

	restore(snapshot: T[]): void {
		this.items = structuredClone(snapshot)
	}
}

export class MemoryNeuronCollection<T extends { id: string }>
	extends MemoryRecordCollection<T>
	implements NeuronCollection<T> {}

export class MemoryBrainCollection<T extends { id: string }>
	extends MemoryRecordCollection<T>
	implements BrainCollection<T> {}
