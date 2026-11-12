// Base

// Store (re-exported from stores/)
export type {
	EvolutionRecord,
	NeuronCollection,
	NeuronStore,
	ObservationRecord,
	StateRecord,
	UnderstandingRecord,
} from '../stores'
export { MemoryNeuronCollection, MemoryNeuronStore } from '../stores'
export type {
	AdjustResult,
	BaseNeuronState,
	BaseNeuronUpdateInput,
	BaseResolvedConfig,
	EventUsage,
	LearnCallbacks,
	LearnOptions,
	LearnOutput,
	LearnPreparation,
	ManagedLearnOutput,
	ModelSlots,
	SharedNeuronEventMap,
	StateTransform,
	StoredModelRef,
	UnderstandCallResult,
	UnderstandThresholds,
} from './base'
export { BaseNeuron } from './base'
export type { QueryOptions, QueryResult } from './base/query'
export { ToolBasedMethod } from './base/query'
export type {
	ListGovernanceConfig,
	ListItem,
	ListNeuronConfig,
	ListNeuronEvent,
	ListNeuronEventMap,
	ListNeuronUpdateResult,
	ListOperation,
	ResolvedListGovernanceConfig,
	ResolvedListNeuronConfig,
} from './list'
// ListNeuron
export { ListNeuron } from './list'
export { listNeuronDescriptor } from './list/descriptor'
// Schemas
export {
	type GeneratedNeuronConfig,
	neuronConfigSchema,
} from './schema.config'
export type {
	AdaptiveTextFlushOutput,
	AdaptiveTextLearningConfig,
	AdaptiveTextLearningRuntime,
	AdaptiveTextLearningState,
	AdaptiveTextLearnOutput,
	AdaptiveTextModelProfile,
	ResolvedGovernanceConfig,
	ResolvedTextNeuronConfig,
	TextGovernanceConfig,
	TextNeuronConfig,
	TextNeuronEvent,
	TextNeuronEventMap,
	TextNeuronUpdateResult,
} from './text'
// TextNeuron
export { protectedDeveloperInstructions, TextNeuron } from './text'
// Descriptors
export { textNeuronDescriptor } from './text/descriptor'
export type {
	GovernanceConfig,
	Strategy,
	StrategyContext,
	StrategyFn,
	StrategyResult,
} from './text/strategies'
export {
	applyStrategy,
	STRATEGIES,
	strategyFunctions,
	strategyPrompts,
} from './text/strategies'
export type {
	Neuron,
	NeuronHealth,
	NeuronMetadata,
	NeuronOrigin,
	NeuronStatus,
	NeuronTypeDescriptor,
	Significance,
	TokenUsage,
} from './types'
