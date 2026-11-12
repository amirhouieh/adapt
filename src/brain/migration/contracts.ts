import type { EvolutionLensDefinition } from '../evolution/contracts'
import type {
	BrainEvolutionRecord,
	BrainNeuronRecord,
	BrainStateRecord,
	BrainStore,
	DismissedBatchRecord,
	EvolutionRecord,
	NeuronStore,
	NeuronStoreSnapshot,
	ObservationRecord,
	StateRecord,
	UnderstandingRecord,
} from '../../stores'

export type LegacyV006StoreKind = 'memory' | 'sqlite-node' | 'sqlite-bun'

export interface LegacyV006UnderstandingRecord
	extends Omit<UnderstandingRecord, 'metadata_confidence_provenance'> {
	metadata_confidence: number
}

export interface LegacyV006NeuronSnapshot {
	state: StateRecord[]
	observations: ObservationRecord[]
	understanding: LegacyV006UnderstandingRecord[]
	evolution: EvolutionRecord[]
}

export interface LegacyV006BrainLensSnapshot {
	record: BrainNeuronRecord
	internal: boolean
	store: LegacyV006NeuronSnapshot
}

export interface LegacyV006BrainSnapshot {
	state: BrainStateRecord[]
	neurons: BrainNeuronRecord[]
	internalNeurons: BrainNeuronRecord[]
	evolution: BrainEvolutionRecord[]
	dismissedBatches: DismissedBatchRecord[]
	lenses: LegacyV006BrainLensSnapshot[]
}

export interface LegacyV006Source<TSnapshot> {
	readonly sourceId: string
	readonly storeKind: LegacyV006StoreKind
	readonly declaredVersion: string
	/** Caller guarantees the v0.0.6 source remains offline/exclusive. */
	read(): Promise<TSnapshot>
}

export type LegacyV006NeuronSource = LegacyV006Source<LegacyV006NeuronSnapshot> & {
	readonly kind: 'neuron'
	readonly lensId: string
	readonly lensType: string
}

export type LegacyV006BrainSource = LegacyV006Source<LegacyV006BrainSnapshot> & {
	readonly kind: 'brain'
}

export type LegacyV006MigrationSource =
	| LegacyV006NeuronSource
	| LegacyV006BrainSource

export interface LegacyV006Collection<T extends { id: string }> {
	list(filter?: Record<string, unknown>): Promise<T[]>
}

export interface LegacyV006NeuronStoreReader {
	state: LegacyV006Collection<StateRecord>
	observations: LegacyV006Collection<ObservationRecord>
	understanding: LegacyV006Collection<LegacyV006UnderstandingRecord>
	evolution: LegacyV006Collection<EvolutionRecord>
}

export interface LegacyV006BrainStoreReader {
	state: LegacyV006Collection<BrainStateRecord>
	neurons: LegacyV006Collection<BrainNeuronRecord>
	internalNeurons: LegacyV006Collection<BrainNeuronRecord>
	evolution: LegacyV006Collection<BrainEvolutionRecord>
	dismissedBatches: LegacyV006Collection<DismissedBatchRecord>
	getNeuronStore(neuronId: string): LegacyV006NeuronStoreReader
}

export interface LegacyMigrationRuntimeCompatibility {
	validateModelReference(input: {
		lensId?: string
		slot: string
		reference: unknown
	}): string | undefined
	validateSchema(input: {
		lensId: string
		lensType: string
		kind: 'observation' | 'understanding'
		schema: unknown
	}): string | undefined
	buildLens(input: {
		record: BrainNeuronRecord
		state: readonly StateRecord[]
	}): Promise<EvolutionLensDefinition> | EvolutionLensDefinition
	hasRecipe(input: {
		reference: EvolutionLensDefinition['recipe']
		memoryType: EvolutionLensDefinition['type']
	}): boolean
}

export interface LegacyMigrationBounds {
	maxLenses: number
	maxBrainRecords: number
	maxBrainChars: number
	maxRecordsPerLens: number
	maxSnapshotChars: number
	maxDismissedBatches: number
}

export interface LegacyMigrationIds {
	migrationId: string
	journalStateId: string
	targetRegistryRevisionId?: string
	targetRegistryRevision?: number
	targetPhysicalStoreIds: Readonly<Record<string, string>>
}

export interface LegacyMigrationRevisions {
	initialMemoryRevision: number
	initialConfigRevision: number
}

export interface LegacyMigrationClock {
	now(): string
}

export interface LegacyMigrationInspectInput {
	source: LegacyV006MigrationSource
	compatibility: LegacyMigrationRuntimeCompatibility
	bounds: LegacyMigrationBounds
	ids: LegacyMigrationIds
	revisions: LegacyMigrationRevisions
	clock: LegacyMigrationClock
}

export type LegacyMigrationIssueCode =
	| 'unsupported-version'
	| 'unsupported-store'
	| 'unsupported-lens-type'
	| 'incompatible-schema'
	| 'unavailable-model-runtime'
	| 'unavailable-recipe'
	| 'invalid-legacy-record'
	| 'unknown-dismissed-status'
	| 'bounds-exceeded'

export interface LegacyMigrationIssue {
	code: LegacyMigrationIssueCode
	message: string
	lensId?: string
}

export interface LegacyMigrationTarget {
	lensId: string
	internal: boolean
	physicalStoreId: string
	lens: EvolutionLensDefinition
	snapshot: NeuronStoreSnapshot
	snapshotDigest: string
}

export interface LegacyMigrationBrainRecords {
	state: BrainStateRecord[]
	neurons: BrainNeuronRecord[]
	internalNeurons: BrainNeuronRecord[]
	evolution: BrainEvolutionRecord[]
	dismissedBatches: DismissedBatchRecord[]
}

export interface LegacyMigrationPlan {
	kind: 'brain' | 'neuron'
	migrationId: string
	journalStateId: string
	sourceId: string
	sourceStoreKind: LegacyV006StoreKind
	sourceVersion: '0.0.6'
	sourceFingerprint: string
	intentDigest: string
	createdAt: string
	revisions: LegacyMigrationRevisions
	targetRegistryRevisionId?: string
	targetRegistryRevision?: number
	targets: LegacyMigrationTarget[]
	brain?: LegacyMigrationBrainRecords
}

export type LegacyMigrationInspectionResult =
	| { status: 'ready'; plan: LegacyMigrationPlan }
	| { status: 'incompatible'; issues: LegacyMigrationIssue[] }

export interface LegacyMigrationVerifier {
	verifyTarget(input: {
		plan: LegacyMigrationPlan
		target: LegacyMigrationTarget
		store: LegacyMigrationTargetReader
	}): Promise<void>
}

export interface LegacyMigrationCollectionReader<T extends { id: string }> {
	get(id: string): Promise<T | undefined>
	list(filter?: Record<string, unknown>): Promise<T[]>
	count(filter?: Record<string, unknown>): Promise<number>
}

/** Read-only verifier surface; execution also detects accidental mutation. */
export interface LegacyMigrationTargetReader {
	observations: LegacyMigrationCollectionReader<ObservationRecord>
	understanding: LegacyMigrationCollectionReader<UnderstandingRecord>
	evolution: LegacyMigrationCollectionReader<EvolutionRecord>
	state: LegacyMigrationCollectionReader<StateRecord>
}

export type LegacyMigrationStage =
	| 'after-journal'
	| 'after-target-write'
	| 'before-publish'
	| 'after-publish'

export interface LegacyMigrationExecutionOptions {
	verifier?: LegacyMigrationVerifier
	onStage?(stage: LegacyMigrationStage, lensId?: string): void | Promise<void>
}

export type LegacyMigrationExecutionResult =
	| { status: 'completed'; deduplicated: boolean; registryRevisionId?: string }
	| { status: 'conflict'; reason: string }
	| { status: 'failure'; error: unknown }

export interface LegacyBrainMigrationExecutionInput {
	source: LegacyV006BrainSource
	plan: LegacyMigrationPlan
	targetId: string
	target: BrainStore
	/** Caller guarantees exclusive access to every target store for this call. */
	assertTargetExclusive(): void | Promise<void>
	clock: LegacyMigrationClock
	options?: LegacyMigrationExecutionOptions
}

export interface LegacyNeuronMigrationExecutionInput {
	source: LegacyV006NeuronSource
	plan: LegacyMigrationPlan
	targetId: string
	target: NeuronStore
	/** Caller guarantees exclusive access to the target store for this call. */
	assertTargetExclusive(): void | Promise<void>
	clock: LegacyMigrationClock
	options?: LegacyMigrationExecutionOptions
}
