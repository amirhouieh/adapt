/**
 * Eval: ai-sdk × OpenAI × every Adapt structured-output schema
 *
 * Strip everything down to one ai-sdk call against OpenAI per schema.
 * Each schema is copied verbatim from its source location in src/, then
 * adjusted by the suspected fix (.optional() → .nullable()). We do NOT
 * mutate src/.
 *
 * The question this answers: with the .nullable() fix applied, does
 * every Adapt structured-output schema pass OpenAI strict structured
 * output validation?
 *
 * Run:
 *   export $(cat .env.local | xargs) && npx tsx evals/scripts/openai-schema-probe-eval.ts
 */

import { createOpenAI } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
	console.log('OPENAI_API_KEY not set.')
	process.exit(0)
}

const openai = createOpenAI({ apiKey })
const model = openai('gpt-4o-mini')

// ─── Inline copies of every Adapt schema, with .optional() → .nullable() ────

// src/neurons/schema.config.ts — neuronConfigSchema (FIX: focus .optional → .nullable)
const neuronConfigSchema = z.object({
	id: z.string().describe('Unique identifier for this neuron (kebab-case)'),
	name: z.string().describe('Human-readable display name'),
	description: z.string().describe('Brief description of what this neuron tracks'),
	instructions: z.string().describe('Full structured instructions'),
	focus: z.string().nullable().describe('Optional focus areas (null if none)'),
	type: z.enum(['text']).describe('Neuron type'),
})

// src/brain/schemas/schema.brain-decomposition.ts
const brainDecompositionSchema = z.object({
	neurons: z.array(neuronConfigSchema).describe('Generated neuron configurations'),
})

// src/brain/schemas/schema.neuron-configs.ts
const neuronConfigsSchema = z.object({
	neurons: z.array(neuronConfigSchema).describe('Generated neuron configurations'),
})

// src/brain/prompts/prompt.decompose-brain-prompt.ts — already uses .nullable()
const promptContextSchema = z.object({
	purpose: z.string().describe('1-2 sentence summary'),
	evolutionGuidance: z.string().nullable().describe('How specialists should be organized'),
	synthesisDirective: z.string().nullable().describe('How to present answers'),
})

// src/brain/evolution/schemas/split.ts
const splitOutputSchema = z.object({
	neurons: z
		.array(
			z.object({
				name: z.string().describe('Name for the split neuron'),
				description: z.string().describe('Description of this split neuron purpose'),
				instructions: z.string().describe('Focused instructions'),
				understanding: z.string().describe('Understanding text for this split neuron'),
			}),
		)
		.min(2)
		.describe('Array of 2 or more focused neurons'),
})

// src/brain/evolution/schemas/merge.ts
const mergeOutputSchema = z.object({
	config: z.object({
		name: z.string().describe('Name for the merged neuron'),
		description: z.string().describe('Description'),
		instructions: z.string().describe('Combined instructions'),
	}),
	understanding: z.string().describe('Merged understanding text'),
})

// src/brain/evolution/schemas/update.ts (FIX: all .optional → .nullable)
const updateOutputSchema = z.object({
	mechanical: z
		.object({
			name: z.string().nullable().describe('Updated name (null if unchanged)'),
			description: z.string().nullable().describe('Updated description (null if unchanged)'),
			thresholds: z
				.object({
					minImportance: z.number().min(0).max(1).nullable(),
					maxObservations: z.number().int().min(1).nullable(),
				})
				.nullable()
				.describe('Updated synthesis thresholds (null if unchanged)'),
		})
		.describe('Mechanical config changes'),
	behavioral: z.string().describe('Directive for behavioral evolution'),
	reasoning: z.string().describe('Explanation of what changed'),
})

// src/brain/evaluator/schema.ts
const evolutionDecisionsSchema = z.object({
	decisions: z
		.array(
			z.object({
				action: z
					.enum(['create', 'merge', 'split', 'update', 'delete'])
					.describe('The evolution action'),
				reasoning: z.string().describe('Why this decision is needed'),
				guidance: z.string().describe('Natural language guidance for the action handler'),
				targets: z.array(z.string()).describe('Affected neuron IDs'),
			}),
		)
		.describe('Array of 0 to N evolution decisions'),
})

// src/neurons/observer/schema.identity.ts (FIX: domain .optional → .nullable)
const observeIdentitySchema = z.object({
	identity: z.string().describe('Plain text identity'),
	domain: z.string().nullable().describe('Subject area, null if cross-domain'),
})

// src/neurons/observer/index.ts (extends observeIdentitySchema)
const adjustObserveOutputSchema = observeIdentitySchema.extend({
	instructions: z.string().describe('Updated instructions'),
})

// src/neurons/observer/schema.output.ts — observeOutputSchema (all required)
const observeOutputSchema = z.object({
	status: z.enum(['observed', 'dismissed']).describe('observed or dismissed'),
	output: z.array(z.string()).describe('Array of discrete observations'),
	importance: z.number().min(0).max(1).describe('Importance 0..1'),
	gaps: z.array(z.string()).describe('Topics encountered but not relevant'),
})

// Inline duplicate from compare.compareSkillEnum / dynamics.dynamicsSkillEnum
const compareSkillEnum = z.enum([
	'similarity',
	'contrast',
	'pattern',
	'classification',
	'composition',
])
const dynamicsSkillEnum = z.enum([
	'evolution',
	'frequency',
	'velocity',
	'anomaly',
	'trajectory',
])

// src/neurons/text/understand/schema.identity.ts
const understandIdentityTextSchema = z.object({
	identity: z.string().describe('Plain text identity'),
	skills: z
		.array(
			z.object({
				skill: compareSkillEnum.describe('Skill from compare set'),
				description: z.string().describe('Skill description'),
			}),
		)
		.describe('Compare skills'),
	dynamicsSkills: z
		.array(
			z.object({
				skill: dynamicsSkillEnum.describe('Skill from dynamics set'),
				description: z.string().describe('Skill description'),
			}),
		)
		.describe('Dynamics skills'),
})

// src/neurons/text/understand/schema.output.ts
const understandOutputSchema = z.object({
	status: z.enum(['synthesized', 'dismissed']),
	newUnderstanding: z.string().describe('Updated understanding or empty'),
	significance: z.enum(['routine', 'notable', 'critical']),
	evolution: z.string().describe('What changed'),
	reasoning: z.string().describe('Reasoning'),
	output: z.string().describe('Why nothing changed'),
})

// src/brain/agent.ts — directAnswerSchema (no optional)
const directAnswerSchema = z.object({
	response: z.string().describe('Your full answer to the question'),
	gaps: z.array(z.string()).describe('Knowledge gaps'),
})

// src/brain/class.ts — selectionSchema (no optional)
const selectionSchema = z.object({
	ids: z.array(z.string()).describe('IDs of relevant neurons'),
})

// src/neurons/base/query/direct.ts — responseSchema (no optional)
const responseSchema = z.object({
	relevant: z.boolean().describe('Is this query within your area?'),
	relevance: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	response: z.string().describe('Your answer'),
	gaps: z.array(z.string()).describe('What could not be answered'),
})

// src/neurons/text/_tools/dismiss/schema.ts
const dismissParams = z.object({
	reason: z.string().describe('Why the data is irrelevant'),
})

// src/neurons/text/_tools/synthesize/schema.ts
const synthesizeParams = z.object({
	understanding: z.string().describe('Updated understanding'),
	evolution: z.string().describe('What changed'),
	significance: z.enum(['routine', 'notable', 'critical']),
})

// src/brain/agent.ts — querySpecialist input
const querySpecialistInput = z.object({
	id: z.string().describe('Specialist ID to query'),
	question: z.string().describe('What to ask this specialist'),
})

// src/neurons/text/understand/index.ts — adjustUnderstandingContent tools
const searchUnderstandingInput = z.object({
	query: z.string().describe('Text or pattern to search for'),
})
const replaceSectionInput = z.object({
	oldText: z.string().describe('Exact text to find and replace'),
	newText: z.string().describe('Replacement text'),
})
const removeSectionInput = z.object({
	text: z.string().describe('Exact text to remove'),
})
const insertSectionInput = z.object({
	position: z.enum(['before', 'after']),
	anchor: z.string().describe('Anchor text'),
	newText: z.string().describe('Text to insert'),
})
// FIX: reasoning .optional → .nullable
const completeAdjustInput = z.object({
	evolution: z.string().describe('What changed and why'),
	significance: z.enum(['routine', 'notable', 'critical']),
	reasoning: z.string().nullable().describe('Key reasoning, null if none'),
})

// ─── Cases ──────────────────────────────────────────────────────────────────

const cases: Array<{
	name: string
	schema: z.ZodSchema
	prompt: string
	strictJsonSchema?: false
}> = [
	{
		name: 'neuronConfigSchema',
		schema: neuronConfigSchema,
		prompt: 'Produce one neuron config for tracking coding decisions.',
	},
	{
		name: 'brainDecompositionSchema',
		schema: brainDecompositionSchema,
		prompt: 'Decompose this prompt: "Track engineering decisions". Produce 2-3 neurons.',
	},
	{
		name: 'neuronConfigsSchema',
		schema: neuronConfigsSchema,
		prompt: 'Produce 2 neuron configs for tracking engineering decisions.',
	},
	{
		name: 'promptContextSchema',
		schema: promptContextSchema,
		prompt: 'Analyze the brain prompt "Track engineering decisions". Fill purpose; null for the others if unclear.',
	},
	{
		name: 'splitOutputSchema',
		schema: splitOutputSchema,
		prompt: 'Split the "engineering" neuron into 2 focused neurons (tooling, architecture).',
	},
	{
		name: 'mergeOutputSchema',
		schema: mergeOutputSchema,
		prompt: 'Merge two neurons (tooling-decisions, architecture-decisions) into one combined neuron.',
	},
	{
		name: 'updateOutputSchema',
		schema: updateOutputSchema,
		prompt: 'Update the "tooling" neuron: rename to "developer-tooling". Other fields null.',
	},
	{
		name: 'evolutionDecisionsSchema',
		schema: evolutionDecisionsSchema,
		prompt: 'Decide one evolution action: create a new neuron for "ci-cd-decisions".',
	},
	{
		name: 'observeIdentitySchema',
		schema: observeIdentitySchema,
		prompt: 'Generate an observer identity for tracking coding decisions.',
	},
	{
		name: 'adjustObserveOutputSchema',
		schema: adjustObserveOutputSchema,
		prompt: 'Adjust observer: update instructions to focus on tooling only.',
	},
	{
		name: 'observeOutputSchema',
		schema: observeOutputSchema,
		prompt: 'Observe this fact: "We picked better-sqlite3". Status observed.',
	},
	{
		name: 'understandIdentityTextSchema',
		schema: understandIdentityTextSchema,
		prompt: 'Generate synthesizer identity for tracking coding decisions, with skills.',
	},
	{
		name: 'understandOutputSchema',
		schema: understandOutputSchema,
		prompt: 'Synthesize: status=synthesized, produce new understanding text.',
	},
	{
		name: 'directAnswerSchema',
		schema: directAnswerSchema,
		prompt: 'Answer: "What is 2+2?". List any gaps.',
	},
	{
		name: 'selectionSchema',
		schema: selectionSchema,
		prompt: 'Pick relevant neuron ids for query "tooling": from [tooling, ci, runtime].',
	},
	{
		name: 'responseSchema',
		schema: responseSchema,
		prompt: 'Specialist answers "What is the SQLite choice?" — relevant=true, give answer.',
	},
	{
		name: 'dismissParams',
		schema: dismissParams,
		prompt: 'Dismiss: reason="not relevant to coding".',
	},
	{
		name: 'synthesizeParams',
		schema: synthesizeParams,
		prompt: 'Synthesize: provide updated understanding text + evolution + significance routine.',
	},
	{
		name: 'querySpecialistInput',
		schema: querySpecialistInput,
		prompt: 'Build a query: id="tooling", question="What is the SQLite choice?".',
	},
	{
		name: 'searchUnderstandingInput',
		schema: searchUnderstandingInput,
		prompt: 'Build a search: query="biome".',
	},
	{
		name: 'replaceSectionInput',
		schema: replaceSectionInput,
		prompt: 'Build replace: oldText="x", newText="y".',
	},
	{
		name: 'removeSectionInput',
		schema: removeSectionInput,
		prompt: 'Build remove: text="some passage".',
	},
	{
		name: 'insertSectionInput',
		schema: insertSectionInput,
		prompt: 'Build insert: position=after, anchor="x", newText="y".',
	},
	{
		name: 'completeAdjustInput',
		schema: completeAdjustInput,
		prompt: 'Complete: evolution="renamed neuron", significance=routine, reasoning=null.',
	},
	// ── isolate the z.record problem ─────────────────────────────────────────
	{
		name: 'record(string, unknown)',
		schema: z.object({
			data: z.record(z.string(), z.unknown()),
		}),
		prompt: 'Produce data with two keys.',
	},
	{
		name: 'record(string, string)',
		schema: z.object({
			data: z.record(z.string(), z.string()),
		}),
		prompt: 'Produce data with two string-valued keys.',
	},
	{
		name: 'record(string, number)',
		schema: z.object({
			data: z.record(z.string(), z.number()),
		}),
		prompt: 'Produce data with two number-valued keys.',
	},
	{
		name: 'fixed object with unknown values (no record)',
		schema: z.object({
			a: z.unknown(),
			b: z.unknown(),
		}),
		prompt: 'Produce two arbitrary values for a and b.',
	},
	// ── retry the failing shapes with strictJsonSchema: false ────────────────
	{
		name: 'record(string, unknown) WITH strictJsonSchema:false',
		schema: z.object({
			data: z.record(z.string(), z.unknown()),
		}),
		prompt: 'Produce data with two keys.',
		strictJsonSchema: false,
	},
	{
		name: 'record(string, string) WITH strictJsonSchema:false',
		schema: z.object({
			data: z.record(z.string(), z.string()),
		}),
		prompt: 'Produce data with two string-valued keys.',
		strictJsonSchema: false,
	},
	{
		name: 'object with unknown values WITH strictJsonSchema:false',
		schema: z.object({
			a: z.unknown(),
			b: z.unknown(),
		}),
		prompt: 'Produce two arbitrary values for a and b.',
		strictJsonSchema: false,
	},
]

async function main() {
	console.log('Eval: ai-sdk × OpenAI × every Adapt schema (with .nullable() fix)')
	console.log(`Model: gpt-4o-mini`)
	console.log(`Cases: ${cases.length}`)
	console.log(`Time: ${new Date().toISOString()}`)

	const summary: Array<{ name: string; status: 'pass' | 'fail'; detail?: string }> = []

	for (const c of cases) {
		console.log(`\n${'━'.repeat(72)}`)
		console.log(c.name)
		console.log('─'.repeat(72))
		try {
			const { object } = await generateObject({
				model,
				schema: c.schema,
				prompt: c.prompt,
				...(c.strictJsonSchema === false
					? { providerOptions: { openai: { strictJsonSchema: false } } }
					: {}),
			})
			console.log('  RESULT:')
			console.log(JSON.stringify(object, null, 2).slice(0, 600))
			summary.push({ name: c.name, status: 'pass' })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			console.log('  ERROR:')
			console.log(msg.slice(0, 800))
			summary.push({ name: c.name, status: 'fail', detail: msg.slice(0, 200) })
		}
	}

	console.log(`\n${'═'.repeat(72)}`)
	console.log('Summary')
	console.log('═'.repeat(72))
	for (const s of summary) {
		const tag = s.status === 'pass' ? '✓ pass' : '✗ FAIL'
		console.log(`  ${tag.padEnd(8)} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`)
	}
	const passes = summary.filter((s) => s.status === 'pass').length
	const fails = summary.filter((s) => s.status === 'fail').length
	console.log(`\n${passes}/${cases.length} passed, ${fails} failed`)
}

main().catch((err) => {
	console.error('Eval crashed:', err)
})
