import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { RecipeExecution } from '../src/learning'
import {
	modelCapabilityLadderSupport,
	type CapabilityDataset,
} from '../evals/scripts/model-capability-ladder-eval'
import {
	narrativeOutputModeSupport,
	synthesisCommit,
} from '../evals/scripts/narrative-output-mode-eval'

const repositoryRoot = resolve(import.meta.dirname, '..')

function parseJson(path: string): unknown {
	return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as unknown
}

function dataset(): CapabilityDataset {
	return modelCapabilityLadderSupport.datasetSchema.parse(
		parseJson('evals/datasets/model-capability-ladder.json'),
	)
}

describe('narrative output-mode eval harness', () => {
	it('freezes two valid configs over three stage-09 cases and 18 calls', () => {
		const suppliedDataset = dataset()
		for (const model of ['lfm', 'qwen']) {
			const config = narrativeOutputModeSupport.configSchema.parse(
				parseJson(`evals/config/narrative-output-mode-${model}.json`),
			)
			const cases = narrativeOutputModeSupport.selectFrozenCases(
				suppliedDataset,
				config.sourceStageId,
			)
			expect(cases).toHaveLength(3)
			expect(config.arms).toEqual(['edit-action', 'plain-text'])
			expect(cases.length * config.arms.length * config.repetitions).toBe(18)
			expect(config.settings).toEqual({
				temperature: 0,
				maxOutputTokens: 2048,
				maxRetries: 0,
				timeoutMs: 180000,
			})
			for (const suppliedCase of cases) {
				expect(suppliedCase.stage.id).toBe(
					'09-production-recipe-default-bound',
				)
				expect(suppliedCase.stage.recipeLimits.maxMemoryCharacters).toBe(2000)
			}
		}
	})

	it('normalizes provider finish reasons for production completeness checks', () => {
		expect(narrativeOutputModeSupport.normalizeFinishReason('stop')).toBe('stop')
		expect(narrativeOutputModeSupport.normalizeFinishReason('length')).toBe(
			'length',
		)
		expect(narrativeOutputModeSupport.normalizeFinishReason('tool-calls')).toBe(
			'tool-calls',
		)
		expect(narrativeOutputModeSupport.normalizeFinishReason('content-filter')).toBe(
			'unknown',
		)
	})

	it('maps an accepted recipe patch to the pinned SQLite synthesis commit', () => {
		const config = narrativeOutputModeSupport.configSchema.parse(
			parseJson('evals/config/narrative-output-mode-lfm.json'),
		)
		const ids = {
			setupInput: 'setup-input',
			setupWork: 'setup-work',
			setupAttempt: 'setup-attempt',
			setupHistory: 'setup-history',
			sourceInput: 'source-input',
			observerWork: 'observer-work',
			observerAttempt: 'observer-attempt',
			observerHistory: 'observer-history',
			observation: 'case:observation',
			synthesisWork: 'synthesis-work',
			synthesisAttempt: 'synthesis-attempt',
			synthesisHistory: 'synthesis-history',
		}
		const execution: RecipeExecution = {
			recipe: { id: config.ids.recipeId, version: config.ids.recipeVersion },
			revisions: {
				memory: 2,
				configuration: 0,
				registry: config.ids.registryRevision,
			},
			result: {
				outcome: 'change',
				patch: {
					kind: 'replace_text',
					memoryId: config.ids.memoryId,
					text: 'Updated complete understanding.',
				},
				expectedMemoryRevision: 2,
				expectedConfigurationRevision: 0,
				consumedInputIds: [ids.observation],
				pendingInputIds: [],
			},
			nodes: [],
			pending: [],
			budget: null,
		}
		const commit = synthesisCommit(config, ids, execution, 2, 0)
		expect(commit).toMatchObject({
			expected_memory_revision: 2,
			expected_config_revision: 0,
			input_ids: [ids.observation],
			outcome: 'change',
			patch: {
				type: 'replace',
				records: [
					{
						id: config.ids.memoryId,
						data: 'Updated complete understanding.',
					},
				],
			},
			observations: { mark_processed_ids: [ids.observation] },
		})
	})
})
