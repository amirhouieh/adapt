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
	LearnOptions,
	LearnOutput,
	ManagedLearnOutput,
	ModelSlots,
	SharedNeuronEventMap,
	StateTransform,
	StoredModelRef,
	UnderstandThresholds,
} from './base'
export { BaseNeuron } from './base'
export type { QueryOptions, QueryResult } from './base/query'
export { ToolBasedMethod } from './base/query'
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
export type { GovernanceConfig, Strategy } from './text/strategies'
export { STRATEGIES } from './text/strategies'
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
