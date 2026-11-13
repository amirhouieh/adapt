/**
 * Neuron setup and evolution.
 *
 * Setup: one call turns the brain prompt into neuron configs.
 * Evolution: one agent loop looks at the neurons, their memories and the
 * inputs no neuron took (gaps), and changes neurons through tools. Each tool
 * applies its change at once, through the same Brain methods users call.
 */

import { z } from 'zod'
import { TWO_STEP_NOTHING_RELEVANT } from '../learning/text-procedures/two-step'
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

// ── Leftover ────────────────────────────────────────────────────────────────

/**
 * One leftover call looks at a chunk of batches some neuron took, each with
 * the notes the neurons kept, and copies what no neuron kept. Prompt as
 * tested in evals/scripts/leftover-prompt-lfm3.ts.
 */
export const leftoverSystemPrompt = `Here are some entries. Each entry has data, and the notes that were already taken from it.
Our job is to find, for each entry, what in its data is not in its notes.

Reply in plain text, one block per entry, starting with its name, like "Entry 1:". Under it, copy the parts of the data that are not in the notes. If everything in an entry's data is in its notes, write: Entry N: ${TWO_STEP_NOTHING_RELEVANT}`

/** One entry's text: the batch data and the notes neurons kept from it. */
export function leftoverEntry(data: string[], notes: string[]): string {
	return `Data:\n${data.join('\n')}\n\nNotes already taken:\n${notes.join('\n') || '(none)'}`
}

export function leftoverPrompt(entries: string[]): string {
	return entries
		.map((entry, i) => `<Entry ${i + 1}>\n${entry}\n</Entry ${i + 1}>`)
		.join('\n\n')
}

/**
 * True when the leftover reply holds nothing: empty, or every line is only
 * an entry name or says the entry has nothing left.
 */
export function leftoverIsEmpty(reply: string, entryCount: number): boolean {
	const empty = new Set([TWO_STEP_NOTHING_RELEVANT])
	for (let i = 1; i <= entryCount; i++) {
		empty.add(`Entry ${i}:`)
		empty.add(`Entry ${i}: ${TWO_STEP_NOTHING_RELEVANT}`)
	}
	return reply
		.split('\n')
		.map((line) => line.trim())
		.every((line) => line === '' || empty.has(line))
}

const NEW_NEURON_NOTE =
	'This neuron is new. It has no memory yet. When this run ends it will learn the stored gap inputs.'

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
	// Neurons made in this run: their memory is empty until the run ends
	const madeThisRun = new Set<string>()
	return {
		readMemory: tool({
			description: "Read a neuron's memory.",
			inputSchema: neuronIdSchema,
			execute: ({ id }: z.infer<typeof neuronIdSchema>) =>
				attempt(async () => {
					const neuron = brain.getNeuron(id)
					if (!neuron) throw new Error(`Neuron ${id} not found`)
					const memory = await neuron.getUnderstanding()
					if (memory) return { memory }
					return { memory: madeThisRun.has(id) ? NEW_NEURON_NOTE : '(empty)' }
				}),
		}),
		createNeuron: tool({
			description: 'Create a neuron for a topic no neuron covers.',
			inputSchema: neuronConfigSchema,
			execute: (config: z.infer<typeof neuronConfigSchema>) =>
				attempt(async () => {
					await brain.addNeuron(config)
					madeThisRun.add(config.id)
					onChange({ action: 'create', neuronId: config.id })
					return { created: config.id, note: NEW_NEURON_NOTE }
				}),
		}),
		updateNeuron: tool({
			description:
				"Rewrite a neuron's name, description and instructions. Its memory is kept.",
			inputSchema: neuronConfigSchema,
			execute: ({ id, ...changes }: z.infer<typeof neuronConfigSchema>) =>
				attempt(async () => {
					const before = brain.getNeuron(id)
					const previous = before && {
						name: before.name,
						description: before.description,
						instructions: before.instructions,
					}
					const neuron = await brain.updateNeuron(id, changes)
					if (
						previous &&
						neuron.name === previous.name &&
						neuron.description === previous.description &&
						neuron.instructions === previous.instructions
					)
						return { unchanged: id }
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
					madeThisRun.add(config.id)
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
					madeThisRun.delete(id)
					onChange({ action: 'remove', neuronId: id })
					return { removed: id }
				}),
		}),
	}
}
