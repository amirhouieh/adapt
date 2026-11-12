/**
 * Split action handler - divides one neuron into multiple focused neurons
 *
 * Type-aware: preserves source neuron type in split results,
 * uses descriptor's splitUnderstandingSchema for LLM output.
 */

import { z } from 'zod'
import { generate, Output } from '../../../llm'
import type { EvolutionDecision } from '../../evaluator/types'
import { EvolutionActionHandler } from '../base-handler'
import { splitSystemPrompt } from '../prompt.system.split'
import { splitPromptTemplate } from '../prompt.template.split'
import type { SplitActionResult } from '../types'
import { createCompleteConfig } from '../utils'

export class SplitHandler extends EvolutionActionHandler<SplitActionResult> {
	async execute(decisions: EvolutionDecision[]): Promise<SplitActionResult> {
		const allNewNeuronIds: string[] = []
		const allDeletedNeuronIds: string[] = []

		for (const decision of decisions) {
			this.emitActionStarted(decision)

			try {
				if (decision.targets.length !== 1) {
					throw new Error('Split requires exactly 1 neuron')
				}

				const neuronId = decision.targets[0]
				const neuron = this.brain.neurons.get(neuronId)

				if (!neuron) {
					throw new Error(`Neuron ${neuronId} not found`)
				}

				// Get type descriptor for understanding schema
				const neuronType = neuron.type
				const descriptor = this.brain.neuronTypes.get(neuronType)
				if (!descriptor) {
					throw new Error(`Unknown neuron type: ${neuronType}`)
				}

				// Build dynamic schema with type-specific understanding
				const splitSchema = z.object({
					neurons: z
						.array(
							z.object({
								name: z.string().describe('Name for the split neuron'),
								description: z
									.string()
									.describe('Description of this split neuron purpose'),
								instructions: z
									.string()
									.describe(
										'Focused instructions defining scope and responsibilities',
									),
								understanding: descriptor.splitUnderstandingSchema,
							}),
						)
						.min(2)
						.describe('Array of 2 or more focused neurons'),
				})

				const result = await generate({
					llm: this.brain.llm,
					model: this.brain.config.model,
					system: splitSystemPrompt,
					prompt: await splitPromptTemplate(
						decision.guidance,
						neuron,
						this.brain.promptContext?.purpose ?? this.brain.prompt,
					),
					output: Output.object({ schema: splitSchema }),
					repairSchema: splitSchema,
					...this.brain.llmRepairOptions,
				})

				const { neurons: splitConfigs } = result.output

				const newNeuronIds: string[] = []

				for (const config of splitConfigs) {
					const completeConfig = createCompleteConfig({
						name: config.name,
						description: config.description,
						instructions: config.instructions,
						type: neuronType as 'text',
					})
					const newNeuron =
						await this.brain.createNeuronFromConfig(completeConfig)

					await newNeuron.setUnderstanding(config.understanding)

					newNeuronIds.push(newNeuron.id)
				}

				await this.brain.__removeNeuron(neuronId)

				allNewNeuronIds.push(...newNeuronIds)
				allDeletedNeuronIds.push(neuronId)

				const actionResult: SplitActionResult = {
					newNeuronIds,
					deletedNeuronIds: [neuronId],
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
