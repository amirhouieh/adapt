/**
 * Template for update action prompt
 *
 * Formats neuron data for LLM to generate config updates
 */

import type { Neuron } from '../../neurons'
import { stringifyUnderstanding } from './utils'

/**
 * Format update prompt with neuron data and guidance
 */
export async function updatePromptTemplate(
	guidance: string,
	neuron: Neuron,
	purpose: string,
): Promise<string> {
	const health = neuron.getHealth()
	const metrics = neuron.getMetrics()
	const understanding = stringifyUnderstanding(await neuron.getUnderstanding())

	const thresholds = neuron.getUnderstandThresholds()

	return `# Brain Context

**Purpose**: ${purpose}

# Adjustment Guidance

${guidance}

# Neuron to Adjust

**ID**: ${neuron.id}
**Name**: ${neuron.id}
**Description**: ${neuron.description || 'N/A'}

**Current Instructions**:
${neuron.instructions}

**Current Thresholds**:
- Min Importance: ${thresholds.minImportance}
- Max Observations: ${thresholds.maxObservations}

**Health**:
- Activation: ${health.activation.toFixed(2)}
- Status: ${health.status}
- Last Accessed: ${health.lastAccessed.toISOString()}

**Metrics**:
- Query Count: ${metrics.query.count}
- Dismissal Rate: ${(metrics.ingestion.dismissalRate * 100).toFixed(1)}%
- Syntheses: ${metrics.ingestion.synthesisCount}

**Current Understanding** (first 500 chars):
${understanding.slice(0, 500)}${understanding.length > 500 ? '...' : ''}

---

# Your Task

Based on the guidance, decompose the needed changes into two categories:

**Behavioral** (for adjust — incremental evolution):
- Changes to focus, scope, emphasis, reasoning approach
- Express as a natural language directive
- Empty string if no behavioral change needed

**Mechanical** (for update — specific field values):
- name: Change the neuron's name
- description: Update the description
- thresholds.minImportance: Adjust importance threshold (0-1)
- thresholds.maxObservations: Adjust buffer size (integer)
- Only include fields that need to change

Provide:
- mechanical: Object with only the fields that should change
- behavioral: Directive for incremental evolution (empty string if none)
- reasoning: Brief explanation of what changed and why (1-2 sentences)`
}
