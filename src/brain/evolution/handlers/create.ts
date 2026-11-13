/**
 * Create action handler - generates new neurons from guidance
 */

import { generate, Output } from '../../../llm'
import type { EvolutionDecision } from '../../evaluator/types'
import { neuronConfigsSchema } from '../../schemas/schema.neuron-configs'
import { EvolutionActionHandler } from '../base-handler'
import { createPromptTemplate } from '../prompt.template.create'
import type { CreateActionResult } from '../types'

/**
 * Handler for 'create' evolution action
 *
 * Joins guidance from all create decisions into a single LLM call,
 * then creates neurons from the generated configs.
 */
export class CreateHandler extends EvolutionActionHandler<CreateActionResult> {
	async execute(decisions: EvolutionDecision[]): Promise<CreateActionResult> {
		for (const decision of decisions) {
			this.emitActionStarted(decision)
		}

		try {
			const guidance = decisions.map((d) => d.guidance).join('\n')

			const result = await generate({
				llm: this.brain.llm,
				model: this.brain.config.model,
				prompt: createPromptTemplate(
					guidance,
					this.brain.promptContext?.purpose ?? this.brain.prompt,
				),
				output: Output.object({ schema: neuronConfigsSchema }),
				repairSchema: neuronConfigsSchema,
				...this.brain.llmRepairOptions,
			})

			const newNeuronIds: string[] = []
			for (const config of result.output.neurons) {
				const neuron = await this.brain.createNeuronFromConfig(config)
				newNeuronIds.push(neuron.id)
			}

			const actionResult: CreateActionResult = { newNeuronIds }

			for (const decision of decisions) {
				this.emitActionExecuted(decision, actionResult)
			}

			return actionResult
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error))
			for (const decision of decisions) {
				this.emitActionFailed(decision, err)
			}
			return { newNeuronIds: [] }
		}
	}
}
