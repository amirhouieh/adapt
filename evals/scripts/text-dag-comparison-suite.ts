/**
 * Runs a frozen set of unjudged v1 versus fixed-DAG v2 comparisons.
 *
 * Run:
 *   npx tsx evals/scripts/text-dag-comparison-suite.ts <suite manifest>
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

const suiteManifestSchema = z.object({
	schemaVersion: z.literal(1),
	baseConfig: z.string().min(1),
	datasets: z.array(z.string().min(1)).min(1),
	outputRoot: z.string().min(1),
}).strict()

const baseConfigSchema = z.looseObject({
	paths: z.looseObject({
		dataset: z.string().min(1),
		outputRoot: z.string().min(1),
	}),
})

type ComparisonArm = 'v1' | 'v2'

interface FrozenScenario {
	readonly index: number
	readonly suppliedDatasetPath: string
	readonly frozenDatasetPath: string
	readonly generatedConfigPath: string
	readonly runDirectory: string
	readonly datasetSha256: string
	arms: Partial<Record<ComparisonArm, ProcessRecord>>
}

interface ProcessRecord {
	readonly arm: ComparisonArm
	readonly command: { readonly executable: string; readonly arguments: readonly string[] }
	readonly cwd: string
	readonly startedAt: string
	readonly completedAt: string
	readonly exitCode: number | null
	readonly signal: NodeJS.Signals | null
	readonly error?: unknown
	readonly stdoutPath: string
	readonly stderrPath: string
}

function errorAwareReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
	}
	if (typeof value === 'bigint') return value.toString()
	return value
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, errorAwareReplacer, 2)}\n`)
}

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

function timestampId(): string {
	return new Date().toISOString().split(':').join('-')
}

function resolveFrom(baseDirectory: string, path: string): string {
	return resolve(baseDirectory, path)
}

function sourceFingerprint(paths: readonly string[]): unknown {
	return {
		capturedAt: new Date().toISOString(),
		files: paths.map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
	}
}

function captureCommand(
	directory: string,
	name: string,
	executable: string,
	arguments_: readonly string[],
	cwd: string,
): void {
	const result = spawnSync(executable, arguments_, { cwd, encoding: 'utf8' })
	writeFileSync(resolve(directory, `${name}.stdout.raw.txt`), result.stdout ?? '')
	writeFileSync(resolve(directory, `${name}.stderr.raw.txt`), result.stderr ?? '')
	writeJson(resolve(directory, `${name}.process.json`), {
		executable,
		arguments: arguments_,
		cwd,
		exitCode: result.status,
		signal: result.signal,
		error: result.error,
	})
}

function writeSummary(
	path: string,
	manifestPath: string,
	suiteDirectory: string,
	scenarios: readonly FrozenScenario[],
): void {
	writeJson(path, {
		label: 'UNJUDGED',
		updatedAt: new Date().toISOString(),
		manifestPath,
		suiteDirectory,
		scenarioCount: scenarios.length,
		grading: null,
		scenarios,
	})
}

function runArm(
	arm: ComparisonArm,
	scenario: FrozenScenario,
	repositoryRoot: string,
	processRoot: string,
): ProcessRecord {
	const harnessPath = resolve(repositoryRoot, 'evals/scripts/text-dag-comparison-eval.ts')
	const tsxCliPath = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs')
	const arguments_ = [
		tsxCliPath,
		harnessPath,
		scenario.generatedConfigPath,
		'--arm',
		arm,
		'--run-directory',
		scenario.runDirectory,
	]
	const logDirectory = resolve(processRoot, `${String(scenario.index).padStart(3, '0')}-${arm}`)
	mkdirSync(logDirectory, { recursive: true })
	const stdoutPath = resolve(logDirectory, 'stdout.raw.txt')
	const stderrPath = resolve(logDirectory, 'stderr.raw.txt')
	const startedAt = new Date().toISOString()
	const result = spawnSync(process.execPath, arguments_, { cwd: repositoryRoot, encoding: 'utf8' })
	const completedAt = new Date().toISOString()
	writeFileSync(stdoutPath, result.stdout ?? '')
	writeFileSync(stderrPath, result.stderr ?? '')
	const record: ProcessRecord = {
		arm,
		command: { executable: process.execPath, arguments: arguments_ },
		cwd: repositoryRoot,
		startedAt,
		completedAt,
		exitCode: result.status,
		signal: result.signal,
		...(result.error === undefined ? {} : { error: result.error }),
		stdoutPath,
		stderrPath,
	}
	writeJson(resolve(logDirectory, 'process.json'), record)
	return record
}

async function main(): Promise<void> {
	const suppliedManifestPath = process.argv[2]
	if (suppliedManifestPath === undefined) throw new Error('provide the suite manifest path')
	if (process.argv.length !== 3) throw new Error('the suite runner accepts exactly one manifest path')
	const manifestPath = resolve(suppliedManifestPath)
	const manifestDirectory = dirname(manifestPath)
	const manifestRaw = readFileSync(manifestPath, 'utf8')
	const manifest = suiteManifestSchema.parse(JSON.parse(manifestRaw) as unknown)
	const baseConfigPath = resolveFrom(manifestDirectory, manifest.baseConfig)
	const baseConfigRaw = readFileSync(baseConfigPath, 'utf8')
	const baseConfig = baseConfigSchema.parse(JSON.parse(baseConfigRaw) as unknown)
	const suppliedDatasetPaths = manifest.datasets.map((path) => resolveFrom(manifestDirectory, path))
	if (new Set(suppliedDatasetPaths).size !== suppliedDatasetPaths.length) {
		throw new Error('suite dataset paths must be unique')
	}
	const datasetInputs = suppliedDatasetPaths.map((path) => ({ path, raw: readFileSync(path, 'utf8') }))
	const outputRoot = resolveFrom(manifestDirectory, manifest.outputRoot)
	const suiteDirectory = resolve(outputRoot, timestampId())
	if (existsSync(suiteDirectory)) throw new Error(`suite artifact directory already exists: ${suiteDirectory}`)
	const frozenInputDirectory = resolve(suiteDirectory, 'frozen-inputs')
	const scenarioRoot = resolve(suiteDirectory, 'scenarios')
	const processRoot = resolve(suiteDirectory, 'processes')
	const environmentRoot = resolve(suiteDirectory, 'environment')
	mkdirSync(frozenInputDirectory, { recursive: true })
	mkdirSync(scenarioRoot, { recursive: true })
	mkdirSync(processRoot, { recursive: true })
	mkdirSync(environmentRoot, { recursive: true })
	writeFileSync(resolve(frozenInputDirectory, 'suite-manifest.raw.json'), manifestRaw)
	writeFileSync(resolve(frozenInputDirectory, 'base-config.raw.json'), baseConfigRaw)

	const scenarios: FrozenScenario[] = datasetInputs.map((dataset, offset) => {
		const index = offset + 1
		const sequence = String(index).padStart(3, '0')
		const frozenDatasetPath = resolve(frozenInputDirectory, `dataset-${sequence}.raw.json`)
		const scenarioDirectory = resolve(scenarioRoot, sequence)
		const generatedConfigPath = resolve(frozenInputDirectory, `config-${sequence}.json`)
		const runDirectory = resolve(scenarioDirectory, 'run')
		mkdirSync(scenarioDirectory, { recursive: true })
		writeFileSync(frozenDatasetPath, dataset.raw)
		writeJson(generatedConfigPath, {
			...baseConfig,
			paths: {
				...baseConfig.paths,
				dataset: frozenDatasetPath,
				outputRoot: scenarioDirectory,
			},
		})
		return {
			index,
			suppliedDatasetPath: dataset.path,
			frozenDatasetPath,
			generatedConfigPath,
			runDirectory,
			datasetSha256: sha256(dataset.raw),
			arms: {},
		}
	})
	writeJson(resolve(frozenInputDirectory, 'digests.json'), {
		manifest: { path: manifestPath, sha256: sha256(manifestRaw) },
		baseConfig: { path: baseConfigPath, sha256: sha256(baseConfigRaw) },
		datasets: scenarios.map(({ suppliedDatasetPath, frozenDatasetPath, datasetSha256 }) => ({
			suppliedDatasetPath,
			frozenDatasetPath,
			sha256: datasetSha256,
		})),
	})
	console.log(suiteDirectory)

	const repositoryRoot = resolve(import.meta.dirname, '../..')
	const sourcePaths = [
		resolve(repositoryRoot, 'evals/scripts/text-dag-comparison-eval.ts'),
		resolve(repositoryRoot, 'evals/scripts/text-dag-comparison-suite.ts'),
		resolve(repositoryRoot, 'src/neurons/text/dag.ts'),
		resolve(repositoryRoot, 'src/learning/recipes/narrative.ts'),
	]
	writeJson(resolve(suiteDirectory, 'source-fingerprint.before.json'), sourceFingerprint(sourcePaths))
	captureCommand(environmentRoot, 'lms-ps', 'lms', ['ps', '--json'], repositoryRoot)
	captureCommand(environmentRoot, 'sw-vers', 'sw_vers', [], repositoryRoot)
	captureCommand(
		environmentRoot,
		'sysctl-hardware',
		'sysctl',
		['-n', 'hw.model', 'hw.memsize', 'machdep.cpu.brand_string'],
		repositoryRoot,
	)

	const summaryPath = resolve(suiteDirectory, 'process-summary.json')
	writeSummary(summaryPath, manifestPath, suiteDirectory, scenarios)
	try {
		for (const scenario of scenarios) {
			scenario.arms.v1 = runArm('v1', scenario, repositoryRoot, processRoot)
			writeSummary(summaryPath, manifestPath, suiteDirectory, scenarios)
			console.log(`${scenario.index} v1 ${String(scenario.arms.v1.exitCode)}`)
		}
		for (const scenario of scenarios) {
			scenario.arms.v2 = runArm('v2', scenario, repositoryRoot, processRoot)
			writeSummary(summaryPath, manifestPath, suiteDirectory, scenarios)
			console.log(`${scenario.index} v2 ${String(scenario.arms.v2.exitCode)}`)
		}
	} finally {
		writeJson(resolve(suiteDirectory, 'source-fingerprint.after.json'), sourceFingerprint(sourcePaths))
		writeSummary(summaryPath, manifestPath, suiteDirectory, scenarios)
	}
}

await main()
