/**
 * Default values for TextNeuron configuration
 */

import type { UnderstandThresholds } from '../base/types'

export const TEXT_NEURON_DEFAULTS = {
	origin: 'developer' as const,
	understand: {
		thresholds: {
			maxObservations: 10,
			maxTokens: 8000,
			minImportance: 0.5,
		} satisfies Required<UnderstandThresholds>,
	},
} as const
