import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { responseFormatCausalSupport as support } from '../evals/scripts/response-format-causal-eval'

const repositoryRoot = resolve(import.meta.dirname, '..')

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as unknown
}

describe('response-format causal replay transforms', () => {
	it('preserves the original default structured/plain arms', () => {
		const config = support.configSchema.parse(readJson('evals/config/qwen-response-format-causal.json'))
		const request = support.parseRequest(readJson(config.scenarios[0].sourceRequestPath))

		expect(config.repetitions).toBe(1)
		expect(support.transformRequest(request, support.defaultArms[0])).toEqual(request)
		expect(support.transformRequest(request, support.defaultArms[1])).toEqual(
			Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'response_format')),
		)
	})

	it('builds eight exact-message LFM requests without adding stream', () => {
		const config = support.configSchema.parse(readJson('evals/config/lfm-v1-sampling-causal.json'))
		const requests = config.scenarios.flatMap((scenario) => {
			const sourceText = readFileSync(resolve(repositoryRoot, scenario.sourceRequestPath), 'utf8')
			const source = support.parseRequest(JSON.parse(sourceText) as unknown)
			const recordedArm = (scenario.arms ?? support.defaultArms).find((arm) => arm.id === 'recorded-settings')
			if (recordedArm === undefined) throw new Error('recorded-settings arm is required')
			expect(source.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } })
			expect(JSON.stringify(support.transformRequest(source, recordedArm))).toBe(sourceText)
			return (scenario.arms ?? support.defaultArms).flatMap((arm) =>
				Array.from({ length: config.repetitions }, () => ({ source, arm, sent: support.transformRequest(source, arm) })),
			)
		})

		expect(requests).toHaveLength(8)
		for (const request of requests) {
			expect(request.sent.messages).toEqual(request.source.messages)
			expect(request.sent.response_format).toEqual(request.source.response_format)
			expect('stream' in request.sent).toBe(false)
		}
		expect(requests[2].sent).toMatchObject({ temperature: 0.2 })
		expect('seed' in requests[2].sent).toBe(false)
		expect('max_tokens' in requests[2].sent).toBe(false)
		expect('temperature' in requests[6].sent).toBe(false)
		expect('seed' in requests[6].sent).toBe(false)
		expect('max_tokens' in requests[6].sent).toBe(false)
	})
})
