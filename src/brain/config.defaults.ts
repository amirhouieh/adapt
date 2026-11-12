/**
 * Default values for Brain configuration
 */

export const BRAIN_DEFAULTS = {
	ingest: {
		batchSize: 20,
	},
	learning: {
		understand: {
			thresholds: {
				maxObservations: 10,
				maxTokens: 8000,
				minImportance: 0.5,
			},
		},
		governance: {
			strategy: 'cumulative' as const,
			maxTokens: 16000,
		},
	},
	evolution: {
		enabled: true,
		evaluatorSignalThreshold: 5,
		autoEvaluate: true,
	},
	dismissedBatchBuffer: {
		maxSize: 100,
	},
} as const
