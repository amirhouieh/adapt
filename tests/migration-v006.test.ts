import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryBrainStore, MemoryNeuronStore } from '../src/stores'
import { SQLiteBrainStore, SQLiteNeuronStore } from '../src/sqlite'
import {
	type MigrationScenario,
	registerMigrationV006Contract,
} from './migration-v006-contract'

const api = { describe, expect, it }

function memoryScenario(): MigrationScenario {
	const sourceBrain = new MemoryBrainStore()
	const targetBrain = new MemoryBrainStore()
	const sourceNeuron = new MemoryNeuronStore()
	const targetNeuron = new MemoryNeuronStore()
	return {
		sourceBrain,
		targetBrain,
		reopenTargetBrain: () => targetBrain,
		sourceNeuron,
		targetNeuron,
		reopenTargetNeuron: () => targetNeuron,
		cleanup() {},
	}
}

function sqliteScenario(): MigrationScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-v006-migration-'))
	const sourceBrainPath = join(directory, 'source-brain.db')
	const targetBrainPath = join(directory, 'target-brain.db')
	const sourceNeuronPath = join(directory, 'source-neuron.db')
	const targetNeuronPath = join(directory, 'target-neuron.db')
	return {
		sourceBrain: new SQLiteBrainStore(sourceBrainPath),
		targetBrain: new SQLiteBrainStore(targetBrainPath),
		reopenTargetBrain: () => new SQLiteBrainStore(targetBrainPath),
		sourceNeuron: new SQLiteNeuronStore(sourceNeuronPath),
		targetNeuron: new SQLiteNeuronStore(targetNeuronPath),
		reopenTargetNeuron: () => new SQLiteNeuronStore(targetNeuronPath),
		cleanup() {
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

registerMigrationV006Contract(api, 'Memory stores', memoryScenario)
registerMigrationV006Contract(api, 'SQLite stores (node)', sqliteScenario)
