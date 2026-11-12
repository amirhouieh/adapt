import type { MemoryType, VersionRef } from '../../learning'
import type {
	BrainEvolutionSourcePin,
	BrainMemoryMappingRecord,
	BrainRegistryLensRecord,
	BrainRegistryRevisionRecord,
	NeuronStoreSnapshot,
} from '../../stores'

export type EvolutionAction = 'create' | 'update' | 'merge' | 'split' | 'delete'
export type EvolutionTriggerKind =
	| 'uncovered-subject'
	| 'observed-conflict'
	| 'missing-operation'
	| 'query-failure'
	| 'explicit-change'

export interface EvolutionEvidence {
	id: string
	kind: string
	data: unknown
	created_at: string
}

export interface EvolutionTrigger {
	id: string
	kind: EvolutionTriggerKind
	description: string
	evidence_ids: string[]
}

export interface EvolutionSettings {
	[key: string]: string | number | boolean | null
}

export interface EvolutionDeveloperConstraints {
	instructions: string[]
	local_only: boolean
	provider_permissions: string[]
}

export interface EvolutionLensDefinition {
	id: string
	name: string
	description: string
	type: MemoryType
	memory_schema: VersionRef
	recipe: VersionRef
	recipe_composition: VersionRef[]
	dependencies: string[]
	settings: EvolutionSettings
	developer_constraints: EvolutionDeveloperConstraints
}

export interface EvolutionRecipeCatalogueEntry extends VersionRef {
	memory_types: MemoryType[]
	required_capabilities: string[]
}

export interface EvolutionCompositionCatalogueEntry {
	id: string
	recipes: VersionRef[]
	max_steps: number
}

export interface EvolutionTransformationCatalogueEntry extends VersionRef {
	source_schemas: VersionRef[]
	target_schemas: VersionRef[]
}

export interface EvolutionCatalogue {
	recipes: EvolutionRecipeCatalogueEntry[]
	compositions: EvolutionCompositionCatalogueEntry[]
	transformations: EvolutionTransformationCatalogueEntry[]
	memory_schemas: VersionRef[]
}

export interface EvolutionSettingBound {
	key: string
	kind: 'number' | 'integer' | 'boolean' | 'string'
	minimum?: number
	maximum?: number
	allowed_values?: Array<string | number | boolean>
}

export interface EvolutionPolicy {
	available_capabilities: string[]
	creation_constraints: EvolutionDeveloperConstraints
	setting_bounds: EvolutionSettingBound[]
	protected_lens_ids: string[]
	required_regression_checks: Record<EvolutionAction, string[]>
	max_evidence: number
	max_catalogue_entries: number
	max_lenses: number
	max_dependencies_per_lens: number
	max_recipe_steps: number
	max_prompt_chars: number
	max_evidence_chars: number
	max_catalogue_chars: number
	max_constraint_chars: number
	allowed_deletion_modes: Array<'lens-only' | 'lens-and-retained-knowledge'>
}

export interface EvolutionProposal {
	id: string
	action: EvolutionAction
	reasoning: string
	trigger_id: string
	evidence_ids: string[]
	expected_effect: string
	target_lens_ids: string[]
	resulting_lenses: EvolutionLensDefinition[]
	transformation?: VersionRef
	deletion_mode?: 'lens-only' | 'lens-and-retained-knowledge'
	regression_check_ids: string[]
	created_at: string
}

export interface EvolutionProposalInput {
	proposal_id: string
	trigger: EvolutionTrigger
	evidence: EvolutionEvidence[]
	registry: EvolutionLensDefinition[]
	catalogue: EvolutionCatalogue
	policy: EvolutionPolicy
	instructions: {
		system: string
		task: string
	}
}

export interface EvolutionProposalProviderResult {
	proposal: Omit<EvolutionProposal, 'id' | 'trigger_id' | 'created_at'>
	raw: unknown
}

export interface EvolutionProposalProvider {
	propose(
		input: EvolutionProposalInput,
		options: EvolutionProposalRunOptions,
	): Promise<EvolutionProposalProviderResult>
}

export interface EvolutionClock {
	now(): string
}

export interface EvolutionProposalRunOptions {
	clock: EvolutionClock
	signal?: AbortSignal
	max_output_tokens: number
}

export type EvolutionProposalResult =
	| { status: 'proposed'; proposal: EvolutionProposal; raw: unknown }
	| { status: 'failure'; error: unknown }

export interface EvolutionRegressionCheckInput {
	proposal: EvolutionProposal
	current_registry: EvolutionLensDefinition[]
}

export interface EvolutionRegressionCheckResult {
	id: string
	passed: boolean
	details?: unknown
}

export interface EvolutionRegressionCheck {
	id: string
	run(
		input: EvolutionRegressionCheckInput,
	): Promise<EvolutionRegressionCheckResult>
}

export type EvolutionValidationIssueCode =
	| 'invalid-action-shape'
	| 'missing-evidence'
	| 'protected-constraint'
	| 'unapproved-recipe'
	| 'unapproved-composition'
	| 'missing-capability'
	| 'budget-exceeded'
	| 'dependency-cycle'
	| 'incompatible-schema'
	| 'invalid-setting'
	| 'invalid-deletion-policy'
	| 'regression-check-failed'
	| 'missing-regression-check'

export interface EvolutionValidationIssue {
	code: EvolutionValidationIssueCode
	message: string
	lens_id?: string
}

export interface ValidatedEvolutionProposal {
	proposal: EvolutionProposal
	source_registry: EvolutionLensDefinition[]
	registry: EvolutionLensDefinition[]
	regression_checks: EvolutionRegressionCheckResult[]
}

export type EvolutionValidationResult =
	| { status: 'valid'; value: ValidatedEvolutionProposal }
	| {
			status: 'invalid'
			issues: EvolutionValidationIssue[]
			regression_checks: EvolutionRegressionCheckResult[]
	  }

export interface EvolutionTargetState {
	stage_id: string
	lens: BrainRegistryLensRecord
	snapshot: NeuronStoreSnapshot
}

export interface EvolutionTransformation {
	id: string
	proposal_id: string
	source_pins: BrainEvolutionSourcePin[]
	targets: EvolutionTargetState[]
	mappings: BrainMemoryMappingRecord[]
}

export interface EvolutionRunControl {
	/**
	 * Acquires and holds an exclusive mutation fence for every affected physical
	 * store. The integration must block learning/enqueue, retention/deletion,
	 * and outbox claim/settle until `resume` releases the fence. Read-only
	 * callers continue through a pinned registry revision.
	 */
	quiesce(lensIds: readonly string[]): Promise<void>
	/** Waits for mutations admitted before the fence to finish. */
	waitForIdle(lensIds: readonly string[]): Promise<void>
	/** Publishes the revision to resumed writers and releases the fence. */
	resume(lensIds: readonly string[], registryRevisionId: string): Promise<void>
}

export type EvolutionActivationStage =
	| 'journaled'
	| 'quiesced'
	| 'targets-written'
	| 'before-registry-cas'
	| 'after-registry-cas'
	| 'completed'

export interface EvolutionActivationOptions {
	onStage?(stage: EvolutionActivationStage): void | Promise<void>
	transformation_validator?: EvolutionTransformationValidator
}

export interface EvolutionTransformationValidationInput {
	proposal_id: string
	reference: VersionRef
	sources: Array<{
		lens_id: string
		state_digest: string
		snapshot: NeuronStoreSnapshot
	}>
	targets: Array<{
		lens_id: string
		state_digest: string
		snapshot: NeuronStoreSnapshot
	}>
	mappings: BrainMemoryMappingRecord[]
}

export interface EvolutionTransformationValidator {
	reference: VersionRef
	validate(input: EvolutionTransformationValidationInput): void | Promise<void>
}

export interface EvolutionActivationInput {
	activation_id: string
	mode: 'evolution' | 'rollback'
	validated_proposal: ValidatedEvolutionProposal
	base_registry_revision_id: string
	target_registry: BrainRegistryRevisionRecord
	transformation: EvolutionTransformation
	staging_policy: {
		max_targets: number
		max_snapshot_records: number
		max_snapshot_chars: number
	}
	created_at: string
	updated_at: string
}

export type EvolutionActivationResult =
	| {
			status: 'activated'
			registry_revision_id: string
			deduplicated: boolean
	  }
	| {
			status: 'conflict'
			reason: 'registry-revision' | 'source-revision' | 'activation-id-reused'
	  }
	| { status: 'failure'; error: string; registry_revision_id: string }
	| {
			status: 'recovery-required'
			activation_id: string
			registry_revision_id: string
			error: string
	  }

export interface InitializeEvolutionRegistryInput {
	head_revision_id: string
	revision: number
	lenses: BrainRegistryLensRecord[]
	created_at: string
}

export interface PinnedEvolutionRegistry {
	revision: BrainRegistryRevisionRecord
	getLens(lensId: string): BrainRegistryLensRecord | undefined
}

export type EvolutionRecoveryStrategy = 'complete' | 'abandon'

export interface EvolutionStageRetentionInput {
	max_terminal_stages: number
}

export interface EvolutionStageRetentionResult {
	deleted_stage_ids: string[]
}
