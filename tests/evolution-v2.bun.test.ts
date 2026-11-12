import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SQLiteBrainStore } from '../src/sqlite/bun'
import {
	type EvolutionStoreScenario,
	registerEvolutionStoreContract,
} from './evolution-v2-contract'

function sqliteScenario(): EvolutionStoreScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-evolution-v2-bun-'))
	const path = join(directory, 'brain.db')
	return {
		create() {
			return new SQLiteBrainStore(path)
		},
		async restart(store) {
			await store.dispose()
			return new SQLiteBrainStore(path)
		},
		cleanup() {
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

registerEvolutionStoreContract(
	{ describe, expect, it },
	'SQLiteBrainStore (bun)',
	sqliteScenario,
)
