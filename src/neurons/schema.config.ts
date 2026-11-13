import { z } from 'zod'
import type { GovernanceConfig } from './strategies'

/**
 * A neuron config as the model writes it: at setup and in evolution.
 */
export const neuronConfigSchema = z.object({
	id: z.string().describe('Unique identifier for this neuron (kebab-case)'),
	name: z.string().describe('Human-readable display name'),
	description: z
		.string()
		.describe(
			'Brief description of what this neuron tracks, used for query routing',
		),
	instructions: z
		.string()
		.describe(
			'What this neuron tracks and keeps in its memory, in plain sentences',
		),
})

/**
 * Full neuron config type — the model schema plus optional governance
 * for programmatic use (explicit neurons).
 */
export type GeneratedNeuronConfig = z.infer<typeof neuronConfigSchema> & {
	governance?: Partial<GovernanceConfig>
}
