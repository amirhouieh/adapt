/**
 * Text neuron type descriptor — static metadata for Brain's evolution system.
 */

import { z } from 'zod'
import type { NeuronTypeDescriptor } from '../types'
import { TextNeuron } from './class'
import type { TextNeuronConfig } from './types'

export const textNeuronDescriptor: NeuronTypeDescriptor = {
	type: 'text',

	description: `TEXT neurons build narrative prose understanding.
Best for: qualitative patterns, preferences, philosophies, interconnected concepts, nuanced reasoning.`,

	factory(config: Record<string, unknown>) {
		return new TextNeuron(config as unknown as TextNeuronConfig)
	},

	mergeUnderstandingSchema: z
		.string()
		.describe(
			'Merged understanding text combining knowledge from all source neurons',
		),

	splitUnderstandingSchema: z
		.string()
		.describe('Understanding text for this split neuron'),
}
