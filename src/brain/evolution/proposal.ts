import { z } from 'zod'
import {
	generate,
	type AdaptLLMPlugin,
	type AdaptModelConfig,
	Output,
} from '../../llm'
import type {
	EvolutionProposal,
	EvolutionProposalInput,
	EvolutionProposalProvider,
	EvolutionProposalResult,
	EvolutionProposalRunOptions,
} from './contracts'

const versionRefSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
})
const settingValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
])
const lensSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	type: z.string().min(1),
	memory_schema: versionRefSchema,
	recipe: versionRefSchema,
	recipe_composition: z.array(versionRefSchema),
	dependencies: z.array(z.string().min(1)),
	settings: z.record(z.string(), settingValueSchema),
	developer_constraints: z.object({
		instructions: z.array(z.string()),
		local_only: z.boolean(),
		provider_permissions: z.array(z.string()),
	}),
})

export const evolutionProposalOutputSchema = z.object({
	action: z.enum(['create', 'update', 'merge', 'split', 'delete']),
	reasoning: z.string().min(1),
	evidence_ids: z.array(z.string().min(1)),
	expected_effect: z.string().min(1),
	target_lens_ids: z.array(z.string().min(1)),
	resulting_lenses: z.array(lensSchema),
	transformation: versionRefSchema.nullable(),
	deletion_mode: z
		.enum(['lens-only', 'lens-and-retained-knowledge'])
		.nullable(),
	regression_check_ids: z.array(z.string().min(1)),
})

export interface EvolutionProposalModelConfig {
	llm: AdaptLLMPlugin
	model: AdaptModelConfig
	plugin_options?: unknown
}

function finitePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive safe integer`)
	}
}

function portableLength(value: unknown): number {
	const serialized = JSON.stringify(value)
	if (serialized === undefined)
		throw new Error('proposal input must be portable data')
	return serialized.length
}

function enforceInputBounds(input: EvolutionProposalInput): void {
	const limits = [
		['max_evidence', input.policy.max_evidence],
		['max_catalogue_entries', input.policy.max_catalogue_entries],
		['max_lenses', input.policy.max_lenses],
		['max_dependencies_per_lens', input.policy.max_dependencies_per_lens],
		['max_recipe_steps', input.policy.max_recipe_steps],
		['max_prompt_chars', input.policy.max_prompt_chars],
		['max_evidence_chars', input.policy.max_evidence_chars],
		['max_catalogue_chars', input.policy.max_catalogue_chars],
		['max_constraint_chars', input.policy.max_constraint_chars],
	] as const
	for (const [name, value] of limits) finitePositiveInteger(value, name)
	if (input.evidence.length > input.policy.max_evidence) {
		throw new Error('evolution evidence exceeds the configured item limit')
	}
	const catalogueEntries =
		input.catalogue.recipes.length +
		input.catalogue.compositions.length +
		input.catalogue.transformations.length +
		input.catalogue.memory_schemas.length
	if (catalogueEntries > input.policy.max_catalogue_entries) {
		throw new Error('evolution catalogue exceeds the configured item limit')
	}
	if (input.registry.length > input.policy.max_lenses) {
		throw new Error('evolution registry exceeds the configured lens limit')
	}
	if (portableLength(input.evidence) > input.policy.max_evidence_chars) {
		throw new Error('evolution evidence exceeds the configured character limit')
	}
	if (portableLength(input.catalogue) > input.policy.max_catalogue_chars) {
		throw new Error(
			'evolution catalogue exceeds the configured character limit',
		)
	}
	const constraints = input.registry.map((lens) => lens.developer_constraints)
	if (portableLength(constraints) > input.policy.max_constraint_chars) {
		throw new Error(
			'developer constraints exceed the configured character limit',
		)
	}
	if (portableLength(input) > input.policy.max_prompt_chars) {
		throw new Error(
			'evolution proposal input exceeds the configured prompt limit',
		)
	}
}

export function createEvolutionProposalProvider(
	config: EvolutionProposalModelConfig,
): EvolutionProposalProvider {
	const llm = config.llm
	const model = structuredClone(config.model)
	const pluginOptions = structuredClone(config.plugin_options)
	return {
		async propose(input, options) {
			const result = await generate<
				z.infer<typeof evolutionProposalOutputSchema>
			>({
				llm,
				model,
				system: input.instructions.system,
				prompt: `${input.instructions.task}\n\n${JSON.stringify({
					trigger: input.trigger,
					evidence: input.evidence,
					registry: input.registry,
					catalogue: input.catalogue,
					policy: input.policy,
				})}`,
				output: Output.object({
					schema: evolutionProposalOutputSchema,
					name: 'bounded_evolution_proposal',
				}),
				repairSchema: evolutionProposalOutputSchema,
				maxOutputTokens: options.max_output_tokens,
				pluginOptions,
				abortSignal: options.signal,
			})
			const output = result.output
			return {
				proposal: {
					action: output.action,
					reasoning: output.reasoning,
					evidence_ids: output.evidence_ids,
					expected_effect: output.expected_effect,
					target_lens_ids: output.target_lens_ids,
					resulting_lenses: output.resulting_lenses,
					...(output.transformation === null
						? {}
						: { transformation: output.transformation }),
					...(output.deletion_mode === null
						? {}
						: { deletion_mode: output.deletion_mode }),
					regression_check_ids: output.regression_check_ids,
				},
				raw: result,
			}
		},
	}
}

export async function proposeEvolution(
	input: EvolutionProposalInput,
	provider: EvolutionProposalProvider,
	options: EvolutionProposalRunOptions,
): Promise<EvolutionProposalResult> {
	try {
		finitePositiveInteger(options.max_output_tokens, 'max_output_tokens')
		options.signal?.throwIfAborted()
		const snapshot = structuredClone(input)
		enforceInputBounds(snapshot)
		const generated = await provider.propose(snapshot, options)
		const proposal: EvolutionProposal = structuredClone({
			...generated.proposal,
			id: snapshot.proposal_id,
			trigger_id: snapshot.trigger.id,
			created_at: options.clock.now(),
		})
		return { status: 'proposed', proposal, raw: generated.raw }
	} catch (error) {
		return { status: 'failure', error }
	}
}
