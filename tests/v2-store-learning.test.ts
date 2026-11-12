import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryNeuronStore } from '../src/stores'
import { SQLiteNeuronStore } from '../src/sqlite'
import {
	type LearningStoreScenario,
	registerLearningStoreContract,
} from './v2-store-learning-contract'

const api = { describe, expect, it }

function memoryScenario(): LearningStoreScenario {
	let store: MemoryNeuronStore | undefined
	return {
		create(options) {
			store = new MemoryNeuronStore(options)
			return store
		},
		reopen() {
			if (!store) throw new Error('Memory store has not been created')
			return store
		},
		cleanup() {},
	}
}

function sqliteScenario(): LearningStoreScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-v2-store-'))
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

registerLearningStoreContract(api, 'MemoryNeuronStore', memoryScenario)
registerLearningStoreContract(api, 'SQLiteNeuronStore (node)', sqliteScenario)
