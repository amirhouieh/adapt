import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SQLiteBrainStore } from '../src/stores/sqlite/bun/brain'
import { registerSignalStoreContract, type SignalStoreScenario } from './signals-store-contract'

registerSignalStoreContract({ describe, expect, it }, 'Signal state / SQLiteBrainStore (bun)', (): SignalStoreScenario => {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-signals-bun-'))
	const path = join(directory, 'brain.db')
	return {
		create() { return new SQLiteBrainStore(path) },
		reopen() { return new SQLiteBrainStore(path) },
		cleanup() { rmSync(directory, { recursive: true, force: true }) },
	}
})
