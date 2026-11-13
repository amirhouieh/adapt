/**
 * Template for the Evaluator's evaluation prompt.
 *
 * Presents context (specialists + signals). No tools section, no task section —
 * the system prompt's root question and AI SDK tool schemas handle that.
 */

import type { EvaluationContext, Signal } from './types'

/**
 * Format the evaluation prompt with signals and context.
 */
export function evaluationPromptTemplate(
	context: EvaluationContext,
	signals: Signal[],
): string {
	const sections: string[] = []

	// 1. Context: Network overview and specialist state
	const contextLine = context.brain.evolutionContext
		? `\n${context.brain.evolutionContext}\n`
		: ''

	sections.push(
		`# Context
${contextLine}
**Active Specialists**: ${context.brain.neuronCount}
**Dismissed Data Waiting**: ${context.dismissedBatchCount} batches

## Specialists

${context.neurons
	.map(
		(l) => `### ${l.id}
- **Name**: ${l.name}
- **Instructions**: ${l.instructions}
- **Observations**: ${l.metrics.observationCount}, **Syntheses**: ${l.metrics.synthesisCount}
- **Dismissal Rate**: ${(l.metrics.dismissalRate * 100).toFixed(0)}%, **Queries**: ${l.metrics.queryCount}
- **Activation**: ${l.health.activation.toFixed(2)} (${l.health.status})`,
	)
	.join('\n\n')}`.trim(),
	)

	// 2. Signals
	sections.push(`# Signals (${signals.length})

${signals
	.map(
		(s, idx) => `## Signal ${idx + 1}
- **Source**: ${s.source}
- **Description**: ${s.description}`,
	)
	.join('\n\n')}`)

	return sections.join('\n\n')
}
