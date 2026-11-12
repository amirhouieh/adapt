export interface SQLiteRunResult {
	changes: number
}

export interface SQLiteStatement<Row = Record<string, unknown>> {
	run(...params: unknown[]): SQLiteRunResult
	get(...params: unknown[]): Row | undefined
	all(...params: unknown[]): Row[]
}

export interface SQLiteDatabase {
	exec(sql: string): void
	prepare<Row = Record<string, unknown>>(sql: string): SQLiteStatement<Row>
	transaction<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => TResult,
	): (...args: TArgs) => TResult
	close(): void
}
