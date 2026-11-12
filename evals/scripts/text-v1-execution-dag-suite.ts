/**
 * Runs the unjudged original-v1 versus phase-DAG execution comparison.
 *
 * The suite parent freezes every input, creates one real initialized v1 seed
 * per scenario, clones the closed SQLite seed, and runs one worker at a time.
 * It also runs one separately configured interruption/recovery pair.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type {
	ComparisonConfig,
	ComparisonDataset,
	LegacyNeuron,
	LegacyRuntime,
	LegacyStore,
	ModelTurnPlugin,
	RuntimeContext,
} from './text-dag-comparison-eval'
import { textComparisonSupport as support } from './text-dag-comparison-eval'
import type {
	V1TextPhaseDagConfig,
	V1TextPhaseLearner,
} from '../../src/learning/v1-text-phases'

type Arm = 'direct' | 'dag'

const dagConfigSchema = z.object({
	revisions: z.object({
		memory: z.number().int().nonnegative(),
		configuration: z.number().int().nonnegative(),
		registry: z.string().min(1),
	}).strict(),
	planningLimits: z.object({
		maxNodes: z.number().int().positive(),
		maxCollectionItems: z.number().int().positive(),
		maxOperations: z.number().int().positive(),
	}).strict(),
	operationBudget: z.number().int().positive(),
}).strict()

const suiteManifestSchema = z.object({
	schemaVersion: z.literal(1),
	baseConfig: z.string().min(1),
	datasets: z.array(z.string().min(1)).min(1),
	outputRoot: z.string().min(1),
	arms: z.array(z.enum(['direct', 'dag']))
		.min(1)
		.refine((arms) => new Set(arms).size === arms.length, 'suite arms must be unique')
		.default(['direct', 'dag']),
	dag: dagConfigSchema,
	recovery: z.object({
		scenarioIndex: z.number().int().positive(),
		interruptDeliveryIndex: z.number().int().positive(),
		markerTimeoutMs: z.number().int().positive(),
		terminationTimeoutMs: z.number().int().positive(),
		markerPollIntervalMs: z.number().int().positive(),
	}).strict(),
}).strict()

const commonWorkerFields = {
	schemaVersion: z.literal(1),
	configPath: z.string().min(1),
	datasetPath: z.string().min(1),
	databasePath: z.string().min(1),
	evidenceDirectory: z.string().min(1),
}
const workerInputSchema = z.discriminatedUnion('kind', [
	z.object({ ...commonWorkerFields, kind: z.literal('initialize') }).strict(),
	z.object({
		...commonWorkerFields,
		kind: z.literal('deliveries'),
		arm: z.enum(['direct', 'dag']),
		dag: dagConfigSchema,
		deliveryIndexes: z.array(z.number().int().nonnegative()),
	}).strict(),
	z.object({
		...commonWorkerFields,
		kind: z.literal('interrupt'),
		arm: z.enum(['direct', 'dag']),
		dag: dagConfigSchema,
		deliveryIndex: z.number().int().nonnegative(),
		markerPath: z.string().min(1),
	}).strict(),
	z.object({
		...commonWorkerFields,
		kind: z.literal('recover'),
		arm: z.enum(['direct', 'dag']),
		dag: dagConfigSchema,
	}).strict(),
])

type WorkerInput = z.infer<typeof workerInputSchema>
type DeliveryWorker = Extract<WorkerInput, { kind: 'deliveries' }>
type InterruptWorker = Extract<WorkerInput, { kind: 'interrupt' }>
type RecoverWorker = Extract<WorkerInput, { kind: 'recover' }>

interface ExecutionNeuron extends LegacyNeuron {
	learn(batch: unknown[], options: { forceSynthesize: boolean }): Promise<unknown>
}

interface ScenarioRecord {
	readonly index: number
	readonly id: string
	readonly configPath: string
	readonly datasetPath: string
	readonly directory: string
	readonly seedPath: string
	seedSha256?: string
	readonly processes: ProcessRecord[]
}

interface ProcessRecord {
	readonly label: string
	readonly inputPath: string
	readonly startedAt: string
	readonly completedAt: string
	readonly exitCode: number | null
	readonly signal: NodeJS.Signals | null
	readonly stdoutPath: string
	readonly stderrPath: string
	readonly interrupted?: boolean
	readonly markerObserved?: boolean
	readonly timedOut?: boolean
	readonly error?: unknown
}

function timestampId(): string {
	return new Date().toISOString().split(':').join('-')
}

function resolveFrom(baseDirectory: string, path: string): string {
	return resolve(baseDirectory, path)
}

function readWorkerInput(path: string): WorkerInput {
	return workerInputSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

function readConfig(path: string): ComparisonConfig {
	return support.configSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

function readDataset(path: string): ComparisonDataset {
	return support.datasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

function makeContext(input: WorkerInput): RuntimeContext {
	const config = readConfig(input.configPath)
	const dataset = readDataset(input.datasetPath)
	mkdirSync(resolve(input.evidenceDirectory, 'transport'), { recursive: true })
	return {
		config,
		dataset,
		runDirectory: dirname(input.evidenceDirectory),
		armDirectory: input.evidenceDirectory,
		transportDirectory: resolve(input.evidenceDirectory, 'transport'),
		modelCalls: [],
		...('arm' in input ? { arm: input.arm } : { arm: 'initialization' }),
		phase: input.kind,
	}
}

function eventType(event: unknown): string | undefined {
	if (typeof event !== 'object' || event === null || !('type' in event)) return undefined
	const value = (event as { type?: unknown }).type
	return typeof value === 'string' ? value : undefined
}

async function loadCurrentNeuron(): Promise<{
	TextNeuron: { restore(store: LegacyStore, runtime: Readonly<Record<string, unknown>>): Promise<ExecutionNeuron> }
}> {
	const modulePath = '../../src/neurons/text/class.ts'
	const module = await import(modulePath)
	return module as unknown as {
		TextNeuron: { restore(store: LegacyStore, runtime: Readonly<Record<string, unknown>>): Promise<ExecutionNeuron> }
	}
}

async function createModelRuntime(context: RuntimeContext, legacy: LegacyRuntime): Promise<{
	model: unknown
	llm: ModelTurnPlugin
}> {
	return support.createObservedRuntime(context, legacy)
}

async function restoreWithRuntime(
	arm: Arm,
	legacy: LegacyRuntime,
	store: LegacyStore,
	context: RuntimeContext,
	runtime: Awaited<ReturnType<typeof createModelRuntime>>,
	onEvent: (event: unknown) => void,
): Promise<ExecutionNeuron> {
	const restoreRuntime = {
		id: context.config.ids.v1Neuron,
		model: runtime.model,
		llm: runtime.llm,
		onEvent,
	}
	if (arm === 'direct') return legacy.TextNeuron.restore(store, restoreRuntime)
	const current = await loadCurrentNeuron()
	return current.TextNeuron.restore(store, restoreRuntime)
}

async function invoke(
	arm: Arm,
	neuron: ExecutionNeuron,
	batch: readonly string[],
	forceSynthesize: boolean,
	dagConfig: V1TextPhaseDagConfig,
): Promise<unknown> {
	if (arm === 'direct') return neuron.learn([...batch], { forceSynthesize })
	const { createV1TextPhaseDag } = await import('../../src/learning/v1-text-phases')
	const dag = createV1TextPhaseDag(neuron as unknown as V1TextPhaseLearner, dagConfig)
	return dag.learn({ batch, forceSynthesize })
}

async function initialize(input: Extract<WorkerInput, { kind: 'initialize' }>): Promise<void> {
	const context = makeContext(input)
	const legacy = await support.loadLegacy(context.config)
	const runtime = await createModelRuntime(context, legacy)
	const events: unknown[] = []
	let store = new legacy.SQLiteNeuronStore(input.databasePath)
	context.phase = 'initialization'
	const started = performance.now()
	const neuron = await legacy.TextNeuron.create({
		id: context.config.ids.v1Neuron,
		name: context.dataset.scenario.id,
		instructions: support.combinedInstructions(context.dataset),
		model: runtime.model,
		llm: runtime.llm,
		store,
		observationSchema: context.dataset.scenario.observationSchema,
		understandingSchema: context.dataset.scenario.understandingSchema,
		governance: { strategy: 'continuous', maxTokens: context.config.bounds.maxMemoryTokens },
		understand: { thresholds: {
			maxObservations: context.config.bounds.maxObservations,
			maxTokens: context.config.bounds.maxObservationTokens,
			minImportance: context.config.bounds.minImportance,
		} },
		onEvent: (event: unknown) => events.push(event),
	})
	const beforeClose = {
		durationMs: support.duration(started),
		observeSystemPrompt: neuron.getObserveSystemPrompt(),
		understandSystemPrompt: neuron.getUnderstandSystemPrompt(),
		understandIdentity: neuron.getUnderstandIdentity(),
		understandingRead: await neuron.getUnderstanding(),
		storeRead: await support.snapshotLegacyStore(store),
		events,
	}
	const initialStore = beforeClose.storeRead
	for (const key of ['observations', 'understanding', 'evolution'] as const) {
		const records = initialStore[key]
		if (!Array.isArray(records) || records.length !== 0) {
			throw new Error(`initialized seed ${key} must be empty`)
		}
	}
	support.writeEvidencePair(input.evidenceDirectory, 'before-close', beforeClose)
	await neuron.dispose()
	store = new legacy.SQLiteNeuronStore(input.databasePath)
	const afterReopen = await support.snapshotLegacyStore(store)
	await store.dispose()
	support.writeEvidencePair(input.evidenceDirectory, 'after-reopen', afterReopen)
	support.writeEvidencePair(input.evidenceDirectory, 'model-calls', context.modelCalls)
	support.writeJson(resolve(input.evidenceDirectory, 'database-files.json'), {
		databasePath: input.databasePath,
		databaseSha256: support.sha256(readFileSync(input.databasePath)),
		walExists: existsSync(`${input.databasePath}-wal`),
		shmExists: existsSync(`${input.databasePath}-shm`),
	})
}

async function runDeliveries(input: DeliveryWorker): Promise<void> {
	const context = makeContext(input)
	const legacy = await support.loadLegacy(context.config)
	const runtime = await createModelRuntime(context, legacy)
	const executions: unknown[] = []
	for (const deliveryIndex of input.deliveryIndexes) {
		const delivery = context.dataset.scenario.deliveries[deliveryIndex]
		if (delivery === undefined) throw new Error(`delivery index ${deliveryIndex} is out of bounds`)
		context.phase = `${input.arm}-delivery-${deliveryIndex + 1}`
		const callStart = context.modelCalls.length
		const events: unknown[] = []
		let store = new legacy.SQLiteNeuronStore(input.databasePath)
		const neuron = await restoreWithRuntime(input.arm, legacy, store, context, runtime, (event) => events.push(event))
		const restoredIdentity = {
			observeSystemPrompt: neuron.getObserveSystemPrompt(),
			understandSystemPrompt: neuron.getUnderstandSystemPrompt(),
			understandIdentity: neuron.getUnderstandIdentity(),
		}
		const started = performance.now()
		let result: unknown
		let failure: unknown
		try {
			result = await invoke(input.arm, neuron, [delivery.text], true, input.dag)
		} catch (error) {
			failure = error
		}
		const beforeClose = {
			understandingRead: await neuron.getUnderstanding(),
			storeRead: await support.snapshotLegacyStore(store),
		}
		await neuron.dispose()
		store = new legacy.SQLiteNeuronStore(input.databasePath)
		const afterReopen = await support.snapshotLegacyStore(store)
		await store.dispose()
		executions.push({
			deliveryIndex,
			delivery,
			restoredIdentity,
			durationMs: support.duration(started),
			result,
			failure,
			beforeClose,
			afterReopen,
			events,
			modelCalls: context.modelCalls.slice(callStart),
		})
		support.writeEvidencePair(input.evidenceDirectory, 'deliveries.partial', executions)
		if (failure !== undefined) throw failure
	}
	support.writeEvidencePair(input.evidenceDirectory, 'deliveries', executions)
	support.writeEvidencePair(input.evidenceDirectory, 'model-calls', context.modelCalls)
}

async function interrupt(input: InterruptWorker): Promise<void> {
	const context = makeContext(input)
	const legacy = await support.loadLegacy(context.config)
	const runtime = await createModelRuntime(context, legacy)
	const delivery = context.dataset.scenario.deliveries[input.deliveryIndex]
	if (delivery === undefined) throw new Error(`delivery index ${input.deliveryIndex} is out of bounds`)
	context.phase = `${input.arm}-interrupt-delivery-${input.deliveryIndex + 1}`
	let store = new legacy.SQLiteNeuronStore(input.databasePath)
	const events: unknown[] = []
	let restoredIdentity: unknown
	const onEvent = (event: unknown): void => {
		events.push(event)
		if (eventType(event) !== 'neuron:synthesize:started') return
		support.writeEvidencePair(input.evidenceDirectory, 'interruption-boundary', {
			deliveryIndex: input.deliveryIndex,
			delivery,
			restoredIdentity,
			event,
			events,
			modelCalls: context.modelCalls,
		})
		writeFileSync(input.markerPath, `${JSON.stringify({ reachedAt: new Date().toISOString() })}\n`)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
	}
	const neuron = await restoreWithRuntime(input.arm, legacy, store, context, runtime, onEvent)
	restoredIdentity = {
		observeSystemPrompt: neuron.getObserveSystemPrompt(),
		understandSystemPrompt: neuron.getUnderstandSystemPrompt(),
		understandIdentity: neuron.getUnderstandIdentity(),
	}
	let result: unknown
	let failure: unknown
	try {
		result = await invoke(input.arm, neuron, [delivery.text], true, input.dag)
	} catch (error) {
		failure = error
	}
	const beforeClose = { understandingRead: await neuron.getUnderstanding(), storeRead: await support.snapshotLegacyStore(store) }
	await neuron.dispose()
	store = new legacy.SQLiteNeuronStore(input.databasePath)
	const afterReopen = await support.snapshotLegacyStore(store)
	await store.dispose()
	support.writeEvidencePair(input.evidenceDirectory, 'completed-before-interruption', {
		deliveryIndex: input.deliveryIndex,
		delivery,
		restoredIdentity,
		result,
		failure,
		beforeClose,
		afterReopen,
		events,
		modelCalls: context.modelCalls,
	})
	support.writeEvidencePair(input.evidenceDirectory, 'model-calls', context.modelCalls)
	if (failure !== undefined) throw failure
}

async function recover(input: RecoverWorker): Promise<void> {
	const context = makeContext(input)
	const legacy = await support.loadLegacy(context.config)
	const runtime = await createModelRuntime(context, legacy)
	context.phase = `${input.arm}-recovery-empty-force`
	let store = new legacy.SQLiteNeuronStore(input.databasePath)
	const beforeRecovery = await support.snapshotLegacyStore(store)
	const events: unknown[] = []
	const neuron = await restoreWithRuntime(input.arm, legacy, store, context, runtime, (event) => events.push(event))
	const restoredIdentity = {
		observeSystemPrompt: neuron.getObserveSystemPrompt(),
		understandSystemPrompt: neuron.getUnderstandSystemPrompt(),
		understandIdentity: neuron.getUnderstandIdentity(),
	}
	let result: unknown
	let failure: unknown
	try {
		result = await invoke(input.arm, neuron, [], true, input.dag)
	} catch (error) {
		failure = error
	}
	const beforeClose = { understandingRead: await neuron.getUnderstanding(), storeRead: await support.snapshotLegacyStore(store) }
	await neuron.dispose()
	store = new legacy.SQLiteNeuronStore(input.databasePath)
	const afterReopen = await support.snapshotLegacyStore(store)
	await store.dispose()
	support.writeEvidencePair(input.evidenceDirectory, 'recovery', {
		beforeRecovery,
		restoredIdentity,
		result,
		failure,
		beforeClose,
		afterReopen,
		events,
		modelCalls: context.modelCalls,
	})
	support.writeEvidencePair(input.evidenceDirectory, 'model-calls', context.modelCalls)
	if (failure !== undefined) throw failure
}

async function runWorker(path: string): Promise<void> {
	const input = readWorkerInput(path)
	mkdirSync(input.evidenceDirectory, { recursive: true })
	support.writeEvidencePair(input.evidenceDirectory, 'worker-input', input)
	try {
		if (input.kind === 'initialize') await initialize(input)
		else if (input.kind === 'deliveries') await runDeliveries(input)
		else if (input.kind === 'interrupt') await interrupt(input)
		else await recover(input)
	} catch (error) {
		support.writeEvidencePair(input.evidenceDirectory, 'failure', error)
		throw error
	}
}

function workerCommand(repositoryRoot: string, inputPath: string): { executable: string; arguments: string[] } {
	return {
		executable: process.execPath,
		arguments: [
			'--import',
			'tsx',
			resolve(repositoryRoot, 'evals/scripts/text-v1-execution-dag-suite.ts'),
			'--worker',
			inputPath,
		],
	}
}

function processPaths(processRoot: string, label: string): { directory: string; stdoutPath: string; stderrPath: string } {
	const directory = resolve(processRoot, label)
	mkdirSync(directory, { recursive: true })
	return { directory, stdoutPath: resolve(directory, 'stdout.raw.txt'), stderrPath: resolve(directory, 'stderr.raw.txt') }
}

function runWorkerSync(repositoryRoot: string, processRoot: string, label: string, inputPath: string): ProcessRecord {
	const paths = processPaths(processRoot, label)
	const command = workerCommand(repositoryRoot, inputPath)
	const startedAt = new Date().toISOString()
	const result = spawnSync(command.executable, command.arguments, { cwd: repositoryRoot, encoding: 'utf8' })
	writeFileSync(paths.stdoutPath, result.stdout ?? '')
	writeFileSync(paths.stderrPath, result.stderr ?? '')
	const record: ProcessRecord = {
		label,
		inputPath,
		startedAt,
		completedAt: new Date().toISOString(),
		exitCode: result.status,
		signal: result.signal,
		stdoutPath: paths.stdoutPath,
		stderrPath: paths.stderrPath,
		...(result.error === undefined ? {} : { error: result.error }),
	}
	support.writeJson(resolve(paths.directory, 'process.json'), record)
	return record
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function runInterruptWorker(
	repositoryRoot: string,
	processRoot: string,
	label: string,
	inputPath: string,
	markerPath: string,
	timeouts: { markerTimeoutMs: number; terminationTimeoutMs: number; markerPollIntervalMs: number },
): Promise<ProcessRecord> {
	const paths = processPaths(processRoot, label)
	const command = workerCommand(repositoryRoot, inputPath)
	const stdout = openSync(paths.stdoutPath, 'w')
	const stderr = openSync(paths.stderrPath, 'w')
	const startedAt = new Date().toISOString()
	const child = spawn(command.executable, command.arguments, { cwd: repositoryRoot, stdio: ['ignore', stdout, stderr] })
	closeSync(stdout)
	closeSync(stderr)
	let closed = false
	let exitCode: number | null = null
	let signal: NodeJS.Signals | null = null
	let spawnError: unknown
	const closedPromise = new Promise<void>((resolveClosed) => {
		child.once('error', (error) => { spawnError = error })
		child.once('close', (code, childSignal) => {
			closed = true
			exitCode = code
			signal = childSignal
			resolveClosed()
		})
	})
	const deadline = Date.now() + timeouts.markerTimeoutMs
	while (!closed && !existsSync(markerPath) && Date.now() < deadline) {
		await delay(timeouts.markerPollIntervalMs)
	}
	const markerObserved = existsSync(markerPath)
	const timedOut = !closed && !markerObserved
	if (!closed && (markerObserved || timedOut)) child.kill('SIGKILL')
	if (!closed) {
		await Promise.race([closedPromise, delay(timeouts.terminationTimeoutMs)])
		if (!closed) {
			child.kill('SIGKILL')
			await closedPromise
		}
	}
	const record: ProcessRecord = {
		label,
		inputPath,
		startedAt,
		completedAt: new Date().toISOString(),
		exitCode,
		signal,
		stdoutPath: paths.stdoutPath,
		stderrPath: paths.stderrPath,
		interrupted: markerObserved && signal === 'SIGKILL',
		markerObserved,
		timedOut,
		...(spawnError === undefined ? {} : { error: spawnError }),
	}
	support.writeJson(resolve(paths.directory, 'process.json'), record)
	return record
}

function writeWorkerInput(directory: string, label: string, input: WorkerInput): string {
	const path = resolve(directory, `${label}.json`)
	support.writeJson(path, input)
	return path
}

function sourceFingerprint(paths: readonly string[]): unknown {
	return {
		capturedAt: new Date().toISOString(),
		files: paths.map((path) => ({ path, sha256: support.sha256(readFileSync(path)) })),
	}
}

function listSourceFiles(directory: string): string[] {
	const files: string[] = []
	for (const name of readdirSync(directory).sort()) {
		const path = resolve(directory, name)
		if (statSync(path).isDirectory()) files.push(...listSourceFiles(path))
		else files.push(path)
	}
	return files
}

function legacyBehaviorFiles(root: string): string[] {
	return [
		...listSourceFiles(resolve(root, 'src/neurons/base')),
		...listSourceFiles(resolve(root, 'src/neurons/observer')),
		...listSourceFiles(resolve(root, 'src/neurons/text')).filter((path) => basename(path) !== 'dag.ts'),
		resolve(root, 'src/llm/index.ts'),
	]
}

function sourceParity(repositoryRoot: string, baselineRoot: string): unknown {
	const relativePaths = new Set<string>()
	for (const root of [repositoryRoot, baselineRoot]) {
		for (const path of legacyBehaviorFiles(root)) relativePaths.add(path.slice(root.length + 1))
	}
	return [...relativePaths].sort().map((relativePath) => {
		const currentPath = resolve(repositoryRoot, relativePath)
		const baselinePath = resolve(baselineRoot, relativePath)
		const currentSha256 = existsSync(currentPath) ? support.sha256(readFileSync(currentPath)) : null
		const baselineSha256 = existsSync(baselinePath) ? support.sha256(readFileSync(baselinePath)) : null
		return { relativePath, currentSha256, baselineSha256, equal: currentSha256 === baselineSha256 }
	})
}

function writeSummary(path: string, suiteDirectory: string, scenarios: readonly ScenarioRecord[]): void {
	support.writeJson(path, {
		label: 'UNJUDGED',
		updatedAt: new Date().toISOString(),
		suiteDirectory,
		grading: null,
		scenarios,
	})
}

function armDatabasePath(scenario: ScenarioRecord, group: 'ordinary' | 'recovery', arm: Arm, fileName: string): string {
	return resolve(scenario.directory, group, arm, fileName)
}

async function runSuite(manifestPathValue: string): Promise<void> {
	const manifestPath = resolve(manifestPathValue)
	const manifestDirectory = dirname(manifestPath)
	const manifestRaw = readFileSync(manifestPath, 'utf8')
	const manifest = suiteManifestSchema.parse(JSON.parse(manifestRaw) as unknown)
	const baseConfigPath = resolveFrom(manifestDirectory, manifest.baseConfig)
	const baseConfigRaw = readFileSync(baseConfigPath, 'utf8')
	const baseConfig = support.configSchema.parse(JSON.parse(baseConfigRaw) as unknown)
	const datasetInputs = manifest.datasets.map((path) => {
		const suppliedPath = resolveFrom(manifestDirectory, path)
		const raw = readFileSync(suppliedPath, 'utf8')
		return { suppliedPath, raw, parsed: support.datasetSchema.parse(JSON.parse(raw) as unknown) }
	})
	if (new Set(datasetInputs.map((value) => value.suppliedPath)).size !== datasetInputs.length) {
		throw new Error('suite dataset paths must be unique')
	}
	const recoveryDataset = datasetInputs[manifest.recovery.scenarioIndex - 1]
	if (recoveryDataset === undefined) throw new Error('recovery scenario index is out of bounds')
	if (recoveryDataset.parsed.scenario.deliveries[manifest.recovery.interruptDeliveryIndex - 1] === undefined) {
		throw new Error('recovery delivery index is out of bounds')
	}
	const outputRoot = resolveFrom(manifestDirectory, manifest.outputRoot)
	const suiteDirectory = resolve(outputRoot, timestampId())
	if (existsSync(suiteDirectory)) throw new Error(`suite artifact directory already exists: ${suiteDirectory}`)
	const frozenRoot = resolve(suiteDirectory, 'frozen-inputs')
	const scenarioRoot = resolve(suiteDirectory, 'scenarios')
	const processRoot = resolve(suiteDirectory, 'processes')
	const workerInputRoot = resolve(suiteDirectory, 'worker-inputs')
	for (const path of [frozenRoot, scenarioRoot, processRoot, workerInputRoot]) mkdirSync(path, { recursive: true })
	writeFileSync(resolve(frozenRoot, 'suite-manifest.raw.json'), manifestRaw)
	writeFileSync(resolve(frozenRoot, 'base-config.raw.json'), baseConfigRaw)

	const scenarios: ScenarioRecord[] = datasetInputs.map((dataset, offset) => {
		const index = offset + 1
		const sequence = String(index).padStart(3, '0')
		const directory = resolve(scenarioRoot, sequence)
		const datasetPath = resolve(frozenRoot, `dataset-${sequence}.raw.json`)
		const configPath = resolve(frozenRoot, `config-${sequence}.json`)
		const seedPath = resolve(directory, 'initialization', baseConfig.paths.v1DatabaseFileName)
		mkdirSync(resolve(directory, 'initialization'), { recursive: true })
		writeFileSync(datasetPath, dataset.raw)
		support.writeJson(configPath, {
			...baseConfig,
			paths: { ...baseConfig.paths, dataset: datasetPath, outputRoot: directory },
		})
		return {
			index,
			id: dataset.parsed.scenario.id,
			configPath,
			datasetPath,
			directory,
			seedPath,
			processes: [],
		}
	})
	support.writeJson(resolve(frozenRoot, 'digests.json'), {
		manifest: { path: manifestPath, sha256: support.sha256(manifestRaw) },
		baseConfig: { path: baseConfigPath, sha256: support.sha256(baseConfigRaw) },
		datasets: scenarios.map((scenario, index) => ({
			suppliedPath: datasetInputs[index]?.suppliedPath,
			frozenPath: scenario.datasetPath,
			sha256: support.sha256(readFileSync(scenario.datasetPath)),
		})),
	})

	console.log(suiteDirectory)
	const repositoryRoot = resolve(import.meta.dirname, '../..')
	const sourcePaths = [
		resolve(repositoryRoot, 'evals/scripts/text-dag-comparison-eval.ts'),
		resolve(repositoryRoot, 'evals/scripts/text-v1-execution-dag-suite.ts'),
		resolve(repositoryRoot, 'src/learning/v1-text-phases.ts'),
		resolve(repositoryRoot, 'src/learning/contracts.ts'),
		resolve(repositoryRoot, 'src/learning/executor.ts'),
		resolve(repositoryRoot, 'src/learning/planner.ts'),
		resolve(repositoryRoot, 'src/learning/registry.ts'),
		resolve(repositoryRoot, 'src/learning/recipes/common.ts'),
		...legacyBehaviorFiles(repositoryRoot),
		...legacyBehaviorFiles(baseConfig.baseline.root),
	]
	support.writeJson(resolve(suiteDirectory, 'source-fingerprint.before.json'), sourceFingerprint(sourcePaths))
	support.writeJson(
		resolve(suiteDirectory, 'source-parity.json'),
		sourceParity(repositoryRoot, baseConfig.baseline.root),
	)
	support.writeJson(resolve(suiteDirectory, 'source-identifiers.json'), {
		runtime: { node: process.version, platform: process.platform, architecture: process.arch },
		repository: {
			root: repositoryRoot,
			revision: support.gitValue(repositoryRoot, ['rev-parse', 'HEAD']),
			status: support.gitValue(repositoryRoot, ['status', '--short']),
		},
		baseline: {
			root: baseConfig.baseline.root,
			revision: support.gitValue(baseConfig.baseline.root, ['rev-parse', 'HEAD']),
			configuredRevision: baseConfig.baseline.revision,
		},
		model: { provider: baseConfig.provider, settings: baseConfig.model, requests: baseConfig.requests },
		arms: manifest.arms,
		dag: manifest.dag,
		recovery: manifest.recovery,
		manifestPath,
	})
	support.writeJson(resolve(suiteDirectory, 'experiment-contract.json'), {
		label: 'UNJUDGED',
		ordinary: 'all scenarios run to completion with close and reopen after every delivery',
		recovery: {
			scope: 'one configured scenario and delivery in each arm',
			boundary: 'durable pending observations before the synthesis model request',
			termination: 'worker blocks synchronously at the event boundary and the parent sends SIGKILL',
			resume: 'a fresh worker invokes an empty batch with forceSynthesize true',
		},
		dagPhaseHandoff: 'opaque in-process value',
		dagDurableCheckpoint: null,
		recoveryState: 'original v1 pending observations in the shared legacy SQLite store',
		grading: null,
	})
	const summaryPath = resolve(suiteDirectory, 'process-summary.json')
	writeSummary(summaryPath, suiteDirectory, scenarios)

	try {
		for (const scenario of scenarios) {
			const evidenceDirectory = resolve(scenario.directory, 'initialization')
			const inputPath = writeWorkerInput(workerInputRoot, `${String(scenario.index).padStart(3, '0')}-initialize`, {
				schemaVersion: 1,
				kind: 'initialize',
				configPath: scenario.configPath,
				datasetPath: scenario.datasetPath,
				databasePath: scenario.seedPath,
				evidenceDirectory,
			})
			const process = runWorkerSync(repositoryRoot, processRoot, `${String(scenario.index).padStart(3, '0')}-initialize`, inputPath)
			scenario.processes.push(process)
			if (process.exitCode === 0) {
				const sidecars = [`${scenario.seedPath}-wal`, `${scenario.seedPath}-shm`]
				if (sidecars.some((path) => existsSync(path))) throw new Error(`closed seed has a SQLite sidecar: ${scenario.id}`)
				const seedSha256 = support.sha256(readFileSync(scenario.seedPath))
				scenario.seedSha256 = seedSha256
				const groups: Array<'ordinary' | 'recovery'> = scenario.index === manifest.recovery.scenarioIndex
					? ['ordinary', 'recovery']
					: ['ordinary']
				const copies: unknown[] = []
				for (const group of groups) {
					for (const arm of manifest.arms) {
						const destination = armDatabasePath(scenario, group, arm, baseConfig.paths.v1DatabaseFileName)
						mkdirSync(dirname(destination), { recursive: true })
						copyFileSync(scenario.seedPath, destination)
						const destinationSha256 = support.sha256(readFileSync(destination))
						if (destinationSha256 !== seedSha256) throw new Error(`seed copy differs for ${scenario.id} ${group} ${arm}`)
						copies.push({ group, arm, path: destination, bytes: statSync(destination).size, sha256: destinationSha256 })
					}
				}
				support.writeJson(resolve(evidenceDirectory, 'seed-copies.json'), { seedPath: scenario.seedPath, seedSha256, copies })
			}
			writeSummary(summaryPath, suiteDirectory, scenarios)
			console.log(`${scenario.index} initialize ${String(process.exitCode)}`)
		}

		for (const arm of manifest.arms) {
			for (const scenario of scenarios) {
				if (scenario.seedSha256 === undefined) continue
				const dataset = readDataset(scenario.datasetPath)
				const label = `${String(scenario.index).padStart(3, '0')}-ordinary-${arm}`
				const inputPath = writeWorkerInput(workerInputRoot, label, {
					schemaVersion: 1,
					kind: 'deliveries',
					arm,
					dag: manifest.dag,
					configPath: scenario.configPath,
					datasetPath: scenario.datasetPath,
					databasePath: armDatabasePath(scenario, 'ordinary', arm, baseConfig.paths.v1DatabaseFileName),
					evidenceDirectory: resolve(scenario.directory, 'ordinary', arm),
					deliveryIndexes: dataset.scenario.deliveries.map((_delivery, index) => index),
				})
				const process = runWorkerSync(repositoryRoot, processRoot, label, inputPath)
				scenario.processes.push(process)
				writeSummary(summaryPath, suiteDirectory, scenarios)
				console.log(`${scenario.index} ordinary-${arm} ${String(process.exitCode)}`)
			}
		}

		const recoveryScenario = scenarios[manifest.recovery.scenarioIndex - 1]
		if (recoveryScenario !== undefined && recoveryScenario.seedSha256 !== undefined) {
			const interruptIndex = manifest.recovery.interruptDeliveryIndex - 1
			const deliveryCount = readDataset(recoveryScenario.datasetPath).scenario.deliveries.length
			for (const arm of manifest.arms) {
				const recoveryRoot = resolve(recoveryScenario.directory, 'recovery', arm)
				const databasePath = armDatabasePath(recoveryScenario, 'recovery', arm, baseConfig.paths.v1DatabaseFileName)
				const prefixLabel = `recovery-${arm}-prefix`
				const prefixInput = writeWorkerInput(workerInputRoot, prefixLabel, {
					schemaVersion: 1,
					kind: 'deliveries',
					arm,
					dag: manifest.dag,
					configPath: recoveryScenario.configPath,
					datasetPath: recoveryScenario.datasetPath,
					databasePath,
					evidenceDirectory: resolve(recoveryRoot, 'prefix'),
					deliveryIndexes: Array.from({ length: interruptIndex }, (_value, index) => index),
				})
				const prefixProcess = runWorkerSync(repositoryRoot, processRoot, prefixLabel, prefixInput)
				recoveryScenario.processes.push(prefixProcess)
				writeSummary(summaryPath, suiteDirectory, scenarios)
				console.log(`recovery ${arm} prefix ${String(prefixProcess.exitCode)}`)
				if (prefixProcess.exitCode !== 0) continue

				const markerPath = resolve(recoveryRoot, 'interruption', 'ready.marker.json')
				const interruptLabel = `recovery-${arm}-interrupt`
				const interruptInput = writeWorkerInput(workerInputRoot, interruptLabel, {
					schemaVersion: 1,
					kind: 'interrupt',
					arm,
					dag: manifest.dag,
					configPath: recoveryScenario.configPath,
					datasetPath: recoveryScenario.datasetPath,
					databasePath,
					evidenceDirectory: resolve(recoveryRoot, 'interruption'),
					deliveryIndex: interruptIndex,
					markerPath,
				})
				const interruptProcess = await runInterruptWorker(
					repositoryRoot,
					processRoot,
					interruptLabel,
					interruptInput,
					markerPath,
					manifest.recovery,
				)
				recoveryScenario.processes.push(interruptProcess)
				writeSummary(summaryPath, suiteDirectory, scenarios)
				console.log(`recovery ${arm} interrupt ${String(interruptProcess.signal)} ${String(interruptProcess.interrupted)}`)
				if (!interruptProcess.interrupted) continue

				const resumeLabel = `recovery-${arm}-resume`
				const resumeInput = writeWorkerInput(workerInputRoot, resumeLabel, {
					schemaVersion: 1,
					kind: 'recover',
					arm,
					dag: manifest.dag,
					configPath: recoveryScenario.configPath,
					datasetPath: recoveryScenario.datasetPath,
					databasePath,
					evidenceDirectory: resolve(recoveryRoot, 'resume'),
				})
				const resumeProcess = runWorkerSync(repositoryRoot, processRoot, resumeLabel, resumeInput)
				recoveryScenario.processes.push(resumeProcess)
				writeSummary(summaryPath, suiteDirectory, scenarios)
				console.log(`recovery ${arm} resume ${String(resumeProcess.exitCode)}`)
				if (resumeProcess.exitCode !== 0) continue

				const suffixLabel = `recovery-${arm}-suffix`
				const suffixInput = writeWorkerInput(workerInputRoot, suffixLabel, {
					schemaVersion: 1,
					kind: 'deliveries',
					arm,
					dag: manifest.dag,
					configPath: recoveryScenario.configPath,
					datasetPath: recoveryScenario.datasetPath,
					databasePath,
					evidenceDirectory: resolve(recoveryRoot, 'suffix'),
					deliveryIndexes: Array.from(
						{ length: deliveryCount - interruptIndex - 1 },
						(_value, index) => interruptIndex + index + 1,
					),
				})
				const suffixProcess = runWorkerSync(repositoryRoot, processRoot, suffixLabel, suffixInput)
				recoveryScenario.processes.push(suffixProcess)
				writeSummary(summaryPath, suiteDirectory, scenarios)
				console.log(`recovery ${arm} suffix ${String(suffixProcess.exitCode)}`)
			}
		}
	} finally {
		support.writeJson(resolve(suiteDirectory, 'source-fingerprint.after.json'), sourceFingerprint(sourcePaths))
		writeSummary(summaryPath, suiteDirectory, scenarios)
	}
}

async function main(): Promise<void> {
	if (process.argv[2] === '--worker') {
		const inputPath = process.argv[3]
		if (inputPath === undefined || process.argv.length !== 4) throw new Error('worker requires exactly one input path')
		await runWorker(resolve(inputPath))
		return
	}
	const manifestPath = process.argv[2]
	if (manifestPath === undefined || process.argv.length !== 3) throw new Error('suite requires exactly one manifest path')
	await runSuite(manifestPath)
}

export const textV1ExecutionDagSuiteSupport = { manifestSchema: suiteManifestSchema }

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) await main()
