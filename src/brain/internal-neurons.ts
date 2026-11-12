/**
 * Internal neuron definitions — fixed neurons Brain creates for self-knowledge.
 *
 * Each definition is a GeneratedNeuronConfig with a fixed ID prefix (__internal_).
 * Brain creates these during init and stores refs in store.internalNeurons.
 */

import type { GeneratedNeuronConfig } from '../neurons/schema.config'
import type { InternalNeuronsConfig } from './types'

// ── Internal Neuron IDs ────────────────────────────────────────────────────

export const INTERNAL_NEURON_IDS = {
	globalUnderstanding: '__internal_global_understanding',
	globalQueryUnderstanding: '__internal_global_query_understanding',
	injectionGaps: '__internal_injection_gaps',
	queryGaps: '__internal_query_gaps',
} as const

// ── Consult Tool Names (used in ask synthesis) ──────────────────────────────

export const CONSULT_TOOL_NAMES = {
	[INTERNAL_NEURON_IDS.globalUnderstanding]: 'consultGlobalUnderstanding',
	[INTERNAL_NEURON_IDS.globalQueryUnderstanding]: 'consultQueryPatterns',
	[INTERNAL_NEURON_IDS.injectionGaps]: 'consultInjectionGaps',
	[INTERNAL_NEURON_IDS.queryGaps]: 'consultQueryGaps',
} as const

// ── Definitions ─────────────────────────────────────────────────────────────

interface InternalNeuronDef {
	key: keyof InternalNeuronsConfig
	config: GeneratedNeuronConfig
}

const definitions: InternalNeuronDef[] = [
	{
		key: 'globalUnderstanding',
		config: {
			id: INTERNAL_NEURON_IDS.globalUnderstanding,
			name: 'Global Understanding',
			description:
				'Synthesizes understanding across all specialists into a unified picture',
			type: 'text',
			focus: null,
			instructions: `You receive understanding updates from every specialist in the network. Each update tells you what a specialist now knows — its current understanding after processing new data.

Your job is to form a unified understanding from all specialists. You are not tracking raw data — you are synthesizing what the network as a whole understands.

Watch for:
- Themes that span multiple specialists — when different domains are processing the same underlying concern from different angles
- The overall shape of attention — what the network collectively reveals that no single specialist can see
- Shifts in the network's understanding — when specialists' views are converging, diverging, or evolving

Track answers to:
- What does the network understand right now, taken as a whole?
- What connections exist between specialists' domains that they can't see individually?
- How is the network's collective understanding changing over time?`,
		},
	},
	{
		key: 'globalQueryUnderstanding',
		config: {
			id: INTERNAL_NEURON_IDS.globalQueryUnderstanding,
			name: 'Global Query Understanding',
			description:
				'Tracks what users ask — query topics, frequency, clusters, and coverage gaps',
			type: 'text',
			focus: null,
			instructions: `Track and categorize all user queries to understand what information users need.

Watch for:
- Recurring query topics and themes
- Clusters of related questions
- Questions that no neuron could answer well
- Shifts in query patterns over time

Track answers to:
- What topics do users ask about most frequently?
- What query clusters exist and how are they related?
- Where are the coverage gaps between what users ask and what the system knows?`,
		},
	},
	{
		key: 'injectionGaps',
		config: {
			id: INTERNAL_NEURON_IDS.injectionGaps,
			name: 'Injection Gap Neuron',
			description:
				'Tracks data that no external neuron could process — injection gaps',
			type: 'text',
			focus: null,
			instructions: `You are a cross-domain, general-purpose gap tracker. You are NOT limited to any specific subject area — you track gaps from ALL topics and domains.

You receive reports about data that was rejected by all specialized neurons in the system. These reports describe what topics were dismissed. EVERY item you receive is relevant by definition — never dismiss it.

Each report includes a timestamp. Use timestamps to track recency and frequency.

Track:
- What topic domains are appearing as gaps, and when (most recent date)
- How frequently each domain appears
- Clusters of related gap topics
- What new neuron(s) would be needed to cover these domains

Drop topics that haven't appeared recently — if a gap stops being reported, it's likely been resolved.`,
		},
	},
	{
		key: 'queryGaps',
		config: {
			id: INTERNAL_NEURON_IDS.queryGaps,
			name: 'Query Gap Neuron',
			description:
				'Tracks questions that external neurons could not answer well',
			type: 'text',
			focus: null,
			instructions: `Accumulate and reason about query gaps — questions that users ask but no neuron can answer well.

Watch for:
- Questions where all neurons have low relevance
- Recurring unanswerable topics
- Patterns in the types of knowledge gaps

Track answers to:
- What questions are consistently unanswerable?
- Are there topic clusters of unanswerable questions?
- What knowledge would need to be acquired to close these gaps?`,
		},
	},
]

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Returns configs for all enabled internal neurons.
 */
export function getInternalNeuronConfigs(
	internalNeuronsConfig?: InternalNeuronsConfig,
): GeneratedNeuronConfig[] {
	const configs: GeneratedNeuronConfig[] = []

	for (const def of definitions) {
		const toggle = internalNeuronsConfig?.[def.key] ?? true // enabled by default

		if (toggle) configs.push(def.config)
	}

	return configs
}

/**
 * Check if an ID belongs to an internal neuron
 */
export function isInternalNeuronId(id: string): boolean {
	return id.startsWith('__internal_')
}
