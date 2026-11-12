import Database from 'better-sqlite3'
import type {
	SQLiteDatabase,
	SQLiteRunResult,
	SQLiteStatement,
} from '../core/types'

function createStatement<Row>(
	statement: ReturnType<Database.Database['prepare']>,
): SQLiteStatement<Row> {
	const normalizedStatement = statement as {
		run(...params: unknown[]): { changes: number }
		get(...params: unknown[]): Row | undefined
		all(...params: unknown[]): Row[]
	}

	return {
		run(...params: unknown[]): SQLiteRunResult {
			const result = normalizedStatement.run(...params)
			return { changes: result.changes }
		},
		get(...params: unknown[]): Row | undefined {
			return normalizedStatement.get(...params)
		},
		all(...params: unknown[]): Row[] {
			return normalizedStatement.all(...params)
		},
	}
}

export function openNodeSQLiteDatabase(
	path: string = ':memory:',
): SQLiteDatabase {
	const db = new Database(path)

	return {
		exec(sql: string): void {
			db.exec(sql)
		},
		prepare<Row = Record<string, unknown>>(sql: string): SQLiteStatement<Row> {
			return createStatement<Row>(db.prepare(sql))
		},
		transaction<TArgs extends unknown[], TResult>(
			fn: (...args: TArgs) => TResult,
		): (...args: TArgs) => TResult {
			return db.transaction(fn)
		},
		close(): void {
			db.close()
		},
	}
}
