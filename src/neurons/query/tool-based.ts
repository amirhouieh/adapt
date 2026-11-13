/**
 * ToolBasedMethod — generic tool-based query method
 *
 * Accepts neuron-provided understanding-access tools + a prompt builder.
 * Cognitive tools (generateResponse, identifyGaps, complete) are built-in.
 */

import { z } from 'zod'
import {
	type AdaptLLMPlugin,
	type AdaptStreamResult,
	generate,
	type LanguageModel,
	stepCountIs,
	streamText,
	type Tool,
	tool,
} from '../../llm'
import type { TokenUsage } from '../types'
import type {
	QueryCallbacks,
	QueryContext,
	QueryMethod,
	QueryMethodUpdateConfig,
	QueryOptions,
	QueryResult,
} from './types'

const MAX_STEPS = 10

// ── Cognitive tools (built-in) ─────────────────────────────────────────────

const completeSchema = z.object({
	relevant: z
		.boolean()
		.describe('Is this query within your area of expertise/purpose?'),
	relevance: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How related is this query to your domain/purpose? 0.0 = completely outside your scope, 1.0 = core to what you do',
		),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How well could you answer from your understanding? 0.0 = you have nothing on this topic, 1.0 = you fully answered. If outside your scope, this should be 0.0',
		),
	gaps: z.array(z.string()).describe('What could not be answered'),
})

type CompleteParams = z.infer<typeof completeSchema>

const cognitiveTools = {
	generateResponse: tool({
		description:
			'Formulate an answer based on your understanding. Be specific, cite what you know, express appropriate confidence, acknowledge uncertainty.',
		inputSchema: z.object({
			response: z.string().describe('The generated response to the query'),
			relevance: z
				.number()
				.min(0)
				.max(1)
				.describe('How related is this query to your domain/purpose?'),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.describe('How well could you answer from your understanding?'),
		}),
		execute: async (params) => params,
	}),
	identifyGaps: tool({
		description:
			'Note what you could not answer — missing data, conflicting signals, or queries outside your purpose. Gaps guide future learning.',
		inputSchema: z.object({
			gaps: z
				.array(z.string())
				.describe('List of things that could not be answered'),
		}),
		execute: async (params) => params,
	}),
	complete: tool({
		description:
			'Finalize the query. Call this AFTER generateResponse. Provides metadata only — the response you already generated is your answer.',
		inputSchema: completeSchema,
		// No execute — done tool
	}),
} as const

// ── ToolBasedMethod ────────────────────────────────────────────────────────

export interface ToolBasedConfig {
	/** Neuron-specific understanding-access tools */
	// biome-ignore lint/suspicious/noExplicitAny: Query tools preserve schema-derived callback parameter types.
	tools: Record<string, Tool<any, any>>
	/** Builds the system prompt for the query (neuron-specific) */
	buildPrompt: (context: QueryContext) => string
}

export class ToolBasedMethod implements QueryMethod {
	readonly name = 'tool-based'
	private llm: AdaptLLMPlugin
	private model: LanguageModel
	private config: ToolBasedConfig

	constructor(
		llm: AdaptLLMPlugin,
		model: LanguageModel,
		config: ToolBasedConfig,
	) {
		this.llm = llm
		this.model = model
		this.config = config
	}

	update(config: QueryMethodUpdateConfig): void {
		if (config.model !== undefined) {
			this.model = config.model
		}
		if (config.llm !== undefined) {
			this.llm = config.llm
		}
	}

	async query(
		context: QueryContext,
		options?: QueryOptions,
		callbacks?: QueryCallbacks,
	): Promise<QueryResult> {
		const totalUsage: TokenUsage = {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		}

		let completeResult: CompleteParams | null = null
		let lastResponse: string | null = null

		const handleStep = ({
			usage,
			text,
			toolCalls,
		}: {
			usage?: {
				inputTokens?: number
				outputTokens?: number
				totalTokens?: number
			}
			text?: string
			toolCalls?: Array<{ toolName: string; input?: unknown }>
		}) => {
			if (usage?.inputTokens != null && usage?.outputTokens != null) {
				totalUsage.inputTokens += usage.inputTokens
				totalUsage.outputTokens += usage.outputTokens
				totalUsage.totalTokens += usage.totalTokens ?? 0
			}

			if (text && callbacks?.onThinking) {
				callbacks.onThinking([text], {
					inputTokens: usage?.inputTokens ?? 0,
					outputTokens: usage?.outputTokens ?? 0,
					totalTokens: usage?.totalTokens ?? 0,
				})
			}

			if (toolCalls) {
				for (const tc of toolCalls) {
					if (tc.toolName === 'generateResponse') {
						const input = tc.input as { response: string }
						lastResponse = input.response
					}
					if (tc.toolName === 'complete') {
						completeResult = tc.input as CompleteParams
					}
				}
			}
		}

		const system = this.config.buildPrompt(context)
		const allTools = { ...this.config.tools, ...cognitiveTools }
		const { model: modelOverride, ...generateOptions } = options ?? {}

		const result = await generate({
			llm: this.llm,
			model: modelOverride ?? this.model,
			system,
			prompt: 'Answer the query based on your understanding.',
			tools: allTools,
			toolChoice: 'required',
			stopWhen: stepCountIs(MAX_STEPS),
			onStepFinish: handleStep,
			...generateOptions,
		})

		// Check final step for tool calls
		for (const tc of result.toolCalls) {
			if (tc.toolName === 'generateResponse' && 'input' in tc) {
				const input = tc.input as { response: string }
				lastResponse = input.response
			}
			if (tc.toolName === 'complete' && 'input' in tc) {
				completeResult = tc.input as CompleteParams
			}
		}

		if (completeResult) {
			return {
				relevant: completeResult.relevant,
				relevance: completeResult.relevance,
				confidence: completeResult.confidence,
				insight: lastResponse || '',
				gaps: (completeResult.gaps || []).join('\n'),
				usage: totalUsage,
			}
		}

		// Fallback if no complete tool was called
		return {
			relevant: false,
			relevance: 0,
			confidence: 0,
			insight: 'Unable to generate response',
			gaps: 'Query processing did not complete',
			usage: totalUsage,
		}
	}

	async queryStream(
		context: QueryContext,
		options?: QueryOptions,
	): Promise<AdaptStreamResult> {
		const system = this.config.buildPrompt(context)
		const allTools = { ...this.config.tools, ...cognitiveTools }
		const { model: modelOverride, ...generateOptions } = options ?? {}

		return streamText({
			llm: this.llm,
			model: modelOverride ?? this.model,
			system,
			prompt: 'Answer the query based on your understanding.',
			tools: allTools,
			toolChoice: 'required',
			stopWhen: stepCountIs(MAX_STEPS),
			...generateOptions,
		})
	}
}
