/**
 * Neuron config resolver
 *
 * Resolves NeuronConfig to ResolvedNeuronConfig by applying
 * cascade logic for models and defaults for other values.
 */

import { nanoid } from 'nanoid'
import type { ParentModels } from '../types/config'
import { cascade } from '../utils/cascade'
import { NEURON_DEFAULTS } from './config.defaults'
import type { NeuronConfig, ResolvedNeuronConfig } from './types'

export function resolveNeuronConfig(
	config: NeuronConfig,
	parentModels?: ParentModels,
): ResolvedNeuronConfig {
	const model = config.model ?? parentModels?.model
	if (!model) {
		throw new Error('Neuron requires a model')
	}

	const blueprintModel = cascade(
		config.blueprintModel,
		parentModels?.blueprintModel,
		config.model,
		parentModels?.model,
	)

	return {
		model,
		blueprintModel,
		instructions: config.instructions,
		id: config.id ?? `neuron_${nanoid()}`,
		origin: config.origin ?? NEURON_DEFAULTS.origin,
		understand: {
			thresholds: {
				maxObservations:
					config.understand?.thresholds?.maxObservations ??
					NEURON_DEFAULTS.understand.thresholds.maxObservations,
				maxTokens:
					config.understand?.thresholds?.maxTokens ??
					NEURON_DEFAULTS.understand.thresholds.maxTokens,
				minImportance:
					config.understand?.thresholds?.minImportance ??
					NEURON_DEFAULTS.understand.thresholds.minImportance,
			},
		},
		query: {
			model: cascade(config.query?.model, model),
		},
	}
}
