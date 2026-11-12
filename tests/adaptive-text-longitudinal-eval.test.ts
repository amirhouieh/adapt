import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'

import { createAiSdkLLM, type AdaptModelConfig } from '../src'

import {
	expandExecutionPlan,
	readLongitudinalConfig,
	readSelectedStream,
	reserveRunDirectory,
	observedModelProviderFactory,
	type LongitudinalArm,
	type LongitudinalConfig,
} from '../evals/scripts/adaptive-text-longitudinal-eval'

const lfmConfigPath = resolve('evals/config/adaptive-text-learning/development-ab-lfm.json')
const qwenConfigPath = resolve('evals/config/adaptive-text-learning/development-ab-qwen.json')
const v1LfmConfigPath = resolve('evals/config/adaptive-text-learning/development-a-v1-lfm.json')
const v1QwenConfigPath = resolve('evals/config/adaptive-text-learning/development-a-v1-qwen.json')
const directLfmConfigPath = resolve('evals/config/adaptive-text-learning/development-b-fixed-direct-lfm.json')
const directQwenConfigPath = resolve('evals/config/adaptive-text-learning/development-b-fixed-direct-qwen.json')

describe('adaptive text longitudinal evaluation mechanics', () => {
	it('expands the bounded development A/B run without reading unselected streams', () => {
		const config = readLongitudinalConfig(lfmConfigPath)
		const sealed = config.streams.find(({ visibility }) => visibility === 'sealed-heldout')
		expect(sealed).toBeDefined()
		if (sealed === undefined) return
		sealed.path = resolve('does-not-exist', 'sealed-stream.json')
		const plan = expandExecutionPlan(config)
		expect(plan).toEqual([
			{ id: 'rep-01--developer-practices--A-v1', streamId: 'developer-practices', armId: 'A-v1', repetition: 1 },
			{ id: 'rep-01--developer-practices--B-fixed-direct', streamId: 'developer-practices', armId: 'B-fixed-direct', repetition: 1 },
		])
	})

	it('supports the declared four-stream four-arm three-repetition matrix', () => {
		const config = readLongitudinalConfig(lfmConfigPath)
		const fixed = config.arms.find((arm): arm is Extract<LongitudinalArm, { kind: 'current' }> => arm.id === 'B-fixed-direct')
		expect(fixed).toBeDefined()
		if (fixed === undefined) return
		const adaptive = structuredClone(fixed)
		adaptive.id = 'C-adaptive'
		adaptive.profile.configuration.selection.mode = 'periodic'
		const richer = structuredClone(fixed)
		richer.id = 'D-fixed-rich'
		const full: LongitudinalConfig = {
			...config,
			arms: [config.arms[0]!, fixed, adaptive, richer],
			selection: {
				streamIds: config.streams.map(({ id }) => id),
				armIds: ['A-v1', 'B-fixed-direct', 'C-adaptive', 'D-fixed-rich'],
				repetitions: [1, 2, 3],
			},
		}
		expect(expandExecutionPlan(full)).toHaveLength(48)
	})

	it('parses both explicit local-model configs and verifies the selected development fixture', () => {
		const lfm = readLongitudinalConfig(lfmConfigPath)
		const qwen = readLongitudinalConfig(qwenConfigPath)
		const v1Lfm = readLongitudinalConfig(v1LfmConfigPath)
		const v1Qwen = readLongitudinalConfig(v1QwenConfigPath)
		const directLfm = readLongitudinalConfig(directLfmConfigPath)
		const directQwen = readLongitudinalConfig(directQwenConfigPath)
		expect(lfm.provider.modelId).toBe('liquid/lfm2.5-1.2b')
		expect(qwen.provider.modelId).toBe('qwen/qwen3.5-2b')
		expect(expandExecutionPlan(v1Lfm)).toHaveLength(1)
		expect(expandExecutionPlan(v1Qwen)).toHaveLength(1)
		expect(expandExecutionPlan(directLfm)).toHaveLength(1)
		expect(expandExecutionPlan(directQwen)).toHaveLength(1)
		const selected = readSelectedStream(lfm, 'developer-practices').stream
		expect(selected.visibility).toBe('development')
		expect(selected.inputs).toHaveLength(180)
		expect(selected.checkpoints).toEqual([30, 60, 90, 120, 150, 180])
	})

	it('reserves a fresh run directory and refuses an overwrite', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'adapt-longitudinal-'))
		try {
			expect(reserveRunDirectory(root, 'run')).toBe(resolve(root, 'run'))
			expect(() => reserveRunDirectory(root, 'run')).toThrow()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('resolves a persisted local model through a fresh official plugin instance', () => {
		const model = {
			provider: 'lm-studio.chat',
			modelId: 'fixture/local-model',
		} as unknown as LanguageModel
		const first = createAiSdkLLM()
		const persisted = first.model.toConfig(model) as AdaptModelConfig<'ai-sdk'>
		const observed = observedModelProviderFactory('fixture/local-model', model)
		const restored = createAiSdkLLM({ providers: { [observed.providerName]: observed.factory } })
		const resolver = restored as typeof restored & {
			resolveModel(value: AdaptModelConfig<'ai-sdk'>): LanguageModel
		}
		expect(resolver.resolveModel(persisted)).toBe(model)
	})
})
