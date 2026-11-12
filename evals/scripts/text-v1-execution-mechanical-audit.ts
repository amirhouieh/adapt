import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

interface AuditConfig {
	suiteDirectory: string
	outputFile: string
}

interface JsonObject {
	[key: string]: unknown
}

interface ModelCall extends JsonObject {
	phase?: string
	request?: JsonObject
	result?: JsonObject
}

const isObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const readJson = async <T>(path: string): Promise<T> =>
	JSON.parse(await fs.readFile(path, 'utf8')) as T

const stable = (value: unknown): string => JSON.stringify(value)

const sha256 = (bytes: Buffer): string =>
	createHash('sha256').update(bytes).digest('hex')

const walk = async (root: string): Promise<string[]> => {
	const paths: string[] = []
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name)
		if (entry.isDirectory()) paths.push(...(await walk(path)))
		else paths.push(path)
	}
	return paths.sort()
}

const parseConfig = (value: unknown, path: string): AuditConfig => {
	if (!isObject(value)) throw new Error(`Audit config must be an object: ${path}`)
	if (typeof value.suiteDirectory !== 'string' || value.suiteDirectory.length === 0)
		throw new Error(`suiteDirectory must be a non-empty string: ${path}`)
	if (typeof value.outputFile !== 'string' || value.outputFile.length === 0)
		throw new Error(`outputFile must be a non-empty string: ${path}`)
	return {
		suiteDirectory: resolve(dirname(path), value.suiteDirectory),
		outputFile: value.outputFile,
	}
}

const args = process.argv.slice(2)
if (args.length !== 1) throw new Error('Usage: text-v1-execution-mechanical-audit.ts <config.json>')
const configPath = resolve(args[0])
const config = parseConfig(await readJson<unknown>(configPath), configPath)
const suite = config.suiteDirectory
const allFiles = await walk(suite)
const suiteManifest = await readJson<JsonObject>(join(suite, 'frozen-inputs', 'suite-manifest.raw.json'))
const recoveryConfig = isObject(suiteManifest.recovery) ? suiteManifest.recovery : {}
if (typeof recoveryConfig.scenarioIndex !== 'number')
	throw new Error('Frozen suite manifest is missing recovery.scenarioIndex')
if (!Array.isArray(suiteManifest.arms) || !suiteManifest.arms.every((arm) => typeof arm === 'string'))
	throw new Error('Frozen suite manifest is missing string arms')
const recoveryScenario = String(recoveryConfig.scenarioIndex).padStart(3, '0')
const arms = suiteManifest.arms as string[]

const processSummary = await readJson<JsonObject>(join(suite, 'process-summary.json'))
const scenarios = Array.isArray(processSummary.scenarios) ? processSummary.scenarios : []
const processes = scenarios.flatMap((scenario) => {
	if (!isObject(scenario) || !Array.isArray(scenario.processes)) return []
	return scenario.processes.filter(isObject)
})
const expectedKills = processes.filter(
	(process) => process.signal === 'SIGKILL' && process.interrupted === true && process.markerObserved === true && process.timedOut === false,
)
const successfulProcesses = processes.filter((process) => process.exitCode === 0 && process.signal === null)
const abnormalProcesses = processes.filter(
	(process) =>
		!(process.exitCode === 0 && process.signal === null) &&
		!(process.signal === 'SIGKILL' && process.interrupted === true && process.markerObserved === true && process.timedOut === false),
)

const finalCallDirectories = new Set(
	allFiles.filter((path) => basename(path) === 'model-calls.json').map((path) => dirname(path)),
)
const callFiles = allFiles.filter((path) => {
	const name = basename(path)
	return name === 'model-calls.json' || (name === 'model-calls.partial.json' && !finalCallDirectories.has(dirname(path)))
})
const calls: Array<{ path: string; call: ModelCall }> = []
for (const path of callFiles) {
	const fileCalls = await readJson<unknown>(path)
	if (!Array.isArray(fileCalls)) throw new Error(`Expected array: ${path}`)
	for (const call of fileCalls) {
		if (!isObject(call)) throw new Error(`Expected model call object: ${path}`)
		calls.push({ path: relative(suite, path), call })
	}
}
const finishReasonCounts: Record<string, number> = {}
const modelOutputStatusCounts: Record<string, number> = {}
const outputTokenValues: number[] = []
const modelErrors: Array<{ path: string; phase: unknown; reason: string }> = []
for (const { path, call } of calls) {
	const result = isObject(call.result) ? call.result : undefined
	const finishReason = typeof result?.finishReason === 'string' ? result.finishReason : 'missing'
	finishReasonCounts[finishReason] = (finishReasonCounts[finishReason] ?? 0) + 1
	const usage = isObject(result?.usage) ? result.usage : undefined
	if (typeof usage?.outputTokens === 'number') outputTokenValues.push(usage.outputTokens)
	const resultJson = isObject(result?.json) ? result.json : undefined
	if (typeof resultJson?.status === 'string')
		modelOutputStatusCounts[resultJson.status] = (modelOutputStatusCounts[resultJson.status] ?? 0) + 1
	if (!result) modelErrors.push({ path, phase: call.phase, reason: 'missing result' })
	if (isObject(call.error)) modelErrors.push({ path, phase: call.phase, reason: stable(call.error) })
}

const requestSuffix = '-request-body.raw.txt'
const responseSuffix = '-response-body.raw.txt'
const responseMetadataSuffix = '-response-metadata.json'
const requestBodyFiles = allFiles.filter((path) => path.endsWith(requestSuffix))
const responseBodyFiles = allFiles.filter((path) => path.endsWith(responseSuffix))
const responseMetadataFiles = allFiles.filter((path) => path.endsWith(responseMetadataSuffix))
const wireSignatures = new Map<string, { count: number; body: JsonObject; phases: Set<string> }>()
const transportErrors: Array<{ path: string; reason: string }> = []
for (const path of requestBodyFiles) {
	let body: JsonObject
	try {
		const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown
		if (!isObject(parsed)) throw new Error('request body is not an object')
		body = parsed
	} catch (error) {
		transportErrors.push({ path: relative(suite, path), reason: String(error) })
		continue
	}
	const selected: JsonObject = {
		model: body.model,
		temperature: body.temperature ?? null,
		seed: body.seed ?? null,
		max_tokens: body.max_tokens ?? null,
		response_format: isObject(body.response_format)
			? {
					type: body.response_format.type ?? null,
					strict: isObject(body.response_format.json_schema)
						? body.response_format.json_schema.strict ?? null
						: null,
				}
			: null,
	}
	const metadataPath = `${path.slice(0, -requestSuffix.length)}-request-metadata.json`
	const metadata = await readJson<JsonObject>(metadataPath)
	const key = stable(selected)
	const current = wireSignatures.get(key) ?? { count: 0, body: selected, phases: new Set<string>() }
	current.count += 1
	current.phases.add(typeof metadata.phase === 'string' ? metadata.phase : 'unknown')
	wireSignatures.set(key, current)
}
for (const path of responseMetadataFiles) {
	const metadata = await readJson<JsonObject>(path)
	if (typeof metadata.status !== 'number' || metadata.status < 200 || metadata.status >= 300)
		transportErrors.push({ path: relative(suite, path), reason: `HTTP status ${String(metadata.status)}` })
}
for (const path of responseBodyFiles) {
	try {
		const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown
		if (isObject(parsed) && parsed.error !== undefined)
			transportErrors.push({ path: relative(suite, path), reason: stable(parsed.error) })
	} catch (error) {
		transportErrors.push({ path: relative(suite, path), reason: `invalid JSON response: ${String(error)}` })
	}
}
const missingResponseBodies = requestBodyFiles
	.map((path) => `${path.slice(0, -requestSuffix.length)}${responseSuffix}`)
	.filter((path) => !allFiles.includes(path))
	.map((path) => relative(suite, path))

const restoreChecks: Array<{ path: string; equal: boolean }> = []
const deliveryStatusCounts: Record<string, number> = {}
for (const path of allFiles.filter((candidate) => basename(candidate) === 'deliveries.json')) {
	const deliveries = await readJson<unknown>(path)
	if (!Array.isArray(deliveries)) throw new Error(`Expected deliveries array: ${path}`)
	for (const delivery of deliveries) {
		if (!isObject(delivery) || !isObject(delivery.beforeClose) || !isObject(delivery.afterReopen)) continue
		if (isObject(delivery.result) && typeof delivery.result.status === 'string')
			deliveryStatusCounts[delivery.result.status] = (deliveryStatusCounts[delivery.result.status] ?? 0) + 1
		restoreChecks.push({
			path: `${relative(suite, path)}#delivery-${String(delivery.deliveryIndex)}`,
			equal: stable(delivery.beforeClose.storeRead) === stable(delivery.afterReopen),
		})
	}
}
for (const path of allFiles.filter((candidate) => basename(candidate) === 'before-close.json')) {
	const afterPath = join(dirname(path), 'after-reopen.json')
	const before = await readJson<JsonObject>(path)
	const after = await readJson<JsonObject>(afterPath)
	restoreChecks.push({ path: relative(suite, dirname(path)), equal: stable(before.storeRead) === stable(after) })
}

const recoveryChecks = []
for (const arm of arms) {
	const recoveryRoot = join(suite, 'scenarios', recoveryScenario, 'recovery', arm)
	const boundary = await readJson<JsonObject>(join(recoveryRoot, 'interruption', 'interruption-boundary.json'))
	const recovery = await readJson<JsonObject>(join(recoveryRoot, 'resume', 'recovery.json'))
	const beforeRecovery = isObject(recovery.beforeRecovery) ? recovery.beforeRecovery : {}
	const afterRecovery = isObject(recovery.afterReopen) ? recovery.afterReopen : {}
	const recoveryResult = isObject(recovery.result) ? recovery.result : {}
	const interruptedProcess = processes.find((process) => process.label === `recovery-${arm}-interrupt`)
	recoveryChecks.push({
		arm,
		interruption: {
			signal: interruptedProcess?.signal ?? null,
			interrupted: interruptedProcess?.interrupted ?? null,
			markerObserved: interruptedProcess?.markerObserved ?? null,
			timedOut: interruptedProcess?.timedOut ?? null,
			boundaryEventType: isObject(boundary.event) ? boundary.event.type ?? null : null,
		},
		pendingBeforeResume: Array.isArray(beforeRecovery.observations)
			? beforeRecovery.observations.filter((item) => isObject(item) && item.metadata_status === 'pending').length
			: 0,
		pendingAfterResume: Array.isArray(afterRecovery.observations)
			? afterRecovery.observations.filter((item) => isObject(item) && item.metadata_status === 'pending').length
			: 0,
		resumeStatus: recoveryResult.status ?? null,
		beforeCloseAfterReopenEqual: isObject(recovery.beforeClose)
			? stable(recovery.beforeClose.storeRead) === stable(recovery.afterReopen)
			: false,
	})
}

const beforeFingerprint = await readJson<JsonObject>(join(suite, 'source-fingerprint.before.json'))
const afterFingerprint = await readJson<JsonObject>(join(suite, 'source-fingerprint.after.json'))
const sourceIdentifiers = await readJson<JsonObject>(join(suite, 'source-identifiers.json'))
const baselineIdentifier = isObject(sourceIdentifiers.baseline) ? sourceIdentifiers.baseline : {}
const beforeFiles = Array.isArray(beforeFingerprint.files) ? beforeFingerprint.files : []
const afterFiles = Array.isArray(afterFingerprint.files) ? afterFingerprint.files : []
const sourceParity = await readJson<unknown>(join(suite, 'source-parity.json'))
const sourceParityEntries = Array.isArray(sourceParity) ? sourceParity.filter(isObject) : []

const digests = await readJson<JsonObject>(join(suite, 'frozen-inputs', 'digests.json'))
const datasets = Array.isArray(digests.datasets) ? digests.datasets.filter(isObject) : []
const datasetChecks = []
for (const dataset of datasets) {
	if (typeof dataset.suppliedPath !== 'string' || typeof dataset.frozenPath !== 'string')
		throw new Error('Dataset digest entry is missing paths')
	const supplied = await fs.readFile(dataset.suppliedPath)
	const frozen = await fs.readFile(dataset.frozenPath)
	datasetChecks.push({
		suppliedPath: dataset.suppliedPath,
		frozenPath: dataset.frozenPath,
		byteEqual: supplied.equals(frozen),
		suppliedSha256: sha256(supplied),
		frozenSha256: sha256(frozen),
		recordedSha256: dataset.sha256,
	})
}

const stderrFiles = allFiles.filter((path) => basename(path) === 'stderr.raw.txt')
const nonEmptyStderr = []
for (const path of stderrFiles) {
	const bytes = await fs.readFile(path)
	if (bytes.length > 0) nonEmptyStderr.push({ path: relative(suite, path), bytes: bytes.length })
}

const report = {
	label: 'MECHANICAL_ONLY_SEMANTICS_UNJUDGED',
	generatedAt: new Date().toISOString(),
	suiteDirectory: suite,
	processes: {
		total: processes.length,
		successful: successfulProcesses.length,
		expectedSigkill: expectedKills.length,
		abnormal: abnormalProcesses,
		nonEmptyStderr,
	},
	modelCalls: {
		total: calls.length,
		files: {
			final: callFiles.filter((path) => basename(path) === 'model-calls.json').length,
			partialFallback: callFiles.filter((path) => basename(path) === 'model-calls.partial.json').length,
		},
		finishReasonCounts,
		modelOutputStatusCounts,
		outputTokens: {
			minimum: outputTokenValues.length > 0 ? Math.min(...outputTokenValues) : null,
			maximum: outputTokenValues.length > 0 ? Math.max(...outputTokenValues) : null,
		},
		errors: modelErrors,
		transport: {
			requests: requestBodyFiles.length,
			responses: responseBodyFiles.length,
			responseMetadata: responseMetadataFiles.length,
			missingResponseBodies,
			errors: transportErrors,
		},
		actualWireRequestSettings: [...wireSignatures.values()].map((entry) => ({
			count: entry.count,
			phases: [...entry.phases].sort(),
			...entry.body,
		})),
	},
	restore: {
		checks: restoreChecks.length,
		equal: restoreChecks.filter((check) => check.equal).length,
		mismatches: restoreChecks.filter((check) => !check.equal),
		recoveryBeforeCloseAfterReopenEqual: recoveryChecks.every((check) => check.beforeCloseAfterReopenEqual),
	},
	deliveries: {
		total: Object.values(deliveryStatusCounts).reduce((sum, count) => sum + count, 0),
		statusCounts: deliveryStatusCounts,
	},
	recovery: recoveryChecks,
	source: {
		execution: {
			arms,
			directOnly: arms.every((arm) => arm === 'direct'),
			directImplementation: 'support.loadLegacy(config).TextNeuron',
			baselineRoot: baselineIdentifier.root ?? null,
			baselineRevision: baselineIdentifier.revision ?? null,
		},
		beforeCount: beforeFiles.length,
		afterCount: afterFiles.length,
		beforeAfterEqual: stable(beforeFiles) === stable(afterFiles),
		baselineParityChecks: sourceParityEntries.length,
		baselineParityEqual: sourceParityEntries.filter((entry) => entry.equal === true).length,
		baselineParityMismatches: sourceParityEntries.filter((entry) => entry.equal !== true),
	},
	datasets: {
		checks: datasetChecks.length,
		byteEqual: datasetChecks.filter((check) => check.byteEqual).length,
		mismatches: datasetChecks.filter(
			(check) =>
				!check.byteEqual ||
				check.suppliedSha256 !== check.frozenSha256 ||
				check.frozenSha256 !== check.recordedSha256,
		),
		details: datasetChecks,
	},
}

const outputPath = resolve(suite, config.outputFile)
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(outputPath)
