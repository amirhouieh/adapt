/**
 * Prompt template + schema for decomposing a brain prompt into reusable context.
 *
 * Single LLM call extracts purpose and synthesis directive.
 * Result persisted in state — regenerated only when brain prompt changes.
 */

import { z } from 'zod'

export const promptContextSchema = z.object({
	purpose: z
		.string()
		.describe(
			'1-2 sentence summary of what this network is about — domain, data, questions it answers',
		),
	synthesisDirective: z
		.string()
		.nullable()
		.describe(
			'How to present answers — tone, audience, what to emphasize or flag. Null if the prompt has no such instructions.',
		),
})

export type PromptContext = z.infer<typeof promptContextSchema>

/**
 * Build the prompt that extracts PromptContext from a raw brain prompt.
 */
export function decomposeBrainPromptTemplate(brainPrompt: string): string {
	return `You are analyzing a user-authored prompt for a living knowledge network. The network is made of specialists — each one tracks and synthesizes knowledge about a specific domain.

Below is the brain prompt — the user's identity and purpose statement for this network. It may contain instructions about tone, response style, specialist definitions, context, identity, or anything else.

---
${brainPrompt}
---

Extract two things:

1. **purpose**: In 1-2 sentences, what is this network about? What domain, what kind of data, what kind of questions does it answer? Always present.

2. **synthesisDirective**: Does the prompt contain instructions about how to present answers — tone, audience, what to emphasize or flag, what perspective to take? If yes, write a concise directive. If nothing relevant, return null.

Mirror the user's framing — don't invent concepts they didn't express.`
}
