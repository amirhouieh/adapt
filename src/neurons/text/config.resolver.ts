/**
 * TextNeuron config resolver
 *
 * Resolves TextNeuronConfig to ResolvedTextNeuronConfig by applying
 * cascade logic for models and defaults for other values.
 */

import { nanoid } from 'nanoid'
import type { ParentModels } from '../../types/config'
import { cascade } from '../../utils/cascade'
import { TEXT_NEURON_DEFAULTS } from './config.defaults'
import type { ResolvedTextNeuronConfig, TextNeuronConfig } from './types'

export function resolveTextNeuronConfig(
	config: TextNeuronConfig,
	parentModels?: ParentModels,
): ResolvedTextNeuronConfig {
	const model = config.model ?? parentModels?.model
	if (!model) {
		throw new Error('TextNeuron requires a model')
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
		origin: config.origin ?? TEXT_NEURON_DEFAULTS.origin,
		understand: {
			thresholds: {
				maxObservations:
					config.understand?.thresholds?.maxObservations ??
					TEXT_NEURON_DEFAULTS.understand.thresholds.maxObservations,
				maxTokens:
					config.understand?.thresholds?.maxTokens ??
					TEXT_NEURON_DEFAULTS.understand.thresholds.maxTokens,
				minImportance:
					config.understand?.thresholds?.minImportance ??
					TEXT_NEURON_DEFAULTS.understand.thresholds.minImportance,
			},
		},
		query: {
			model: cascade(config.query?.model, model),
		},
	}
}
