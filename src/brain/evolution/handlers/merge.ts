/**
 * Merge action handler - combines multiple neurons into one
 *
 * Type-aware: validates all source neurons are same type,
 * uses descriptor's mergeUnderstandingSchema for LLM output.
 */

import { z } from 'zod'
import { generate, Output } from '../../../llm'
import type { BaseNeuron } from '../../../neurons/base/class'
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

				const neurons: BaseNeuron<unknown>[] = []
				for (const neuronId of decision.targets) {
					const neuron = this.brain.neurons.get(neuronId)
					if (!neuron) {
						throw new Error(`Neuron ${neuronId} not found`)
					}
					neurons.push(neuron)
				}

				// All source neurons must be the same type
				const neuronType = neurons[0].type
				if (!neurons.every((l) => l.type === neuronType)) {
					throw new Error(
						'Cross-type merge is not supported. All source neurons must be the same type.',
					)
				}

				// Get type descriptor for understanding schema
				const descriptor = this.brain.neuronTypes.get(neuronType)
				if (!descriptor) {
					throw new Error(`Unknown neuron type: ${neuronType}`)
				}

				// Build dynamic schema with type-specific understanding
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
					understanding: descriptor.mergeUnderstandingSchema,
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

				const completeConfig = createCompleteConfig({
					...config,
					type: neuronType as 'text',
				})
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
