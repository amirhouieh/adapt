import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SQLiteNeuronStore } from '../src/sqlite/bun'
import {
	type LearningStoreScenario,
	registerLearningStoreContract,
} from './v2-store-learning-contract'

const api = { describe, expect, it }

function sqliteScenario(): LearningStoreScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-v2-store-bun-'))
	const path = join(directory, 'learning.db')
	return {
		create(options) {
			return new SQLiteNeuronStore(path, options)
		},
		reopen(options) {
			return new SQLiteNeuronStore(path, options)
		},
		cleanup() {
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

registerLearningStoreContract(api, 'SQLiteNeuronStore (bun)', sqliteScenario)
