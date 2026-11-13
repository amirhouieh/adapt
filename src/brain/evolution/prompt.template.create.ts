/**
 * Template for evolution create action prompt.
 *
 * Simplified from the initial setup decomposition framework —
 * focuses on generating ONE well-scoped specialist.
 */

/**
 * Format create prompt with joined guidance and Brain context
 */
export function createPromptTemplate(
	guidance: string,
	purpose: string,
): string {
	return `You are adding a new specialist to a living knowledge network.

# Network Purpose
${purpose}

# What's Needed
${guidance}

# Instructions
Generate ONE specialist configuration that covers the domain described above.
A single broad specialist is better than multiple narrow ones — the network
can split it later when the specialist has enough knowledge to differentiate.

Provide:
- id: kebab-case identifier
- name: human-readable display name
- description: brief description for routing (what questions this specialist answers)
- instructions: structured instructions with a core directive, watch conditions, and questions to track`
}
