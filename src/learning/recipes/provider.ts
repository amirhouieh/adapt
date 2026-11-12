import { generate, Output } from '../../llm'
import type {
	DevicePriority,
	LocalLLM,
	LocalModelConfig,
} from '../../llm/local/index'
import type { LearningModelCapability } from './types'

export interface LocalLearningModelConfig {
	readonly llm: LocalLLM
	readonly model: LocalModelConfig
	readonly priority: DevicePriority
}

export function createLocalLearningModel(
	config: LocalLearningModelConfig,
): LearningModelCapability {
	const llm = config.llm
	const model = Object.freeze({
		...config.model,
		...(config.model.options === undefined
			? {}
			: { options: Object.freeze({ ...config.model.options }) }),
	})
	const priority = config.priority
	return {
		async generate(request) {
			const result = await generate({
				llm,
				model,
				system: request.system,
				prompt: request.prompt,
				output: Output.object({ schema: request.schema }),
				repairSchema: request.schema,
				abortSignal: request.signal,
				pluginOptions: { priority, stage: 'generation' },
			})
			return { value: result.output, raw: result.raw, usage: result.usage }
		},
		async generateText(request) {
			const result = await generate({
				llm,
				model,
				system: request.system,
				prompt: request.prompt,
				abortSignal: request.signal,
				pluginOptions: { priority, stage: 'generation' },
			})
			if (result.finishReason !== 'stop') {
				throw new Error(
					`plain-text generation did not complete with stop: ${result.finishReason}`,
					{ cause: result },
				)
			}
			return {
				value: result.text,
				raw: result.raw,
				usage: result.usage,
				finishReason: result.finishReason,
			}
		},
		async decide(request) {
			const result = await llm.decisions.decide(
				{
					state: request.state,
					question: request.question,
					answers: request.answers,
					...(request.instructions === undefined
						? {}
						: { instructions: request.instructions }),
				},
				{ model, priority, signal: request.signal },
			)
			if (result.status === 'abstained') {
				return {
					status: result.status,
					raw: result,
					...(result.usage === undefined ? {} : { usage: result.usage }),
					...(result.probability === undefined ? {} : { probability: result.probability }),
				}
			}
			return {
				status: result.status,
				answer: result.answer,
				raw: result,
				...(result.usage === undefined ? {} : { usage: result.usage }),
				...(result.probability === undefined ? {} : { probability: result.probability }),
			}
		},
	}
}
