/**
 * brain.inspect() — agentic read-only introspection
 *
 * An LLM agent with tools to browse neuron metadata, read understanding,
 * and consult internal neurons. Works whether the brain is fresh (configs only)
 * or mature (has accumulated knowledge).
 */

import { z } from 'zod'
import {
	type AdaptGenerateOptions,
	type AdaptLLMPlugin,
	generate,
	hasToolCall,
	type LanguageModel,
	stepCountIs,
	type Tool,
	tool,
} from '../llm'
import type { TokenUsage } from '../neurons/types'
import type { Brain } from './class'

const MAX_STEPS = 12

// ── Result ──────────────────────────────────────────────────────────────────

export interface InspectResult {
	insight: string
	usage: TokenUsage
}

// ── Tools ───────────────────────────────────────────────────────────────────

function createInspectTools(brain: Brain) {
	const listNeurons = tool({
		description:
			'List all neurons with their name, description, instructions, and health status.',
		inputSchema: z.object({}),
		execute: async () => {
			const neurons = brain.getNeurons()
			return neurons.map((l) => ({
				id: l.id,
				name: l.name,
				description: l.description,
				instructions: l.instructions,
				health: l.getHealth(),
			}))
		},
	})

	const inspectNeuron = tool({
		description:
			'Deep-inspect a specific neuron — its understanding summary, health, metrics, and evolution history.',
		inputSchema: z.object({
			id: z.string().describe('Neuron ID to inspect'),
		}),
		execute: async ({ id }) => {
			const neuron = brain.getNeuron(id)
			if (!neuron) {
				return { error: `Neuron "${id}" not found` }
			}

			const [summary, evolution, hasKnowledge] = await Promise.all([
				neuron.getSummary(),
				neuron.getEvolution(),
				neuron.hasKnowledge(),
			])
			const health = neuron.getHealth()
			const metrics = neuron.getMetrics()

			return {
				summary,
				hasKnowledge,
				health: {
					activation: health.activation,
					status: health.status,
					lastAccessed: health.lastAccessed,
				},
				metrics: {
					observationCount: metrics.ingestion.observationCount,
					dismissalCount: metrics.ingestion.dismissalCount,
					dismissalRate: metrics.ingestion.dismissalRate,
					synthesisCount: metrics.ingestion.synthesisCount,
					queryCount: metrics.query.count,
				},
				evolution,
			}
		},
	})

	const consultInternal = tool({
		description:
			"Query the brain's internal self-knowledge (global understanding, gaps, etc). Only useful when the brain has processed data.",
		inputSchema: z.object({
			question: z
				.string()
				.describe('What to ask the internal knowledge system'),
		}),
		execute: async ({ question }) => {
			const result = await brain.consult(question)
			if (!result.insight) {
				return { empty: true, message: 'No internal knowledge yet.' }
			}
			return { insight: result.insight, gaps: result.gaps }
		},
	})

	const getBrainConfig = tool({
		description:
			'Get the brain-level configuration: prompt, neuron count, evolution status.',
		inputSchema: z.object({}),
		execute: async () => {
			const config = brain.config
			return {
				prompt: config.prompt,
				neuronCount: brain.getNeurons().length,
				internalNeuronCount: brain.internalNeurons.size,
				evolution: {
					enabled: config.evolution.enabled,
				},
			}
		},
	})

	const answerSchema = z.object({
		response: z.string().describe('Your full answer to the question'),
	})

	const answer = tool({
		description: 'Deliver your final answer and signal completion.',
		inputSchema: answerSchema,
		execute: async (params) => params,
	})

	return { listNeurons, inspectNeuron, consultInternal, getBrainConfig, answer }
}

// ── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an inspector for a learning brain — a system made of specialized neurons that build understanding from data over time.

Your job is to answer questions about the brain's structure, what it tracks, what it knows, and its health. You have read-only access.

Strategy:
1. Start with listNeurons to see the landscape.
2. Use inspectNeuron for deeper looks at specific neurons.
3. Use consultInternal only when asking about accumulated knowledge (skip if the brain is fresh).
4. Use getBrainConfig for brain-level info.

Speak plainly and directly. When the brain is new and has no data yet, describe what it's *set up* to track based on neuron configs. When it has knowledge, describe what it actually knows.

Never reference tool names, internal IDs, or your reasoning process in your answer.`

// ── Entry point ─────────────────────────────────────────────────────────────

export async function inspect(
	llm: AdaptLLMPlugin,
	model: LanguageModel,
	brain: Brain,
	query: string,
	options?: AdaptGenerateOptions,
): Promise<InspectResult> {
	const tools = createInspectTools(brain)
	const { ...generateOptions } = options ?? {}

	const totalUsage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	}

	let answerResult: { response: string } | null = null

	const allTools: Record<string, Tool> = { ...tools }

	const result = await generate({
		llm,
		model,
		system: SYSTEM_PROMPT,
		prompt: query,
		tools: allTools,
		toolChoice: 'required',
		stopWhen: [hasToolCall('answer'), stepCountIs(MAX_STEPS)],
		onStepFinish: ({ usage, toolCalls }) => {
			if (usage?.inputTokens != null && usage?.outputTokens != null) {
				totalUsage.inputTokens += usage.inputTokens
				totalUsage.outputTokens += usage.outputTokens
				totalUsage.totalTokens += usage.totalTokens ?? 0
			}
			if (toolCalls) {
				for (const tc of toolCalls) {
					if (tc.toolName === 'answer') {
						answerResult = tc.input as { response: string }
					}
				}
			}
		},
		...generateOptions,
	})

	// Check final step
	for (const tc of result.toolCalls) {
		if (tc.toolName === 'answer' && 'input' in tc) {
			answerResult = tc.input as { response: string }
		}
	}

	return {
		insight: answerResult?.response || '',
		usage: totalUsage,
	}
}
