/**
 * Default values for Neuron configuration
 */

import type { UnderstandThresholds } from './types'

export const NEURON_DEFAULTS = {
	origin: 'developer' as const,
	understand: {
		thresholds: {
			maxObservations: 10,
			maxTokens: 8000,
			minImportance: 0.5,
		} satisfies Required<UnderstandThresholds>,
	},
} as const
