import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryBrainStore } from '../src/stores'
import { SQLiteBrainStore } from '../src/stores/sqlite/node/brain'
import { registerSignalStoreContract, type SignalStoreScenario } from './signals-store-contract'

const api = { describe, expect, it }

registerSignalStoreContract(api, 'Signal state / MemoryBrainStore', (): SignalStoreScenario => {
	let store: MemoryBrainStore | undefined
	return {
		create() { store = new MemoryBrainStore(); return store },
		reopen() { if (!store) throw new Error('store not created'); return store },
		cleanup() {},
	}
})

registerSignalStoreContract(api, 'Signal state / SQLiteBrainStore (node)', (): SignalStoreScenario => {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-signals-node-'))
	const path = join(directory, 'brain.db')
	return {
		create() { return new SQLiteBrainStore(path) },
		reopen() { return new SQLiteBrainStore(path) },
		cleanup() { rmSync(directory, { recursive: true, force: true }) },
	}
})
