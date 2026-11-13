/**
 * Template for split action prompt
 *
 * Formats neuron data for LLM to divide into focused neurons
 */

import type { Neuron } from '../../neurons'
import { stringifyUnderstanding } from './utils'

/**
 * Format split prompt with neuron data and guidance
 */
export async function splitPromptTemplate(
	guidance: string,
	neuron: Neuron,
	purpose: string,
): Promise<string> {
	const understanding = await neuron.getUnderstanding()

	return `# Brain Context

**Purpose**: ${purpose}

# Split Guidance

${guidance}

# Neuron to Split

**ID**: ${neuron.id}
**Description**: ${neuron.description || 'N/A'}

**Instructions**:
${neuron.instructions}

**Understanding**:
${stringifyUnderstanding(understanding)}

**Health**:
- Activation: ${neuron.getHealth().activation.toFixed(2)}
- Status: ${neuron.getHealth().status}
- Query Count: ${neuron.getMetrics().query.count}
- Dismissal Rate: ${(neuron.getMetrics().ingestion.dismissalRate * 100).toFixed(1)}%

---

# Your Task

Divide this neuron into 2 or more focused neurons that:
1. Each have a clear, narrow scope (more focused than the original)
2. Together cover the original neuron's domain
3. Have appropriate knowledge distribution (split the understanding logically)
4. Have distinct, non-overlapping instructions

For each new neuron, provide:
- name: Clear, descriptive name
- description: Brief purpose description
- instructions: Focused instructions defining scope
- understanding: Relevant portion of the original understanding

Output an array of 2 or more neuron configurations.`
}
