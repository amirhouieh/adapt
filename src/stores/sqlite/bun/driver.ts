import { Database } from 'bun:sqlite'
import type {
	SQLiteDatabase,
	SQLiteRunResult,
	SQLiteStatement,
} from '../core/types'

function createStatement<Row>(
	statement: ReturnType<Database['prepare']>,
): SQLiteStatement<Row> {
	return {
		run(...params: unknown[]): SQLiteRunResult {
			const result = statement.run(...params) as {
				changes?: number
			}
			return { changes: result.changes ?? 0 }
		},
		get(...params: unknown[]): Row | undefined {
			const row = statement.get(...params) as Row | null
			return row ?? undefined
		},
		all(...params: unknown[]): Row[] {
			return statement.all(...params) as Row[]
		},
	}
}

export function openBunSQLiteDatabase(
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
			return (...args: TArgs): TResult => {
				let result: TResult | undefined
				let completed = false
				const transaction = db.transaction((...innerArgs: TArgs) => {
					result = fn(...innerArgs)
					completed = true
				})
				transaction(...args)
				if (!completed) {
					throw new Error('SQLite transaction did not return a result')
				}
				return result as TResult
			}
		},
		close(): void {
			db.close()
		},
	}
}
