import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { textComparisonSupport } from '../evals/scripts/text-dag-comparison-eval'
import { textV1ExecutionDagSuiteSupport } from '../evals/scripts/text-v1-execution-dag-suite'

const repositoryRoot = resolve(import.meta.dirname, '..')
const frozenDatasetRoot = resolve(
	repositoryRoot,
	'evals/.data/text-dag-comparison-suite/2026-10-01T11-42-48.940Z/frozen-inputs',
)

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as unknown
}

interface ActualComparisonManifest {
	readonly schemaVersion: 1
	readonly baseConfig: string
	readonly datasets: readonly string[]
	readonly outputRoot: string
}

function readActualComparisonManifest(path: string): ActualComparisonManifest {
	return readJson(path) as ActualComparisonManifest
}

describe('local original-v1 eval configuration', () => {
	it.each([
		['lfm', 'liquid/lfm2.5-1.2b'],
		['qwen', 'qwen/qwen3.5-2b'],
	] as const)('keeps native model generation settings for %s', (name, modelId) => {
		const config = textComparisonSupport.configSchema.parse(
			readJson(`evals/config/text-v1-direct-local-${name}.json`),
		)
		const manifest = textV1ExecutionDagSuiteSupport.manifestSchema.parse(
			readJson(`evals/config/text-v1-execution-direct-local-${name}.json`),
		)
		const settings = textComparisonSupport.mergeRequestSettings({ providerSpecific: 'preserved' }, config)

		expect(config.provider).toEqual({
			name: 'lmstudio',
			baseUrl: 'http://127.0.0.1:1234/v1',
			modelId,
		})
		expect(config.model).toEqual({})
		expect(config.requests.maxConcurrent).toBe(1)
		expect(settings).toEqual({ providerSpecific: 'preserved', maxRetries: 0, timeout: 180000 })
		expect(manifest.arms).toEqual(['direct'])
		expect(manifest.datasets).toHaveLength(8)
		expect(manifest.datasets.every((path) => existsSync(path))).toBe(true)
		expect(manifest.datasets.every((path) => path.startsWith(frozenDatasetRoot))).toBe(true)
	})

	it('preserves existing arm and model-setting behavior', () => {
		const manifest = textV1ExecutionDagSuiteSupport.manifestSchema.parse(
			readJson('evals/config/text-v1-execution-dag-suite-gemini-budget4096.json'),
		)
		const config = textComparisonSupport.configSchema.parse(
			readJson('evals/config/text-dag-comparison-gemini-budget4096.json'),
		)

		expect(manifest.arms).toEqual(['direct', 'dag'])
		expect(textComparisonSupport.mergeRequestSettings(undefined, config)).toEqual({
			temperature: 0,
			maxOutputTokens: 4096,
			maxRetries: 1,
			timeout: 60000,
		})
	})

	it.each(['lfm', 'qwen'] as const)('configures the actual v1/v2 text-DAG suite for %s', (name) => {
		const manifest = readActualComparisonManifest(`evals/config/text-dag-comparison-suite-local-${name}.json`)
		const geminiManifest = readActualComparisonManifest(
			'evals/config/text-dag-comparison-suite-gemini-budget4096.json',
		)
		const config = textComparisonSupport.configSchema.parse(
			readJson(`evals/config/text-dag-comparison-local-${name}.json`),
		)
		const directConfig = textComparisonSupport.configSchema.parse(
			readJson(`evals/config/text-v1-direct-local-${name}.json`),
		)
		const geminiConfig = textComparisonSupport.configSchema.parse(
			readJson('evals/config/text-dag-comparison-gemini-budget4096.json'),
		)

		expect(manifest.schemaVersion).toBe(1)
		expect(manifest.baseConfig).toBe(resolve(repositoryRoot, `evals/config/text-dag-comparison-local-${name}.json`))
		expect(manifest.datasets).toEqual(geminiManifest.datasets)
		expect(manifest.datasets).toHaveLength(8)
		expect(manifest.datasets.every((path) => existsSync(path))).toBe(true)
		expect(manifest.outputRoot).toBe(
			resolve(repositoryRoot, `evals/.data/text-dag-comparison-suite-local-${name}`),
		)
		expect(config).toEqual({
			...directConfig,
			paths: {
				...directConfig.paths,
				outputRoot: resolve(repositoryRoot, `evals/.data/text-dag-comparison-local-${name}`),
			},
		})
		expect(config.bounds).toEqual(geminiConfig.bounds)
	})
})
