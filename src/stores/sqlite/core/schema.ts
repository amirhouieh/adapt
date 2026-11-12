import type { StoreCollectionSpec } from '../../internal/specs'
import type { SQLiteDatabase } from './types'

function toSqliteType(
	kind: StoreCollectionSpec<{ id: string }>['fields'][number]['kind'],
): string {
	switch (kind) {
		case 'integer':
			return 'INTEGER'
		case 'real':
			return 'REAL'
		case 'json':
		case 'text':
			return 'TEXT'
	}
}

function createColumnDefinition<T extends { id: string }>(
	field: StoreCollectionSpec<T>['fields'][number],
): string {
	const parts = [field.name, toSqliteType(field.kind)]
	if (field.name === 'id') {
		parts.push('PRIMARY KEY')
	} else if (!field.nullable) {
		parts.push('NOT NULL')
	}
	if (field.defaultSql) {
		parts.push(`DEFAULT ${field.defaultSql}`)
	}
	return parts.join(' ')
}

export function ensureSqliteCollectionSchema<T extends { id: string }>(
	db: SQLiteDatabase,
	spec: StoreCollectionSpec<T>,
): void {
	const columns = spec.fields.map(createColumnDefinition).join(',\n\t\t\t\t')
	db.exec(`
			CREATE TABLE IF NOT EXISTS ${spec.table} (
				${columns}
			)
		`)

	const existingColumns = new Set(
		db
			.prepare<{ name: string }>(`PRAGMA table_info(${spec.table})`)
			.all()
			.map((column) => column.name),
	)
	for (const field of spec.fields) {
		if (!existingColumns.has(field.name)) {
			db.exec(
				`ALTER TABLE ${spec.table} ADD COLUMN ${createColumnDefinition(field)}`,
			)
		}
	}

	for (const column of spec.indexes ?? []) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_${spec.table}_${column} ON ${spec.table}(${column})`,
		)
	}

	if (spec.search?.strategy === 'fulltext') {
		db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${spec.table}_fts USING fts5(id, content, tokenize='porter unicode61')`,
		)
	}
}
