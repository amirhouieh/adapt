/**
 * Utility functions for evolution handlers
 */

import { nanoid } from 'nanoid'
import type { GeneratedNeuronConfig } from '../../neurons'

/**
 * Create a complete GeneratedNeuronConfig from partial config
 *
 * Handlers only generate name, description, and instructions.
 * This fills in the id. Governance comes from
 * Brain (`learning.governance`, then Brain defaults).
 */
export function createCompleteConfig(partial: {
	name: string
	description: string
	instructions: string
}): GeneratedNeuronConfig {
	return {
		id: nanoid(),
		name: partial.name,
		description: partial.description,
		instructions: partial.instructions,
	}
}

/**
 * Stringify any understanding value for display in prompts
 */
export function stringifyUnderstanding(understanding: unknown): string {
	if (!understanding) return '(No understanding yet)'
	if (typeof understanding === 'string')
		return understanding || '(No understanding yet)'
	return JSON.stringify(understanding, null, 2)
}
