/**
 * Evolution system exports
 */

export { EvolutionActionHandler } from './base-handler'
// Handlers
export { CreateHandler } from './handlers/create'
export { DeleteHandler } from './handlers/delete'
export { MergeHandler } from './handlers/merge'
export { SplitHandler } from './handlers/split'
export { UpdateHandler } from './handlers/update'
export { EvolutionOrchestrator } from './orchestrator'
export {
	activateEvolution,
	EvolutionActivationInterruption,
	initializeEvolutionRegistry,
	neuronStoreSnapshotDigest,
	pinEvolutionRegistry,
	pruneEvolutionStages,
	readNeuronStoreSnapshot,
	recoverEvolutionActivation,
} from './activation'
export {
	createEvolutionProposalProvider,
	evolutionProposalOutputSchema,
	proposeEvolution,
} from './proposal'
export {
	snapshotValidatedEvolutionProposal,
	validateEvolutionProposal,
} from './validation'

export type {
	EvolutionActivationInput,
	EvolutionActivationOptions,
	EvolutionActivationResult,
	EvolutionActivationStage,
	EvolutionAction,
	EvolutionCatalogue,
	EvolutionClock,
	EvolutionDeveloperConstraints,
	EvolutionEvidence,
	EvolutionLensDefinition,
	EvolutionPolicy,
	EvolutionProposal,
	EvolutionProposalInput,
	EvolutionProposalProvider,
	EvolutionProposalProviderResult,
	EvolutionProposalResult,
	EvolutionProposalRunOptions,
	EvolutionRecoveryStrategy,
	EvolutionRegressionCheck,
	EvolutionRegressionCheckInput,
	EvolutionRegressionCheckResult,
	EvolutionRunControl,
	EvolutionStageRetentionInput,
	EvolutionStageRetentionResult,
	EvolutionTargetState,
	EvolutionTransformation,
	EvolutionTransformationValidationInput,
	EvolutionTransformationValidator,
	EvolutionTrigger,
	EvolutionTriggerKind,
	EvolutionValidationIssue,
	EvolutionValidationIssueCode,
	EvolutionValidationResult,
	InitializeEvolutionRegistryInput,
	PinnedEvolutionRegistry,
	ValidatedEvolutionProposal,
} from './contracts'
export type { EvolutionProposalModelConfig } from './proposal'

// Types
export type {
	CreateActionResult,
	DeleteActionResult,
	EvolutionActionResult,
	EvolutionEventMap,
	MergeActionResult,
	SplitActionResult,
	UpdateActionResult,
} from './types'
