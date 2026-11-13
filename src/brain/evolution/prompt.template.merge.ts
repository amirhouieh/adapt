/**
 * Template for merge action prompt
 *
 * Formats neuron data for LLM to synthesize into a unified neuron
 */

import type { Neuron } from '../../neurons'
import { stringifyUnderstanding } from './utils'

/**
 * Format merge prompt with neuron data and guidance
 */
export async function mergePromptTemplate(
	guidance: string,
	neurons: Neuron[],
	purpose: string,
): Promise<string> {
	const neuronSections = await Promise.all(
		neurons.map(async (neuron, idx) => {
			const understanding = await neuron.getUnderstanding()
			return `## Neuron ${idx + 1}: ${neuron.id}

**Name**: ${neuron.id}
**Description**: ${neuron.description || 'N/A'}
**Instructions**:
${neuron.instructions}

**Understanding**:
${stringifyUnderstanding(understanding)}

---`
		}),
	)

	return `# Brain Context

**Purpose**: ${purpose}

# Merge Guidance

${guidance}

# Neurons to Merge

${neuronSections.join('\n\n')}

# Your Task

Synthesize these ${neurons.length} neurons into a single unified neuron that:
1. Combines their knowledge domains appropriately
2. Preserves important knowledge from all neurons
3. Has clear, focused instructions
4. Has a merged understanding that integrates all relevant knowledge

Output:
- config: Merged neuron configuration (name, description, instructions)
- understanding: Unified understanding text combining knowledge from all sources`
}
