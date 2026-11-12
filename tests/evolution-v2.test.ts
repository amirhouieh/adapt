import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryBrainStore } from '../src/stores'
import { SQLiteBrainStore } from '../src/sqlite'
import {
	type EvolutionStoreScenario,
	registerEvolutionStoreContract,
} from './evolution-v2-contract'

const api = { describe, expect, it }

function memoryScenario(): EvolutionStoreScenario {
	let store: MemoryBrainStore | undefined
	return {
		create() {
			store = new MemoryBrainStore()
			return store
		},
		async restart(current) {
			await current.dispose()
			if (!store) throw new Error('memory store has not been created')
			return store
		},
		cleanup() {},
	}
}

function sqliteScenario(): EvolutionStoreScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-evolution-v2-'))
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

registerEvolutionStoreContract(api, 'MemoryBrainStore', memoryScenario)
registerEvolutionStoreContract(api, 'SQLiteBrainStore (node)', sqliteScenario)
