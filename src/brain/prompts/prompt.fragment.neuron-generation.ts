/**
 * Reusable prompt fragment for neuron configuration generation
 *
 * Contains the 7 principles playbook and output format guidance.
 * Embedded by both the root decomposition prompt and evolution create prompt.
 *
 * Type section is built dynamically from registered descriptors.
 */

import type { NeuronTypeDescriptor } from '../../neurons/types'

const principlesSection = `Follow these principles when generating neuron configurations:

PRINCIPLE 1: UNDERSTAND BEFORE DECOMPOSING

Before creating neurons, analyze:
- What is being tracked? Patterns, preferences, behaviors, states, relationships
- What questions will be asked? Prediction, explanation, comparison, recommendation
- What data will flow in? Events, documents, conversations, observations
- What's the time horizon? Session, days, months, ongoing

PRINCIPLE 2: FIND ORTHOGONAL DIMENSIONS

Decompose the domain into independent dimensions — aspects that:
- Can evolve at different rates
- Answer fundamentally different question types
- Can be reasoned about without reference to each other

Test for orthogonality: "If dimension A changes significantly, does B necessarily change?" If no, they are orthogonal and may warrant separate neurons.

Test for independence: "Can I ask a meaningful question about A without needing to know about B?" If yes, they are separable concerns.

PRINCIPLE 3: DECIDE NEURON COUNT DELIBERATELY

Fewer neurons when:
- Domain is simple or highly interconnected
- Questions tend to be broad, crossing multiple aspects
- Token budget is a concern
- Dimensions don't evolve independently

More neurons when:
- Domain has clearly separable aspects
- Questions are often specific to one aspect
- Different aspects require different depth
- Aspects evolve at very different rates

Heuristic: Start with the minimum number that provides meaningful separation. One well-scoped neuron is better than three overlapping ones.

PRINCIPLE 4: GENERIC VS SPECIALIST TRADE-OFF

Generic neuron: Broad coverage, sees cross-cutting patterns, answers "big picture" questions. Risk: may lack depth.

Specialist neurons: Deep focus on specific aspect, answers detailed questions within scope. Risk: may miss connections.

Decision logic:
- If all expected questions are broad → single generic may suffice
- If questions span broad and specific → consider generic + specialists
- If questions are always aspect-specific → specialists without generic
- If aspects interact heavily → generic may capture interactions better than siloed specialists

PRINCIPLE 5: DEFINE CLEAR BOUNDARIES

Each neuron must have:
- Clear scope: What it tracks, stated positively
- Clear non-scope: What it explicitly leaves to others
- Unique questions: Questions that ONLY this neuron should answer

The boundary test: For any expected question, exactly one neuron should be the natural answerer. If multiple neurons would answer equally well, boundaries are unclear.

The data test: For any data point, it should be clear which neuron(s) find it relevant. If the same data updates multiple neurons in the same way, consider merging them.

PRINCIPLE 6: WRITE ACTIONABLE INSTRUCTIONS

Core directive: One clear sentence. Verb + what to understand + specific focus.
- Good: "Understand the user's error handling preferences and patterns"
- Bad: "Track coding stuff"

Watch conditions: Observable, specific triggers that warrant attention.
- Good: "Explicit statements rejecting or endorsing a practice"
- Bad: "Anything important about their style"

Questions to track: Concrete questions the neuron should be able to answer.
- Good: "Do they prefer exceptions or explicit error returns?"
- Bad: "What is their philosophy?"

PRINCIPLE 7: VALIDATE BEFORE FINALIZING

Coverage check: Do the neurons together cover the full intent of the prompt?

Overlap check: Is there significant redundancy where the same insight would appear in multiple neurons?

Routing clarity: For each type of question the user might ask, is there a clear "best" neuron to answer it?

Proportionality: Is the number of neurons proportional to the complexity of the domain? Over-decomposition wastes tokens; under-decomposition loses nuance.

For each neuron, provide:
- id: kebab-case identifier (e.g., "coding-style", "learning-interests")
- name: Human-readable display name
- description: Brief description for query routing (what questions this neuron answers)
- instructions: Full structured instructions following this format:

  [Core understanding directive - one clear sentence]

  Watch for:
  - [Specific observable condition 1]
  - [Specific observable condition 2]

  Track answers to:
  - [Concrete question 1]
  - [Concrete question 2]`

function buildTypeSection(descriptors: NeuronTypeDescriptor[]): string {
	const typeNames = descriptors.map((d) => `"${d.type}"`).join(' or ')
	const typeDescriptions = descriptors
		.map(
			(d) =>
				`  ${d.type.toUpperCase()} neurons (type: "${d.type}") — ${d.description}`,
		)
		.join('\n\n')

	return `
- type: ${typeNames}

${typeDescriptions}

  How to choose:
  - If the neuron builds understanding by synthesizing patterns across observations → text
  - If the neuron tracks a growing/changing set of distinct things → list
  - When in doubt, prefer text — it's more flexible`
}

/**
 * Build the neuron generation prompt fragment dynamically from descriptors.
 */
export function neuronGenerationFragment(
	descriptors: NeuronTypeDescriptor[],
): string {
	return principlesSection + buildTypeSection(descriptors)
}
