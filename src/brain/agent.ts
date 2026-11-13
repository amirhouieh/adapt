import { z } from 'zod'
import type { AdaptStreamResult } from '../llm'
import {
	type AdaptGenerateOptions,
	type AdaptLLMPlugin,
	generate,
	type LanguageModel,
	Output,
	stepCountIs,
	streamText,
	type Tool,
	tool,
} from '../llm'
import type { TokenUsage } from '../neurons/types'
import { buildSynthesisSystemPrompt } from './prompts/prompt.synthesis.system'
import type { BrainAskResult } from './types'

/**
 * A specialist the synthesis agent can query
 */
export interface SpecialistDef {
	id: string
	name: string
	description: string
	query: (
		question: string,
		options?: AdaptGenerateOptions,
	) => Promise<{
		relevant: boolean
		relevance: number
		confidence: number
		insight: string
		gaps: string
	}>
}

/**
 * Options for synthesis
 */
export interface SynthesisOptions extends AdaptGenerateOptions {
	synthesisDirective?: string
	query: string
	specialists: SpecialistDef[]
	/** Optional consult tools for querying internal neurons during synthesis */
	consultTools?: Record<string, Tool>
}

/**
 * Result from synthesis
 */
export interface SynthesisResult {
	insight: string
	gaps: string[]
	sources: BrainAskResult['sources']
	usage: TokenUsage
}

/**
 * Hard upper bound on phase-1 (gathering) loop. The model is expected to
 * stop calling tools well before this — it's a safety cap, not the primary
 * termination signal. With toolChoice: 'auto' and no answer tool, the loop
 * ends naturally when the model produces text instead of a tool call.
 */
const MAX_SYNTHESIS_STEPS = 12

/**
 * Hard cap on total tool calls across the gathering loop. Backstop for
 * misbehaving models that loop on tool calls without ever stopping.
 */
const MAX_TOTAL_TOOL_CALLS = 15

/**
 * Disables per-step parallel tool calls at the model level. Without this,
 * weak models emit hundreds of tool calls in a single output, burning huge
 * output tokens before the SDK can intervene. These are documented standard
 * provider options:
 *
 * - OpenAI:    providerOptions.openai.parallelToolCalls    (default true)
 * - Anthropic: providerOptions.anthropic.disableParallelToolUse  (default false)
 * - Google:    no equivalent option exposed by ai-sdk
 *
 * Foreign blocks are ignored by each provider, so passing both is safe.
 */
const SYNTHESIS_PROVIDER_OPTIONS = {
	openai: { parallelToolCalls: false },
	anthropic: { disableParallelToolUse: true },
}

/**
 * Custom stop condition: terminate the loop once aggregate tool calls
 * across all steps cross MAX_TOTAL_TOOL_CALLS. Documented standard pattern
 * — see ai-sdk loop-control docs.
 */
const totalToolCallsExceeded = ({
	steps,
}: {
	steps: Array<{ toolCalls?: Array<unknown> }>
}): boolean => {
	const total = steps.reduce(
		(count, step) => count + (step.toolCalls?.length ?? 0),
		0,
	)
	return total >= MAX_TOTAL_TOOL_CALLS
}

/**
 * Tracked specialist query result (for source building)
 */
interface SpecialistQueryRecord {
	id: string
	relevance: number
	confidence: number
	insight: string
}

/**
 * Tracked consult-tool call output (for forwarding to phase 2)
 */
interface ConsultRecord {
	tool: string
	question: string
	output: string
}

/**
 * Build the gathering-phase tool set.
 *
 * Wraps consultTools so their outputs are captured into `consultResults`
 * and forwarded to phase 2 as `globalUnderstanding`. Specialist queries
 * are tracked in `queriedSpecialists` (with (id, question) dedup to refuse
 * exact repeats).
 */
function buildGatheringTools(args: {
	specialists: SpecialistDef[]
	consultTools: Record<string, Tool> | undefined
	generateOptions: AdaptGenerateOptions
	queriedSpecialists: SpecialistQueryRecord[]
	consultResults: ConsultRecord[]
	askedKeys: Set<string>
}): Record<string, Tool> {
	const {
		specialists,
		consultTools,
		generateOptions,
		queriedSpecialists,
		consultResults,
		askedKeys,
	} = args

	const specialistMenu = specialists
		.map((s) => `- ${s.id}: ${s.description || s.name}`)
		.join('\n')
	const specialistIds = new Set(specialists.map((s) => s.id))
	const specialistMap = new Map(specialists.map((s) => [s.id, s]))

	const querySpecialist = tool({
		description: `Query a specialist. Each sees one dimension of the knowledge.\n\n${specialistMenu}`,
		inputSchema: z.object({
			id: z.string().describe('Specialist ID to query'),
			question: z.string().describe('What to ask this specialist'),
		}),
		execute: async ({ id, question }) => {
			if (!specialistIds.has(id)) {
				return {
					error: `Unknown specialist: ${id}. Available: ${[...specialistIds].join(', ')}`,
				}
			}
			const key = `${id}|${question.trim().toLowerCase()}`
			if (askedKeys.has(key)) {
				return {
					error: `Already asked "${id}" this exact question. Ask a sharper follow-up or query a different specialist.`,
				}
			}
			askedKeys.add(key)
			const specialist = specialistMap.get(id)
			if (!specialist) {
				return {
					error: `Unknown specialist: ${id}. Available: ${[...specialistIds].join(', ')}`,
				}
			}
			const result = await specialist.query(question, generateOptions)
			if (result.relevant) {
				queriedSpecialists.push({
					id,
					relevance: result.relevance,
					confidence: result.confidence,
					insight: result.insight,
				})
			}
			return {
				relevant: result.relevant,
				insight: result.insight,
				gaps: result.gaps || undefined,
			}
		},
	})

	// Wrap each consult tool so its output is captured for phase 2.
	const wrappedConsultTools: Record<string, Tool> = {}
	if (consultTools) {
		for (const [name, originalTool] of Object.entries(consultTools)) {
			const inputSchema = (originalTool as { inputSchema: z.ZodTypeAny })
				.inputSchema
			const description =
				(originalTool as { description?: string }).description ?? ''
			const originalExecute = (
				originalTool as {
					execute?: (input: unknown, opts: unknown) => Promise<unknown>
				}
			).execute

			wrappedConsultTools[name] = tool({
				description,
				inputSchema,
				execute: async (input, opts) => {
					const out = originalExecute
						? await originalExecute(input, opts)
						: null
					consultResults.push({
						tool: name,
						question: String((input as { question?: string }).question ?? ''),
						output: typeof out === 'string' ? out : JSON.stringify(out),
					})
					return out
				},
			})
		}
	}

	return {
		querySpecialist,
		...wrappedConsultTools,
	}
}

/**
 * Format consult-tool results into a `globalUnderstanding` string for phase 2.
 */
function formatConsultResults(results: ConsultRecord[]): string | undefined {
	if (results.length === 0) return undefined
	return results
		.map((r) => `### ${r.tool} (asked: "${r.question}")\n${r.output}`)
		.join('\n\n')
}

/**
 * Synthesize an answer using a two-phase pattern:
 *
 *   Phase 1 (gather): agent loop with `querySpecialist` + wrapped consult
 *   tools. toolChoice: 'auto' lets the model stop calling tools when it
 *   has enough; loop ends when the model produces plain text instead of
 *   a tool call. No `answer` tool, no Output.object — these strict-schema
 *   completion paths trigger Gemini's known tool-call loop bug (Google
 *   acknowledged: "endless loop behavior with Gemini 2.5 Flash is a known
 *   edge case when strict JSON schemas interact with function calling").
 *
 *   Phase 2 (synthesize): single LLM call via synthesizeDirect. No tools
 *   active, structured output via Output.object. Receives gathered
 *   specialist results + consult-tool outputs.
 *
 * The agent's adaptive specialist selection is preserved — model picks
 * which specialists to query based on prior responses. What's removed is
 * the trigger pattern (multiple strict-schema tools + required tool
 * choice + answer tool) that causes Gemini Flash to loop.
 */
export async function synthesize(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
	options: SynthesisOptions,
): Promise<SynthesisResult> {
	const {
		synthesisDirective,
		query,
		specialists,
		consultTools,
		...generateOptions
	} = options

	const queriedSpecialists: SpecialistQueryRecord[] = []
	const consultResults: ConsultRecord[] = []
	const askedKeys = new Set<string>()

	const tools = buildGatheringTools({
		specialists,
		consultTools,
		generateOptions,
		queriedSpecialists,
		consultResults,
		askedKeys,
	})

	const hasConsultTools = consultTools && Object.keys(consultTools).length > 0
	const system = buildSynthesisSystemPrompt(hasConsultTools, synthesisDirective)

	const phase1Usage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	}
	let stepNum = 0

	console.log(`[synthesis] phase 1: gather`)
	console.log(
		`[synthesis] specialists: ${specialists.map((s) => s.id).join(', ')}`,
	)
	const t0 = Date.now()

	await generate({
		llm,
		model,
		system,
		prompt: query,
		tools,
		toolChoice: 'auto',
		providerOptions: SYNTHESIS_PROVIDER_OPTIONS,
		stopWhen: [stepCountIs(MAX_SYNTHESIS_STEPS), totalToolCallsExceeded],
		onStepFinish: ({ text, usage, toolCalls }) => {
			stepNum++
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
			if (usage?.inputTokens != null && usage?.outputTokens != null) {
				phase1Usage.inputTokens += usage.inputTokens
				phase1Usage.outputTokens += usage.outputTokens
				phase1Usage.totalTokens += usage.totalTokens ?? 0
			}
			if (text) {
				console.log(
					`[synthesis] step ${stepNum} (${elapsed}s) reasoning: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
				)
			}
			if (toolCalls) {
				for (const tc of toolCalls) {
					console.log(
						`[synthesis] step ${stepNum} (${elapsed}s) tool: ${tc.toolName}${tc.toolName === 'querySpecialist' ? ` → ${(tc.input as { id: string }).id}: "${(tc.input as { question: string }).question.slice(0, 100)}"` : ''}`,
					)
				}
			}
		},
		...generateOptions,
	})

	console.log(
		`[synthesis] phase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${stepNum} steps, ${queriedSpecialists.length} specialists, ${phase1Usage.totalTokens} tokens`,
	)

	const phase2 = await synthesizeDirect(llm, model, {
		...generateOptions,
		synthesisDirective,
		query,
		specialistResults: queriedSpecialists.map((r) => ({
			id: r.id,
			relevance: r.relevance,
			confidence: r.confidence,
			insight: r.insight,
			gaps: '',
		})),
		globalUnderstanding: formatConsultResults(consultResults),
	})

	return {
		insight: phase2.insight,
		gaps: phase2.gaps,
		sources: queriedSpecialists.map((r) => ({
			neuronId: r.id,
			relevance: r.relevance,
			confidence: r.confidence,
			insight: r.insight,
		})),
		usage: {
			inputTokens: phase1Usage.inputTokens + phase2.usage.inputTokens,
			outputTokens: phase1Usage.outputTokens + phase2.usage.outputTokens,
			totalTokens: phase1Usage.totalTokens + phase2.usage.totalTokens,
		},
	}
}

// ── Direct synthesis (shallow mode) ─────────────────────────────────────────

/**
 * Options for direct synthesis
 */
export interface DirectSynthesisOptions extends AdaptGenerateOptions {
	synthesisDirective?: string
	query: string
	/** Pre-queried specialist results (already resolved) */
	specialistResults: Array<{
		id: string
		relevance: number
		confidence: number
		insight: string
		gaps: string
	}>
	/** Global understanding text (from internal neurons) */
	globalUnderstanding?: string
}

const directAnswerSchema = z.object({
	response: z.string().describe('Your full answer to the question'),
	gaps: z
		.array(z.string())
		.describe('Knowledge gaps that could not be answered'),
})

/**
 * What a reply is checked against: a missing `gaps` counts as none. Small
 * models sometimes leave it out. The model is still sent `directAnswerSchema`,
 * where `gaps` is required (OpenAI strict mode needs that).
 */
const acceptedAnswerSchema = directAnswerSchema.extend({
	gaps: z.array(z.string()).default([]),
})

/**
 * Single-shot synthesis — all specialist results already collected.
 * One LLM call, no tools, no agentic loop.
 */
export async function synthesizeDirect(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
	options: DirectSynthesisOptions,
): Promise<SynthesisResult> {
	const {
		synthesisDirective,
		query,
		specialistResults,
		globalUnderstanding,
		...generateOptions
	} = options

	const t0 = Date.now()

	// Build context from pre-queried specialists
	const relevant = specialistResults.filter((s) => s.relevance > 0.1)
	console.log(`[synthesis:direct] query: "${query.slice(0, 80)}"`)
	console.log(
		`[synthesis:direct] ${relevant.length}/${specialistResults.length} relevant specialists`,
	)

	const specialistSections = relevant
		.map(
			(s) =>
				`## ${s.id} (relevance: ${s.relevance}, confidence: ${s.confidence})\n${s.insight}${s.gaps ? `\n\nGaps: ${s.gaps}` : ''}`,
		)
		.join('\n\n')

	const globalSection = globalUnderstanding
		? `\n\n## Global Context\n${globalUnderstanding}`
		: ''

	const directiveSection = synthesisDirective ? `\n\n${synthesisDirective}` : ''

	const system = `You have specialist knowledge below. Synthesize an answer.

Speak from the evidence. If a specialist says "3 times in January," say that — don't smooth it into "frequently." Where specialists conflict, show both sides. Where they're silent, say so.

Never reference your internal structure, sources, confidence scores, or how you arrived at the answer.${directiveSection}

# Specialist Knowledge

${specialistSections}${globalSection}`

	const result = await generate({
		llm,
		model,
		system,
		prompt: query,
		output: Output.object({ schema: directAnswerSchema }),
		repairSchema: acceptedAnswerSchema,
		...generateOptions,
	})

	const output = result.output as z.infer<typeof acceptedAnswerSchema>
	const usage: TokenUsage = {
		inputTokens: result.usage?.inputTokens ?? 0,
		outputTokens: result.usage?.outputTokens ?? 0,
		totalTokens: result.usage?.totalTokens ?? 0,
	}

	console.log(
		`[synthesis:direct] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${usage.totalTokens} tokens`,
	)

	return {
		insight: output.response,
		gaps: output.gaps,
		sources: relevant.map((s) => ({
			neuronId: s.id,
			relevance: s.relevance,
			confidence: s.confidence,
			insight: s.insight,
		})),
		usage,
	}
}

// ── Streaming synthesis (deep mode) ─────────────────────────────────────

/**
 * Stream a deep synthesis. Same two-phase pattern as synthesize():
 * phase 1 gathers specialists (await), phase 2 streams the synthesized
 * answer text. Consumers reading textStream get the final answer; the
 * gathering phase is internal.
 */
export async function synthesizeStream(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
	options: SynthesisOptions,
): Promise<AdaptStreamResult> {
	const {
		synthesisDirective,
		query,
		specialists,
		consultTools,
		...generateOptions
	} = options

	const queriedSpecialists: SpecialistQueryRecord[] = []
	const consultResults: ConsultRecord[] = []
	const askedKeys = new Set<string>()

	const tools = buildGatheringTools({
		specialists,
		consultTools,
		generateOptions,
		queriedSpecialists,
		consultResults,
		askedKeys,
	})

	const hasConsultTools = consultTools && Object.keys(consultTools).length > 0
	const system = buildSynthesisSystemPrompt(hasConsultTools, synthesisDirective)

	console.log(`[synthesis:stream] phase 1: gather`)

	await generate({
		llm,
		model,
		system,
		prompt: query,
		tools,
		toolChoice: 'auto',
		providerOptions: SYNTHESIS_PROVIDER_OPTIONS,
		stopWhen: [stepCountIs(MAX_SYNTHESIS_STEPS), totalToolCallsExceeded],
		...generateOptions,
	})

	console.log(
		`[synthesis:stream] phase 1 done — ${queriedSpecialists.length} specialists`,
	)

	return synthesizeDirectStream(llm, model, {
		...generateOptions,
		synthesisDirective,
		query,
		specialistResults: queriedSpecialists.map((r) => ({
			id: r.id,
			relevance: r.relevance,
			confidence: r.confidence,
			insight: r.insight,
			gaps: '',
		})),
		globalUnderstanding: formatConsultResults(consultResults),
	})
}

// ── Streaming synthesis (direct/shallow mode) ───────────────────────────

/**
 * Stream a single-shot synthesis — all specialist results already collected.
 * Plain text output (no structured JSON) so textStream gives the consumer raw answer text.
 */
export async function synthesizeDirectStream(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
	options: DirectSynthesisOptions,
): Promise<AdaptStreamResult> {
	const {
		synthesisDirective,
		query,
		specialistResults,
		globalUnderstanding,
		...generateOptions
	} = options

	const relevant = specialistResults.filter((s) => s.relevance > 0.1)

	const specialistSections = relevant
		.map(
			(s) =>
				`## ${s.id} (relevance: ${s.relevance}, confidence: ${s.confidence})\n${s.insight}${s.gaps ? `\n\nGaps: ${s.gaps}` : ''}`,
		)
		.join('\n\n')

	const globalSection = globalUnderstanding
		? `\n\n## Global Context\n${globalUnderstanding}`
		: ''

	const directiveSection = synthesisDirective ? `\n\n${synthesisDirective}` : ''

	const system = `You have specialist knowledge below. Synthesize an answer.

Speak from the evidence. If a specialist says "3 times in January," say that — don't smooth it into "frequently." Where specialists conflict, show both sides. Where they're silent, say so.

Never reference your internal structure, sources, confidence scores, or how you arrived at the answer.${directiveSection}

# Specialist Knowledge

${specialistSections}${globalSection}`

	return streamText({
		llm,
		model,
		system,
		prompt: query,
		...generateOptions,
	})
}
