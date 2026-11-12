import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
	TextLearningStateStore,
	type TextCoordinatorConfiguration,
	type TextInput,
	type TextProcedureDecision,
	type TextProfileSnapshot,
	type TextStatePolicy,
} from '../../src/learning/text-state'
import { SQLiteNeuronStore } from '../../src/stores/sqlite/node/neuron'

interface EvalConfig {
	readonly datasetPath: string
	readonly artifactRoot: string
	readonly runId: string
	readonly databaseFile: string
	readonly time: string
	readonly policy: TextStatePolicy
	readonly idStart: number
	readonly idPrefixes: Readonly<Record<'work' | 'attempt' | 'run' | 'candidate' | 'history' | 'change' | 'supersede' | 'profile' | 'activation', string>>
	readonly configuration: TextCoordinatorConfiguration
}

interface EvalDataset {
	readonly provenance: string
	readonly profile: Omit<TextProfileSnapshot<TextCoordinatorConfiguration>, 'configuration'>
	readonly inputs: readonly TextInput[]
	readonly candidate: TextProcedureDecision
}

class Ids {
	private value: number
	constructor(
		start: number,
		private readonly prefixes: EvalConfig['idPrefixes'],
	) { this.value = start }
	next(kind: 'work' | 'attempt' | 'run' | 'candidate' | 'history' | 'change' | 'supersede' | 'profile' | 'activation'): string {
		this.value += 1
		return `${this.prefixes[kind]}-${this.value}`
	}
}

async function main(): Promise<void> {
	const suppliedConfigPath = process.argv[2]
	if (!suppliedConfigPath) throw new Error('provide the adaptive text state eval config path')
	const configPath = resolve(suppliedConfigPath)
	const configRaw = readFileSync(configPath, 'utf8')
	const config = JSON.parse(configRaw) as EvalConfig
	const datasetPath = resolve(config.datasetPath)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = JSON.parse(datasetRaw) as EvalDataset
	const artifactDirectory = resolve(config.artifactRoot, config.runId)
	if (existsSync(artifactDirectory)) throw new Error(`artifact directory already exists: ${artifactDirectory}`)
	mkdirSync(artifactDirectory, { recursive: true })
	writeFileSync(resolve(artifactDirectory, 'config.input.raw.json'), configRaw)
	writeFileSync(resolve(artifactDirectory, 'dataset.input.raw.json'), datasetRaw)

	const databasePath = resolve(artifactDirectory, config.databaseFile)
	const ids = new Ids(config.idStart, config.idPrefixes)
	const clock = { now: () => config.time }
	const operations: Array<{ operation: string; output?: unknown; failure?: unknown }> = []
	const outputPath = resolve(artifactDirectory, 'operations.output.raw.json')
	const saveOperations = (): void => writeFileSync(outputPath, JSON.stringify(operations, null, 2))
	const capture = async <T>(operation: string, call: () => Promise<T>): Promise<T | undefined> => {
		try {
			const output = await call()
			operations.push({ operation, output })
			return output
		} catch (failure) {
			operations.push({ operation, failure: inspect(failure, { depth: null, maxArrayLength: null, maxStringLength: null }) })
			return undefined
		} finally {
			saveOperations()
		}
	}
	const suppliedProfile: TextProfileSnapshot<TextCoordinatorConfiguration> = { ...dataset.profile, configuration: config.configuration }
	let store = new SQLiteNeuronStore(databasePath)
	let state = new TextLearningStateStore<TextCoordinatorConfiguration>({
		store,
		ids,
		clock,
		policy: config.policy,
		countInputTokens: (inputs) => inputs.reduce((total, input) => total + input.text.length, 0),
		fitsRequest: () => ({ status: 'fits' }),
	})
	await capture('initialize', () => state.initialize(suppliedProfile))
	for (const input of dataset.inputs) await capture(`enqueue:${input.deliveryId}`, () => state.enqueue(input))
	const begun = await capture('begin-run', () => state.beginRun(true))
	if (!begun) throw new Error('begin-run failed; raw failure was saved')
	if (begun.status !== 'started' || !begun.snapshot) throw new Error('fixture did not create a run')
	const candidateId = await capture('persist-candidate', () => state.persistCandidate(begun.snapshot!.runId, dataset.candidate))
	if (!candidateId) throw new Error('persist-candidate failed; raw failure was saved')
	await capture('close-after-candidate', async () => { await store.dispose(); return { closed: true } })

	store = new SQLiteNeuronStore(databasePath)
	state = new TextLearningStateStore<TextCoordinatorConfiguration>({
		store,
		ids,
		clock,
		policy: config.policy,
		countInputTokens: (inputs) => inputs.reduce((total, input) => total + input.text.length, 0),
		fitsRequest: () => ({ status: 'fits' }),
	})
	const recovered = await capture('recover-candidate-after-reopen', () => state.recoverCandidate())
	if (!recovered) throw new Error('persisted candidate was not recovered')
	await capture('commit-recovered-candidate', () => state.commitCandidate(recovered.candidateId))
	await capture('reopened-store-records', () => store.runAtomic((atomic) => ({
			understanding: atomic.understanding.list(),
			learningHistory: atomic.learningHistory.list(),
			memoryChanges: atomic.memoryChanges.list(),
			pendingWork: atomic.pendingWork.list(),
			pendingInputs: atomic.pendingInputs.list(),
			processedInputs: atomic.processedInputs.list(),
			learningAttempts: atomic.learningAttempts.list(),
			learningRevisions: atomic.learningRevisions.list(),
			state: atomic.state.list(),
		})))
	const sourceRaw = readFileSync(fileURLToPath(import.meta.url), 'utf8')
	const sourceDigest = createHash('sha256').update(sourceRaw).digest('hex')
	writeFileSync(resolve(artifactDirectory, 'run.metadata.json'), JSON.stringify({ adapter: 'node-sqlite', databasePath, sourceDigest, source: 'deterministic fixture; no model calls or semantic scoring' }, null, 2))
	await store.dispose()
}

await main()
