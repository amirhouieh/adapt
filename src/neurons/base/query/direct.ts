/**
 * DirectMethod — single-shot query method
 *
 * Dumps raw understanding into context, single LLM call, no tools.
 * Fast path: one call vs ToolBasedMethod's agentic loop.
 */

import { z } from 'zod'
import {
	type AdaptLLMPlugin,
	type AdaptStreamResult,
	generate,
	type LanguageModel,
	Output,
	streamText,
} from '../../../llm'
import type { TokenUsage } from '../../types'
import type {
	QueryContext,
	QueryMethod,
	QueryMethodUpdateConfig,
	QueryOptions,
	QueryResult,
} from './types'

const responseSchema = z.object({
	relevant: z
		.boolean()
		.describe('Is this query within your area of expertise?'),
	relevance: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How related is this query to your domain? 0 = outside scope, 1 = core',
		),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How well could you answer? 0 = nothing on this, 1 = fully answered',
		),
	response: z
		.string()
		.describe('Your answer — be specific, cite what you know'),
	gaps: z.array(z.string()).describe('What could not be answered'),
})

/**
 * What a reply is checked against: the same, but a missing `gaps` counts as
 * none. Small models (LFM3) sometimes leave it out. The model is still sent
 * `responseSchema`, where `gaps` is required (OpenAI strict mode needs that).
 */
const acceptedSchema = responseSchema.extend({
	gaps: z.array(z.string()).default([]),
})

export interface DirectConfig {
	/** Returns the neuron's raw understanding as a string */
	getUnderstanding: () => Promise<string>
	/** Builds the system prompt for the query */
	buildPrompt: (context: QueryContext, understanding: string) => string
}

export class DirectMethod implements QueryMethod {
	readonly name = 'direct'
	private llm: AdaptLLMPlugin
	private model: LanguageModel
	private config: DirectConfig

	constructor(llm: AdaptLLMPlugin, model: LanguageModel, config: DirectConfig) {
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
	): Promise<QueryResult> {
		const understanding = await this.config.getUnderstanding()
		const { model: modelOverride, ...generateOptions } = options ?? {}

		const system = this.config.buildPrompt(context, understanding)

		const result = await generate({
			llm: this.llm,
			model: modelOverride ?? this.model,
			system,
			prompt: context.question,
			output: Output.object({ schema: responseSchema }),
			repairSchema: acceptedSchema,
			...generateOptions,
		})

		const output = result.output as z.infer<typeof acceptedSchema>
		const usage: TokenUsage = {
			inputTokens: result.usage?.inputTokens ?? 0,
			outputTokens: result.usage?.outputTokens ?? 0,
			totalTokens: result.usage?.totalTokens ?? 0,
		}

		return {
			relevant: output.relevant,
			relevance: output.relevance,
			confidence: output.confidence,
			insight: output.response,
			gaps: output.gaps.join('\n'),
			usage,
		}
	}

	async queryStream(
		context: QueryContext,
		options?: QueryOptions,
	): Promise<AdaptStreamResult> {
		const understanding = await this.config.getUnderstanding()
		const { model: modelOverride, ...generateOptions } = options ?? {}
		const system = this.config.buildPrompt(context, understanding)

		return streamText({
			llm: this.llm,
			model: modelOverride ?? this.model,
			system,
			prompt: context.question,
			...generateOptions,
		})
	}
}
