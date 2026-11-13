/**
 * Root decomposition prompt template
 *
 * Reads a raw brain prompt and extracts neuron configurations (and future params).
 * Embeds the neuron generation fragment for the 7 principles playbook.
 */

import { neuronGenerationFragment } from './prompt.fragment.neuron-generation'

export const rootDecompositionPrompt = (brainPrompt: string) =>
	`You are a learning system architect. Your task is to decompose a user's prompt into a set of specialized neurons.

# User Prompt

${brainPrompt}

# Task 1: Generate Neuron Configurations

${neuronGenerationFragment}

Output the neuron configurations now.`
