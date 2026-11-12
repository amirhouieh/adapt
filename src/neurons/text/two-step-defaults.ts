/**
 * Default two-step learning setup for a TextNeuron created from plain options
 * (model + instructions), as Brain and most callers do.
 *
 * Values follow the tested LFM3 runs: 32k loaded context, 8192 output tokens
 * (room for mandatory thinking), temperature 0, batches of up to 8 inputs.
 */

import { randomUUID } from 'node:crypto'
import {
	createAdaptTextProcedureProvider,
	createConservativeByteTokenCounter,
	type TextLearningConfig,
	twoStepRecipeRef,
} from '../../learning/text-procedures'
import type { TextProfileSnapshot } from '../../learning/text-state'
import type { AdaptLLMPlugin, LanguageModel } from '../../llm'
import { createBoundedDeviceScheduler } from '../../llm/local/scheduler'
import type {
	AdaptiveTextLearningConfig,
	AdaptiveTextLearningRuntime,
} from './adaptive-runtime'

const contextTokens = 32768
const maxOutputTokens = 8192

export function modelRefId(model: LanguageModel): string {
	if (typeof model === 'string') return model
	const value = model as { modelId?: unknown; id?: unknown }
	if (typeof value.modelId === 'string') return value.modelId
	if (typeof value.id === 'string') return value.id
	return 'default'
}

export function defaultTwoStepRuntime(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
): AdaptiveTextLearningRuntime {
	const tokens = createConservativeByteTokenCounter({
		requestTemplateOverheadTokens: 64,
		textTemplateOverheadTokens: 0,
	})
	return {
		models: [
			{
				ref: { id: modelRefId(model), version: '1' },
				tokens,
				provider: createAdaptTextProcedureProvider({
					llm,
					model,
					settings: { temperature: 0, maxOutputTokens },
					scheduler: createBoundedDeviceScheduler({
						maxConcurrent: 1,
						maxQueued: 4,
					}),
					priority: 'background',
				}),
			},
		],
		stateIds: { next: (kind) => `${kind}-${randomUUID()}` },
		inputIds: { next: () => randomUUID() },
		clock: { now: () => new Date().toISOString() },
		scheduler: {
			schedule(dueAt, callback) {
				const handle = setTimeout(
					callback,
					Math.max(0, Date.parse(dueAt) - Date.now()),
				)
				handle.unref?.()
				return handle
			},
			cancel(handle) {
				clearTimeout(handle as ReturnType<typeof setTimeout>)
			},
		},
		policy: {
			maxRetainedProfiles: 8,
			maxFlushRuns: 64,
			headStateId: 'adaptive-text-profile-head',
			narrativeMemoryId: 'current',
			stateKind: 'adaptive-text-learning',
		},
		countInputTokens: (inputs) =>
			inputs.reduce((sum, item) => sum + tokens.countText(item.text).tokens, 0),
		onError: (error) => {
			console.error('[two-step] background learning error:', error)
		},
	}
}

export function defaultTwoStepLearning(input: {
	neuronId: string
	instructions: string
	developerInstructions: readonly string[]
	llm: AdaptLLMPlugin
	model: LanguageModel
}): AdaptiveTextLearningConfig {
	const runtime = defaultTwoStepRuntime(input.llm, input.model)
	const modelRef = runtime.models[0].ref
	const configuration: TextLearningConfig = {
		model: modelRef,
		activeProcedure: twoStepRecipeRef,
		allowedProcedures: [twoStepRecipeRef],
		lens: {
			purpose: input.instructions,
			developerInstructions: [...input.developerInstructions],
			instructionPrecedence: ['developer instructions', 'incoming data'],
			incomingTextRole: 'data-only',
		},
		batching: {
			maxItems: 8,
			maxInputCharacters: 8000,
			maxInputTokens: 8000,
			maxDelayMs: 3600000,
			acceptCallerUrgency: true,
		},
		input: { maxItemCharacters: 2000 },
		memory: { maxCharacters: 4 * maxOutputTokens, allowExplicitClear: false },
		generation: {
			loadedContextTokens: contextTokens,
			reservedOutputTokens: maxOutputTokens,
			maxProviderCalls: 48,
			maxTokenClaims: 240000,
			maxBudgetClaims: 64,
		},
		planning: { maxNodes: 2, maxCollectionItems: 8, maxOperations: 2 },
		retries: {
			maxLogicalAttempts: 3,
			initialDelayMs: 1000,
			maxDelayMs: 4000,
			terminalAfterMs: 3600000,
		},
		history: { maxEntries: 64, maxCharacters: 8000 },
		idempotence: { processedIdHorizonMs: 86400000, maxProcessedIds: 1000 },
	}
	const ref = { id: `two-step-${input.neuronId}`, version: '1' }
	const initialProfile: TextProfileSnapshot<TextLearningConfig> = {
		ref,
		revision: 1,
		configuration,
		bindings: {
			neuron: {
				id: input.neuronId,
				incarnation: 'default',
				ownership_revision: 1,
			},
			profile: ref,
			profile_revision: 1,
			procedure: configuration.activeProcedure,
			model: configuration.model,
			registry_lineage: 'adapt.two-step',
			referenced_definition_digest: 'adapt.two-step.v1',
			allowed_catalogue_digest: 'adapt.two-step.v1',
		},
		createdAt: new Date().toISOString(),
	}
	return { mode: 'adaptive', initialProfile, runtime }
}
