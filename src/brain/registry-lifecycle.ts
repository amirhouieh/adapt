import type {
	BrainEvolutionActivationRecord,
	BrainNeuronRecord,
	BrainRegistryLensRecord,
	BrainRegistryRevisionRecord,
	BrainStore,
	NeuronStore,
} from '../stores'
import {
	initializeEvolutionRegistry,
	pinEvolutionRegistry,
	recoverEvolutionActivation,
} from './evolution/activation'
import type {
	EvolutionRecoveryStrategy,
	EvolutionRunControl,
	EvolutionTransformationValidator,
	PinnedEvolutionRegistry,
} from './evolution/contracts'

export interface BrainRegistryClock {
	now(): string
}

export interface BrainRegistryIdSource {
	nextRegistryRevisionId(): string
}

export interface LegacyBrainLensBuilderInput {
	record: BrainNeuronRecord
	store: NeuronStore
}

export interface LegacyBrainLensBuilder {
	build(input: LegacyBrainLensBuilderInput): Promise<BrainRegistryLensRecord>
}

export interface EnsureBrainRegistryInput {
	store: BrainStore
	legacyLensBuilder: LegacyBrainLensBuilder
	clock: BrainRegistryClock
	ids: BrainRegistryIdSource
	initialRevision: number
}

export type BrainActivationRecoveryOutcome = {
	activationId: string
	status: 'completed' | 'abandoned'
	registryRevisionId: string
}

export type BrainRegistryRecoveryResult =
	| {
			status: 'ready'
			registry: PinnedEvolutionRegistry
			activations: BrainActivationRecoveryOutcome[]
	  }
	| {
			status: 'recovery-required'
			activationId: string
			registryRevisionId: string
			reason: string
	  }

export interface RecoverBrainRegistryInput {
	store: BrainStore
	strategy(record: BrainEvolutionActivationRecord): EvolutionRecoveryStrategy
	createRunControl(record: BrainEvolutionActivationRecord): EvolutionRunControl
	resolveTransformationValidator(
		reference: NonNullable<
			BrainEvolutionActivationRecord['transformation_ref']
		>,
	): EvolutionTransformationValidator | undefined
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

function normalizedTimestamp(value: string): boolean {
	const time = Date.parse(value)
	return Number.isFinite(time) && new Date(time).toISOString() === value
}

function nonEmpty(value: string, field: string): void {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`${field} must be a non-empty string`)
}

function compareActivations(
	left: BrainEvolutionActivationRecord,
	right: BrainEvolutionActivationRecord,
): number {
	return (
		left.created_at.localeCompare(right.created_at) ||
		left.id.localeCompare(right.id)
	)
}

/**
 * Creates the first authoritative registry for a legacy Brain without moving
 * or rewriting its neuron stores. Existing registries are returned unchanged.
 */
export async function ensureBrainRegistry(
	input: EnsureBrainRegistryInput,
): Promise<PinnedEvolutionRegistry> {
	if (!validRevision(input.initialRevision))
		throw new Error(
			'initial registry revision must be a finite nonnegative safe integer',
		)
	const existingHead = await input.store.registryHeads.get('current')
	if (existingHead)
		return pinEvolutionRegistry(input.store, existingHead.revision_id)

	const records = await input.store.neurons.list()
	const lenses: BrainRegistryLensRecord[] = []
	for (const record of records) {
		const lens = await input.legacyLensBuilder.build({
			record: structuredClone(record),
			store: input.store.getNeuronStore(record.id),
		})
		if (
			lens.id !== record.id ||
			lens.physical_store_id !== record.id ||
			lens.type !== record.type
		) {
			throw new Error(
				`legacy lens builder changed identity, physical store, or type for ${record.id}`,
			)
		}
		lenses.push(structuredClone(lens))
	}

	const headRevisionId = input.ids.nextRegistryRevisionId()
	nonEmpty(headRevisionId, 'registry revision id')
	const createdAt = input.clock.now()
	if (!normalizedTimestamp(createdAt))
		throw new Error('registry clock must return a normalized UTC timestamp')
	await initializeEvolutionRegistry(input.store, {
		head_revision_id: headRevisionId,
		revision: input.initialRevision,
		lenses,
		created_at: createdAt,
	})
	return pinEvolutionRegistry(input.store, headRevisionId)
}

/**
 * Recovers every nonterminal activation in deterministic journal order. The
 * caller supplies recovery policy, transformation validators, and an owned
 * run-control lease for each activation.
 */
export async function recoverBrainRegistry(
	input: RecoverBrainRegistryInput,
): Promise<BrainRegistryRecoveryResult> {
	const records = (await input.store.evolutionActivations.list())
		.filter(
			(record) =>
				record.status === 'preparing' ||
				record.status === 'staged' ||
				record.status === 'activated' ||
				record.status === 'abandoning',
		)
		.sort(compareActivations)
	const activations: BrainActivationRecoveryOutcome[] = []

	for (const record of records) {
		const strategy = input.strategy(structuredClone(record))
		let validator: EvolutionTransformationValidator | undefined
		if (record.transformation_ref) {
			validator = input.resolveTransformationValidator(
				record.transformation_ref,
			)
			if (!validator) {
				return {
					status: 'recovery-required',
					activationId: record.id,
					registryRevisionId:
						(await input.store.registryHeads.get('current'))?.revision_id ?? '',
					reason: `transformation validator ${record.transformation_ref.id}@${record.transformation_ref.version} is unavailable`,
				}
			}
		}
		const result = await recoverEvolutionActivation(
			input.store,
			record.id,
			strategy,
			input.createRunControl(structuredClone(record)),
			validator ? { transformation_validator: validator } : {},
		)
		const current = await input.store.evolutionActivations.get(record.id)
		const registryRevisionId =
			(await input.store.registryHeads.get('current'))?.revision_id ??
			('registry_revision_id' in result ? result.registry_revision_id : '')
		if (result.status === 'activated' && current?.status === 'completed') {
			activations.push({
				activationId: record.id,
				status: 'completed',
				registryRevisionId,
			})
			continue
		}
		if (current?.status === 'abandoned' && strategy === 'abandon') {
			activations.push({
				activationId: record.id,
				status: 'abandoned',
				registryRevisionId,
			})
			continue
		}
		return {
			status: 'recovery-required',
			activationId: record.id,
			registryRevisionId,
			reason:
				result.status === 'conflict'
					? `activation recovery conflicted: ${result.reason}`
					: result.status === 'failure' || result.status === 'recovery-required'
						? result.error
						: 'activation recovery did not reach a terminal state',
		}
	}

	return {
		status: 'ready',
		registry: await pinEvolutionRegistry(input.store),
		activations,
	}
}

export function physicalStoreForLens(
	store: BrainStore,
	registry: PinnedEvolutionRegistry,
	lensId: string,
): NeuronStore {
	const lens = registry.getLens(lensId)
	if (!lens)
		throw new Error(
			`lens ${lensId} is not present in registry ${registry.revision.id}`,
		)
	return store.getNeuronStore(lens.physical_store_id)
}

export function registryRecord(
	registry: PinnedEvolutionRegistry,
): BrainRegistryRevisionRecord {
	return structuredClone(registry.revision)
}
