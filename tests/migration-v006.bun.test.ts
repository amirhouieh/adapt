import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SQLiteBrainStore, SQLiteNeuronStore } from '../src/sqlite/bun'
import {
	type MigrationScenario,
	registerMigrationV006Contract,
} from './migration-v006-contract'

const api = { describe, expect, it }

function sqliteScenario(): MigrationScenario {
	const directory = mkdtempSync(join(tmpdir(), 'adapt-v006-migration-bun-'))
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

registerMigrationV006Contract(api, 'SQLite stores (bun)', sqliteScenario)
