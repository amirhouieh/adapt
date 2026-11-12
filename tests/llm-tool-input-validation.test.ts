import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { type AdaptLLMPlugin, type AdaptModelConfig, generate, stepCountIs, tool } from '../src/llm'

const model = { plugin: 'test', id: 'test-model' } satisfies AdaptModelConfig<'test'>

function scriptedPlugin(inputs: unknown[]): AdaptLLMPlugin {
	let step = 0
	return {
		id: 'test',
		model: { toConfig: () => model },
		async call() {
			const input = inputs[step]
			step += 1
			if (input === undefined) return { text: 'done', json: undefined, toolCalls: [], finishReason: 'stop' }
			return {
				text: '',
				json: undefined,
				toolCalls: [{ type: 'tool-call', toolCallId: `call-${step}`, toolName: 'updateItem', input }],
				finishReason: 'tool-calls',
			}
		},
	}
}

describe('tool input validation', () => {
	it('rejects malformed tool input with an error result and passes parsed input to execute', async () => {
		const received: unknown[] = []
		const updateItem = tool({
			description: 'Update an item.',
			inputSchema: z.object({ id: z.string(), data: z.object({ value: z.string() }).strict() }),
			execute: async (input: unknown) => {
				received.push(input)
				return { success: true }
			},
		})
		const result = await generate({
			llm: scriptedPlugin([
				{ id: 'a', data: '{"value":"spread me"}' },
				{ id: 'a', data: { value: 'ok' } },
			]),
			model,
			prompt: 'Update.',
			tools: { updateItem },
			stopWhen: stepCountIs(4),
		})
		expect(received).toEqual([{ id: 'a', data: { value: 'ok' } }])
		const outputs = result.steps.flatMap((step) => step.toolResults.map((toolResult) => toolResult.output))
		expect(outputs[0]).toMatchObject({ success: false })
		expect(String((outputs[0] as { error: string }).error)).toContain('Invalid tool input')
		expect(outputs[1]).toEqual({ success: true })
	})
})
