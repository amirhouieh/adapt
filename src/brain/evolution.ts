/**
 * Neuron setup and evolution.
 *
 * Setup: one call turns the brain prompt into neuron configs.
 * Evolution: one agent loop looks at the neurons, their memories and the
 * inputs no neuron took (gaps), and changes neurons through tools. Each tool
 * applies its change at once, through the same Brain methods users call.
 */

import { z } from 'zod'
import { tool } from '../llm'
import { neuronConfigSchema } from '../neurons/schema.config'
import type { Brain } from './class'

// ── Setup ───────────────────────────────────────────────────────────────────

export const neuronConfigsSchema = z.object({
	neurons: z.array(neuronConfigSchema).describe('The neurons this brain needs'),
})

export function setupPrompt(brainPrompt: string): string {
	return `You set up a memory system. It is made of neurons. Each neuron reads incoming text and keeps one plain-text memory about its own topic. Questions are answered from those memories.

# What the user wants the system to track

${brainPrompt}

# Task

Decide which neurons the system needs. Use as few as cover the request; give a topic its own neuron only when it is clearly separate from the others. For each neuron write:
- id: kebab-case, unique
- name: a short display name
- description: one sentence on what it knows, used to pick it for questions
- instructions: what it tracks and keeps in memory, in plain sentences`
}

// ── Evolution ───────────────────────────────────────────────────────────────

export type EvolutionChange =
	| { action: 'create' | 'update' | 'remove'; neuronId: string }
	| { action: 'merge'; neuronId: string; mergedIds: string[] }

export type EvolutionAction = EvolutionChange['action']

export interface EvolutionResult {
	/** Changes applied, in order. Empty when the shape already fit. */
	changes: EvolutionChange[]
	/** What the model wrote while it worked. */
	reasoning: string
}

export interface EvolutionSignal {
	source: string
	description: string
	timestamp: Date
}

export interface EvolutionView {
	brainPrompt: string
	neurons: Array<{
		id: string
		name: string
		description: string
		instructions: string
		memoryLength: number
	}>
	/** Inputs no neuron took, oldest first. */
	gaps: string[]
	signals: EvolutionSignal[]
	/** Recent past changes, oldest first. */
	history: string[]
}

export const evolutionSystemPrompt = `You keep the shape of a memory system right. The system is made of neurons. Each neuron reads incoming text and keeps one plain-text memory about its own topic.

Look at the neurons, the inputs no neuron took (gaps) and the signals. Change neurons only where it helps what the user wants tracked:
- createNeuron: the gaps hold a topic the user wants tracked and no neuron covers it.
- updateNeuron: a neuron should track more, less or something else. Its memory is kept.
- mergeNeurons: two or more neurons track the same thing. Their memories are joined.
- removeNeuron: a neuron does not serve what the user wants. Its memory is lost.
To split a neuron, update it to the narrower topic and create neurons for the rest.

Use readMemory to see what a neuron has learned before you change or remove it. Gaps that the user does not want tracked are noise: leave them. Doing nothing is a good answer when the shape already fits. Stop when you are done.`

export function evolutionPrompt(view: EvolutionView): string {
	const neurons = view.neurons.length
		? view.neurons
				.map((n) =>
					[
						`## ${n.id}`,
						`name: ${n.name}`,
						`description: ${n.description}`,
						`instructions: ${n.instructions}`,
						`memory: ${n.memoryLength > 0 ? `${n.memoryLength} characters` : 'empty'}`,
					].join('\n'),
				)
				.join('\n\n')
		: '(no neurons yet)'
	const list = (items: string[]) =>
		items.length ? items.map((item) => `- ${item}`).join('\n') : '(none)'

	return `# What the user wants tracked

${view.brainPrompt}

# Neurons

${neurons}

# Inputs no neuron took (oldest first)

${list(view.gaps)}

# Signals

${list(view.signals.map((s) => `[${s.source}] ${s.description}`))}

# Recent changes

${list(view.history)}`
}

const neuronIdSchema = z.object({ id: z.string().describe('The neuron id') })
const mergeSchema = neuronConfigSchema.extend({
	ids: z
		.array(z.string())
		.describe('Ids of the neurons to merge (two or more)'),
})

/** Run `apply`; a failure goes back to the model as `{ error }`. */
async function attempt<T>(
	apply: () => Promise<T>,
): Promise<T | { error: string }> {
	try {
		return await apply()
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * Tools for the evolution loop. Each change is applied at once and reported
 * through `onChange`.
 */
export function evolutionTools(
	brain: Brain,
	onChange: (change: EvolutionChange) => void,
) {
	return {
		readMemory: tool({
			description: "Read a neuron's memory.",
			inputSchema: neuronIdSchema,
			execute: ({ id }: z.infer<typeof neuronIdSchema>) =>
				attempt(async () => {
					const neuron = brain.getNeuron(id)
					if (!neuron) throw new Error(`Neuron ${id} not found`)
					return { memory: (await neuron.getUnderstanding()) || '(empty)' }
				}),
		}),
		createNeuron: tool({
			description: 'Create a neuron for a topic no neuron covers.',
			inputSchema: neuronConfigSchema,
			execute: (config: z.infer<typeof neuronConfigSchema>) =>
				attempt(async () => {
					await brain.addNeuron(config)
					onChange({ action: 'create', neuronId: config.id })
					return { created: config.id }
				}),
		}),
		updateNeuron: tool({
			description:
				"Rewrite a neuron's name, description and instructions. Its memory is kept.",
			inputSchema: neuronConfigSchema,
			execute: ({ id, ...changes }: z.infer<typeof neuronConfigSchema>) =>
				attempt(async () => {
					await brain.updateNeuron(id, changes)
					onChange({ action: 'update', neuronId: id })
					return { updated: id }
				}),
		}),
		mergeNeurons: tool({
			description:
				'Replace two or more neurons with one new neuron. Their memories are joined.',
			inputSchema: mergeSchema,
			execute: ({ ids, ...config }: z.infer<typeof mergeSchema>) =>
				attempt(async () => {
					await brain.mergeNeurons(ids, config)
					onChange({ action: 'merge', neuronId: config.id, mergedIds: ids })
					return { merged: ids, into: config.id }
				}),
		}),
		removeNeuron: tool({
			description: 'Remove a neuron and its memory.',
			inputSchema: neuronIdSchema,
			execute: ({ id }: z.infer<typeof neuronIdSchema>) =>
				attempt(async () => {
					await brain.removeNeuron(id)
					onChange({ action: 'remove', neuronId: id })
					return { removed: id }
				}),
		}),
	}
}
