import { extractStrings } from '../../internal/search'
import type { StoreCollectionSpec } from '../../internal/specs'
import type {
	AtomicCollection,
	BrainCollection,
	NeuronCollection,
} from '../../types'
import type { SQLiteDatabase } from './types'

function serializeValue(value: unknown, json: boolean): unknown {
	if (value === undefined) return null
	return json ? JSON.stringify(value) : (value ?? null)
}

function ftsContent<T extends { id: string }>(
	item: T,
	spec: StoreCollectionSpec<T>,
): string {
	const jsonColumns = spec.fields
		.filter((field) => field.kind === 'json')
		.map((field) => field.name)
	const parts: string[] = []

	for (const column of jsonColumns) {
		const raw = item[column]
		if (raw !== undefined && raw !== null) {
			parts.push(...extractStrings(raw))
		}
	}

	for (const [key, value] of Object.entries(item)) {
		if (
			key !== 'id' &&
			!jsonColumns.includes(key as keyof T & string) &&
			typeof value === 'string'
		) {
			parts.push(value)
		}
	}

	return parts.join(' ')
}

class SQLiteCollectionBase<T extends { id: string }> {
	private readonly ftsTable: string | null

	constructor(
		protected readonly db: SQLiteDatabase,
		protected readonly spec: StoreCollectionSpec<T>,
	) {
		this.ftsTable =
			spec.search?.strategy === 'fulltext' ? `${spec.table}_fts` : null
	}

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
		if (!filter) {
			const row = this.db
				.prepare(`SELECT COUNT(*) as cnt FROM ${this.spec.table}`)
				.get() as { cnt: number } | undefined
			return row?.cnt ?? 0
		}

		const entries = Object.entries(filter)
		const where = entries.map(([key]) => `${key} = ?`).join(' AND ')
		const values = entries.map(([, value]) => value)
		const row = this.db
			.prepare(`SELECT COUNT(*) as cnt FROM ${this.spec.table} WHERE ${where}`)
			.get(...values) as { cnt: number } | undefined
		return row?.cnt ?? 0
	}

	async search(query: string): Promise<T[]> {
		if (this.ftsTable) {
			const terms = query
				.split(/\s+/)
				.filter(Boolean)
				.map((term) => `"${term.replace(/"/g, '""')}"`)
			if (terms.length === 0) return []
			const ftsQuery = terms.join(' AND ')
			const rows = this.db
				.prepare(
					`SELECT t.* FROM ${this.spec.table} t INNER JOIN ${this.ftsTable} f ON t.id = f.id WHERE f.${this.ftsTable} MATCH ?`,
				)
				.all(ftsQuery)
			return rows.map((row) => this.parseRow(row))
		}

		const allItems = await this.list()
		const normalizedQuery = query.toLowerCase()
		return allItems.filter((item) =>
			extractStrings(item).some((value) =>
				value.toLowerCase().includes(normalizedQuery),
			),
		)
	}

	async addBatch(items: T[]): Promise<void> {
		const columns = this.spec.fields.map((field) => field.name)
		const placeholders = columns.map(() => '?').join(', ')
		const insertStatement = this.db.prepare(
			`INSERT INTO ${this.spec.table} (${columns.join(', ')}) VALUES (${placeholders})`,
		)
		const ftsStatement = this.ftsTable
			? this.db.prepare(
					`INSERT INTO ${this.ftsTable} (id, content) VALUES (?, ?)`,
				)
			: null

		const insertMany = this.db.transaction((rows: T[]) => {
			for (const item of rows) {
				const values = this.spec.fields.map((field) =>
					serializeValue(item[field.name], field.kind === 'json'),
				)
				insertStatement.run(...values)
				ftsStatement?.run(item.id, ftsContent(item, this.spec))
			}
		})

		insertMany(items)
	}

	async dispose(): Promise<void> {
		/* no-op — store-level dispose handles db close */
	}

	atomic(): AtomicCollection<T> {
		return {
			add: (item) => {
				const columns = this.spec.fields.map((field) => field.name)
				const placeholders = columns.map(() => '?').join(', ')
				const values = this.spec.fields.map((field) =>
					serializeValue(item[field.name], field.kind === 'json'),
				)
				this.db
					.prepare(
						`INSERT INTO ${this.spec.table} (${columns.join(', ')}) VALUES (${placeholders})`,
					)
					.run(...values)
				if (this.ftsTable) {
					this.db
						.prepare(`INSERT INTO ${this.ftsTable} (id, content) VALUES (?, ?)`)
						.run(item.id, ftsContent(item, this.spec))
				}
			},
			get: (id) => {
				const row = this.db
					.prepare(`SELECT * FROM ${this.spec.table} WHERE id = ?`)
					.get(id)
				return row ? this.parseRow(row) : undefined
			},
			list: (filter) => {
				if (!filter || Object.keys(filter).length === 0) {
					return this.db
						.prepare(`SELECT * FROM ${this.spec.table}`)
						.all()
						.map((row) => this.parseRow(row))
				}
				const entries = Object.entries(filter)
				const where = entries.map(([key]) => `${key} = ?`).join(' AND ')
				const values = entries.map(([, value]) => value)
				return this.db
					.prepare(`SELECT * FROM ${this.spec.table} WHERE ${where}`)
					.all(...values)
					.map((row) => this.parseRow(row))
			},
			update: (id, changes) => {
				const row = this.db
					.prepare(`SELECT * FROM ${this.spec.table} WHERE id = ?`)
					.get(id)
				if (!row) throw new Error(`Record with id "${id}" not found`)
				const merged = { ...this.parseRow(row), ...changes }
				const fields = this.spec.fields.filter((field) => field.name !== 'id')
				const setClauses = fields.map((field) => `${field.name} = ?`).join(', ')
				const values = fields.map((field) =>
					serializeValue(merged[field.name], field.kind === 'json'),
				)
				this.db
					.prepare(`UPDATE ${this.spec.table} SET ${setClauses} WHERE id = ?`)
					.run(...values, id)
				if (this.ftsTable) {
					this.db
						.prepare(`UPDATE ${this.ftsTable} SET content = ? WHERE id = ?`)
						.run(ftsContent(merged, this.spec), id)
				}
			},
			delete: (id) => {
				const result = this.db
					.prepare(`DELETE FROM ${this.spec.table} WHERE id = ?`)
					.run(id)
				if (result.changes === 0) {
					throw new Error(`Record with id "${id}" not found`)
				}
				if (this.ftsTable) {
					this.db.prepare(`DELETE FROM ${this.ftsTable} WHERE id = ?`).run(id)
				}
			},
			clear: () => {
				this.db.prepare(`DELETE FROM ${this.spec.table}`).run()
				if (this.ftsTable) this.db.prepare(`DELETE FROM ${this.ftsTable}`).run()
			},
		}
	}

	protected parseRow(row: Record<string, unknown>): T {
		const result: Record<string, unknown> = {}
		for (const field of this.spec.fields) {
			const raw = row[field.name]
			if (raw === null && field.preserveNull) {
				result[field.name] = null
			} else if (raw === null && field.nullable) {
			} else if (field.kind === 'json' && typeof raw === 'string') {
				result[field.name] = JSON.parse(raw)
			} else {
				result[field.name] = raw ?? undefined
			}
		}
		return result as T
	}
}

export class SQLiteNeuronCollection<T extends { id: string }>
	extends SQLiteCollectionBase<T>
	implements NeuronCollection<T> {}

export class SQLiteBrainCollection<T extends { id: string }>
	extends SQLiteCollectionBase<T>
	implements BrainCollection<T> {}
