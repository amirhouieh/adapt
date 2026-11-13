/**
 * Merge action handler - combines multiple neurons into one
 */

import { z } from 'zod'
import { generate, Output } from '../../../llm'
import type { Neuron } from '../../../neurons'
import type { EvolutionDecision } from '../../evaluator/types'
import { EvolutionActionHandler } from '../base-handler'
import { mergeSystemPrompt } from '../prompt.system.merge'
import { mergePromptTemplate } from '../prompt.template.merge'
import type { MergeActionResult } from '../types'
import { createCompleteConfig } from '../utils'

export class MergeHandler extends EvolutionActionHandler<MergeActionResult> {
	async execute(decisions: EvolutionDecision[]): Promise<MergeActionResult> {
		const allNewNeuronIds: string[] = []
		const allDeletedNeuronIds: string[] = []

		for (const decision of decisions) {
			this.emitActionStarted(decision)

			try {
				if (decision.targets.length < 2) {
					throw new Error('Merge requires at least 2 neurons')
				}

				const neurons: Neuron[] = []
				for (const neuronId of decision.targets) {
					const neuron = this.brain.neurons.get(neuronId)
					if (!neuron) {
						throw new Error(`Neuron ${neuronId} not found`)
					}
					neurons.push(neuron)
				}

				const mergeSchema = z.object({
					config: z.object({
						name: z.string().describe('Name for the merged neuron'),
						description: z
							.string()
							.describe('Description of the merged neuron purpose'),
						instructions: z
							.string()
							.describe(
								'Combined instructions defining scope and responsibilities',
							),
					}),
					understanding: z
						.string()
						.describe(
							'Merged understanding text combining knowledge from all source neurons',
						),
				})

				const result = await generate({
					llm: this.brain.llm,
					model: this.brain.config.model,
					system: mergeSystemPrompt,
					prompt: await mergePromptTemplate(
						decision.guidance,
						neurons,
						this.brain.promptContext?.purpose ?? this.brain.prompt,
					),
					output: Output.object({ schema: mergeSchema }),
					repairSchema: mergeSchema,
					...this.brain.llmRepairOptions,
				})

				const { config, understanding } = result.output

				const completeConfig = createCompleteConfig(config)
				const newNeuron =
					await this.brain.createNeuronFromConfig(completeConfig)

				await newNeuron.setUnderstanding(understanding)

				for (const neuronId of decision.targets) {
					await this.brain.__removeNeuron(neuronId)
				}

				allNewNeuronIds.push(newNeuron.id)
				allDeletedNeuronIds.push(...decision.targets)

				const actionResult: MergeActionResult = {
					newNeuronIds: [newNeuron.id],
					deletedNeuronIds: decision.targets,
				}

				this.emitActionExecuted(decision, actionResult)
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error))
				this.emitActionFailed(decision, err)
			}
		}

		return {
			newNeuronIds: allNewNeuronIds,
			deletedNeuronIds: allDeletedNeuronIds,
		}
	}
}
