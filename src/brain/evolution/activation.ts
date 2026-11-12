import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
	AtomicBrainStore,
	AtomicNeuronStore,
	BrainEvolutionActivationRecord,
	BrainEvolutionStageRecord,
	BrainMemoryMappingRecord,
	BrainRegistryLensRecord,
	BrainRegistryRevisionRecord,
	BrainStore,
	LearningHistoryRecord,
	NeuronStore,
	NeuronStoreSnapshot,
} from '../../stores'
import type {
	EvolutionActivationInput,
	EvolutionActivationOptions,
	EvolutionActivationResult,
	EvolutionLensDefinition,
	EvolutionRecoveryStrategy,
	EvolutionRunControl,
	EvolutionStageRetentionInput,
	EvolutionStageRetentionResult,
	EvolutionTransformationValidator,
	InitializeEvolutionRegistryInput,
	PinnedEvolutionRegistry,
} from './contracts'
import { snapshotValidatedEvolutionProposal } from './validation'

const headId = 'current' as const

export class EvolutionActivationInterruption extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'EvolutionActivationInterruption'
	}
}

class ActivationConflict extends Error {
	constructor(
		readonly reason:
			| 'registry-revision'
			| 'source-revision'
			| 'activation-id-reused',
		message: string,
	) {
		super(message)
		this.name = 'ActivationConflict'
	}
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

function validPositiveLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}

function validTimestamp(value: string): boolean {
	const parsed = new Date(value)
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (typeof value !== 'object' || value === null) return value
	const result = Object.create(null) as Record<string, unknown>
	for (const key of Object.keys(value).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const entry = (value as Record<string, unknown>)[key]
		if (entry !== undefined) result[key] = canonical(entry)
	}
	return result
}

function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

function portableEqual(left: unknown, right: unknown): boolean {
	return isDeepStrictEqual(canonical(left), canonical(right))
}

export function neuronStoreSnapshotDigest(
	snapshot: NeuronStoreSnapshot,
): string {
	return digest(snapshot)
}

function activationIntent(input: EvolutionActivationInput): unknown {
	return {
		activation_id: input.activation_id,
		mode: input.mode,
		validated_proposal: input.validated_proposal,
		base_registry_revision_id: input.base_registry_revision_id,
		target_registry: input.target_registry,
		transformation: input.transformation,
		staging_policy: input.staging_policy,
		created_at: input.created_at,
		updated_at: input.updated_at,
	}
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right))
}

function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return isDeepStrictEqual(sorted(left), sorted(right))
}

function snapshotRecordCount(snapshot: NeuronStoreSnapshot): number {
	return Object.values(snapshot).reduce(
		(total, records) => total + records.length,
		0,
	)
}

function snapshotRevision(snapshot: NeuronStoreSnapshot): {
	memory_revision: number
	config_revision: number
} {
	const revisions = snapshot.learningRevisions
	if (revisions.length !== 1 || revisions[0]?.id !== headId) {
		throw new Error(
			'each staged target requires exactly one current learning revision',
		)
	}
	const revision = revisions[0]
	if (
		!validRevision(revision.memory_revision) ||
		!validRevision(revision.config_revision)
	) {
		throw new Error(
			'staged learning revisions must be finite nonnegative safe integers',
		)
	}
	return revision
}

export async function readNeuronStoreSnapshot(
	store: NeuronStore,
): Promise<NeuronStoreSnapshot> {
	return store.runAtomic((atomic) => ({
		observations: atomic.observations.list(),
		understanding: atomic.understanding.list(),
		evolution: atomic.evolution.list(),
		state: atomic.state.list(),
		learningHistory: atomic.learningHistory.list(),
		memoryChanges: atomic.memoryChanges.list(),
		pendingWork: atomic.pendingWork.list(),
		pendingInputs: atomic.pendingInputs.list(),
		processedInputs: atomic.processedInputs.list(),
		outbox: atomic.outbox.list(),
		learningAttempts: atomic.learningAttempts.list(),
		learningRevisions: atomic.learningRevisions.list(),
	}))
}

function writeRecords<T extends { id: string }>(
	collection: { clear(): void; add(item: T): void },
	records: readonly T[],
): void {
	collection.clear()
	for (const record of records) collection.add(record)
}

function replaceAtomicNeuronStore(
	store: AtomicNeuronStore,
	snapshot: NeuronStoreSnapshot,
): void {
	writeRecords(store.observations, snapshot.observations)
	writeRecords(store.understanding, snapshot.understanding)
	writeRecords(store.evolution, snapshot.evolution)
	writeRecords(store.state, snapshot.state)
	writeRecords(store.learningHistory, snapshot.learningHistory)
	writeRecords(store.memoryChanges, snapshot.memoryChanges)
	writeRecords(store.pendingWork, snapshot.pendingWork)
	writeRecords(store.pendingInputs, snapshot.pendingInputs)
	writeRecords(store.processedInputs, snapshot.processedInputs)
	writeRecords(store.outbox, snapshot.outbox)
	writeRecords(store.learningAttempts, snapshot.learningAttempts)
	writeRecords(store.learningRevisions, snapshot.learningRevisions)
}

async function replaceNeuronStore(
	store: NeuronStore,
	snapshot: NeuronStoreSnapshot,
): Promise<void> {
	await store.runAtomic((atomic) => replaceAtomicNeuronStore(atomic, snapshot))
}

async function clearNeuronStore(store: NeuronStore): Promise<void> {
	await store.runAtomic((atomic) => {
		atomic.observations.clear()
		atomic.understanding.clear()
		atomic.evolution.clear()
		atomic.state.clear()
		atomic.learningHistory.clear()
		atomic.memoryChanges.clear()
		atomic.pendingWork.clear()
		atomic.pendingInputs.clear()
		atomic.processedInputs.clear()
		atomic.outbox.clear()
		atomic.learningAttempts.clear()
		atomic.learningRevisions.clear()
	})
}

function storageLensMatchesDefinition(
	record: BrainRegistryLensRecord,
	definition: EvolutionLensDefinition,
): boolean {
	return (
		record.id === definition.id &&
		record.type === definition.type &&
		isDeepStrictEqual(record.dependencies, definition.dependencies) &&
		isDeepStrictEqual(record.config, definition)
	)
}

function validateRegistryShape(input: EvolutionActivationInput): void {
	const source = input.validated_proposal.source_registry
	const target = input.validated_proposal.registry
	if (!validRevision(input.target_registry.revision)) {
		throw new Error(
			'target registry revision must be a finite nonnegative safe integer',
		)
	}
	if (
		input.target_registry.parent_id !== input.base_registry_revision_id ||
		input.target_registry.activation_id !== input.activation_id
	)
		throw new Error(
			'target registry parent and activation must match the activation request',
		)
	if (!validTimestamp(input.created_at) || !validTimestamp(input.updated_at)) {
		throw new Error('activation timestamps must be normalized UTC timestamps')
	}
	if (!validTimestamp(input.target_registry.created_at)) {
		throw new Error(
			'target registry timestamp must be a normalized UTC timestamp',
		)
	}
	if (
		input.transformation.proposal_id !== input.validated_proposal.proposal.id
	) {
		throw new Error(
			'transformation proposal id does not match the validated proposal',
		)
	}
	if (target.length !== input.target_registry.lenses.length) {
		throw new Error(
			'target registry does not match the validated resulting registry',
		)
	}
	const targetById = new Map(
		input.target_registry.lenses.map((lens) => [lens.id, lens]),
	)
	if (targetById.size !== input.target_registry.lenses.length) {
		throw new Error('target registry lens ids must be unique')
	}
	if (
		new Set(input.target_registry.lenses.map((lens) => lens.physical_store_id))
			.size !== input.target_registry.lenses.length
	)
		throw new Error('target registry physical store ids must be unique')
	for (const definition of target) {
		const record = targetById.get(definition.id)
		if (!record || !storageLensMatchesDefinition(record, definition)) {
			throw new Error(
				'target registry does not match the validated resulting registry',
			)
		}
	}
	const baseAffected = new Set(
		input.validated_proposal.proposal.target_lens_ids,
	)
	const sourceById = new Map(source.map((lens) => [lens.id, lens]))
	for (const record of input.target_registry.lenses) {
		if (baseAffected.has(record.id)) continue
		const previous = sourceById.get(record.id)
		if (previous && !storageLensMatchesDefinition(record, previous)) {
			throw new Error(
				'an unaffected target registry lens differs from its validated source',
			)
		}
	}
}

function validateStagingBounds(input: EvolutionActivationInput): void {
	const policy = input.staging_policy
	for (const [name, value] of Object.entries(policy)) {
		if (!validPositiveLimit(value))
			throw new Error(`${name} must be a positive safe integer`)
	}
	if (input.transformation.targets.length > policy.max_targets) {
		throw new Error('transformation exceeds the staged target limit')
	}
	for (const target of input.transformation.targets) {
		if (snapshotRecordCount(target.snapshot) > policy.max_snapshot_records) {
			throw new Error(
				`staged target ${target.lens.id} exceeds the record limit`,
			)
		}
		const serialized = JSON.stringify(target.snapshot)
		if (serialized.length > policy.max_snapshot_chars) {
			throw new Error(
				`staged target ${target.lens.id} exceeds the character limit`,
			)
		}
	}
}

function historyIdentity(
	record: LearningHistoryRecord,
): Omit<LearningHistoryRecord, 'id'> {
	const { id: _id, ...identity } = record
	return identity
}

function validateMappingsForSource(input: {
	activation: BrainEvolutionActivationRecord
	mappings: BrainMemoryMappingRecord[]
	source_lens_id: string
	source: NeuronStoreSnapshot
	targets: Map<string, NeuronStoreSnapshot>
	transformation_allowed: boolean
}): void {
	const mappings = input.mappings.filter(
		(mapping) => mapping.source_lens_id === input.source_lens_id,
	)
	const sourceMemoryIds = input.source.understanding.map((record) => record.id)
	if (
		!sameStringSet(sourceMemoryIds, [
			...new Set(mappings.map((mapping) => mapping.source_memory_id)),
		])
	) {
		throw new Error(
			`memory mappings do not cover source lens ${input.source_lens_id}`,
		)
	}
	const mappedHistoryIds = new Set(
		mappings.flatMap((mapping) =>
			mapping.history.map((entry) => entry.source_history_id),
		),
	)
	if (
		!sameStringSet(
			[...mappedHistoryIds],
			input.source.learningHistory.map((record) => record.id),
		)
	) {
		throw new Error(
			`history mappings do not cover source lens ${input.source_lens_id}`,
		)
	}
	for (const sourceMemoryId of sourceMemoryIds) {
		const memoryMappings = mappings.filter(
			(mapping) => mapping.source_memory_id === sourceMemoryId,
		)
		for (const mapping of memoryMappings) {
			if (mapping.activation_id !== input.activation.id) {
				throw new Error('memory mapping activation id does not match')
			}
			if (input.activation.action === 'delete') {
				const expected =
					input.activation.deletion_mode === 'lens-only'
						? 'retained'
						: 'deleted'
				if (
					mapping.disposition !== expected ||
					mapping.target_lens_id !== undefined ||
					mapping.target_memory_id !== undefined
				)
					throw new Error(
						'delete mapping does not match the explicit deletion policy',
					)
				continue
			}
			if (
				mapping.disposition !== 'transferred' ||
				!mapping.target_lens_id ||
				!mapping.target_memory_id
			)
				throw new Error(
					'non-delete mappings require an explicit transferred target',
				)
			const target = input.targets.get(mapping.target_lens_id)
			const sourceMemory = input.source.understanding.find(
				(record) => record.id === mapping.source_memory_id,
			)
			const targetMemory = target?.understanding.find(
				(record) => record.id === mapping.target_memory_id,
			)
			if (!target || !sourceMemory || !targetMemory) {
				throw new Error(
					'mapping target memory does not exist in the staged snapshot',
				)
			}
			if (
				!input.transformation_allowed &&
				!portableEqual(sourceMemory, targetMemory)
			) {
				throw new Error(
					'a recipe-only evolution must preserve understanding records exactly',
				)
			}
			for (const historyMapping of mapping.history) {
				const sourceHistory = input.source.learningHistory.find(
					(record) => record.id === historyMapping.source_history_id,
				)
				const targetHistory = target.learningHistory.find(
					(record) => record.id === historyMapping.target_history_id,
				)
				if (
					!sourceHistory ||
					!targetHistory ||
					!portableEqual(
						historyIdentity(sourceHistory),
						historyIdentity(targetHistory),
					)
				)
					throw new Error(
						'target history does not preserve the mapped source history',
					)
				if (
					!input.transformation_allowed &&
					!portableEqual(sourceHistory, targetHistory)
				) {
					throw new Error(
						'a recipe-only evolution must preserve history records exactly',
					)
				}
			}
		}
	}
}

function sameRegistryDefinitions(
	records: BrainRegistryLensRecord[],
	definitions: EvolutionLensDefinition[],
): boolean {
	if (records.length !== definitions.length) return false
	const byId = new Map(records.map((record) => [record.id, record]))
	return (
		byId.size === records.length &&
		definitions.every((definition) => {
			const record = byId.get(definition.id)
			return (
				record !== undefined && storageLensMatchesDefinition(record, definition)
			)
		})
	)
}

async function validateActivationAgainstStore(
	store: BrainStore,
	input: EvolutionActivationInput,
): Promise<void> {
	validateRegistryShape(input)
	validateStagingBounds(input)
	const snapshot = await store.runAtomic((atomic) => ({
		head: atomic.registryHeads.get(headId),
		base: atomic.registryRevisions.get(input.base_registry_revision_id),
		revisions: atomic.registryRevisions.list(),
		stages: atomic.evolutionStages.list(),
	}))
	const { base, head } = snapshot
	if (!base || !head || head.revision_id !== base.id) {
		throw new ActivationConflict(
			'registry-revision',
			'base registry is no longer authoritative',
		)
	}
	if (
		base.revision === Number.MAX_SAFE_INTEGER ||
		input.target_registry.revision !== base.revision + 1
	)
		throw new Error('target registry revision must advance the base by one')
	if (
		!sameRegistryDefinitions(
			base.lenses,
			input.validated_proposal.source_registry,
		)
	) {
		throw new ActivationConflict(
			'registry-revision',
			'validated source configuration does not match the pinned registry',
		)
	}
	const affectedSourceLensIds = new Set(
		input.validated_proposal.proposal.target_lens_ids,
	)
	const requestedTargetById = new Map(
		input.target_registry.lenses.map((lens) => [lens.id, lens]),
	)
	for (const sourceLens of base.lenses) {
		if (affectedSourceLensIds.has(sourceLens.id)) continue
		if (
			!isDeepStrictEqual(requestedTargetById.get(sourceLens.id), sourceLens)
		) {
			throw new Error('an unaffected registry lens must be preserved exactly')
		}
	}
	const targetSnapshots = new Map(
		input.transformation.targets.map((target) => [
			target.lens.id,
			target.snapshot,
		]),
	)
	if (targetSnapshots.size !== input.transformation.targets.length) {
		throw new Error('staged target lens ids must be unique')
	}
	if (
		new Set(input.transformation.targets.map((target) => target.stage_id))
			.size !== input.transformation.targets.length
	)
		throw new Error('staged target ids must be unique')
	const physicalStoreIds = input.transformation.targets.map(
		(target) => target.lens.physical_store_id,
	)
	if (!sameStringSet(physicalStoreIds, [...new Set(physicalStoreIds)])) {
		throw new Error('staged target physical store ids must be unique')
	}
	const expectedTargets =
		input.validated_proposal.proposal.resulting_lenses.map((lens) => lens.id)
	if (!sameStringSet([...targetSnapshots.keys()], expectedTargets)) {
		throw new Error(
			'staged target lenses must exactly match the validated resulting lenses',
		)
	}
	const targetRegistryById = new Map(
		input.target_registry.lenses.map((lens) => [lens.id, lens]),
	)
	const reservedPhysicalIds = new Set([
		...snapshot.revisions.flatMap((revision) =>
			revision.lenses.map((lens) => lens.physical_store_id),
		),
		...snapshot.stages.map((stage) => stage.physical_store_id),
	])
	const maximumMemoryRevision = Math.max(
		0,
		...input.transformation.source_pins.map((pin) => pin.memory_revision),
	)
	const maximumConfigRevision = Math.max(
		-1,
		...input.transformation.source_pins.map((pin) => pin.config_revision),
	)
	for (const target of input.transformation.targets) {
		const registryLens = targetRegistryById.get(target.lens.id)
		if (!registryLens || !isDeepStrictEqual(target.lens, registryLens)) {
			throw new Error('staged target lens does not match the target registry')
		}
		if (reservedPhysicalIds.has(target.lens.physical_store_id)) {
			throw new Error('staged target physical store id is already reserved')
		}
		const revision = snapshotRevision(target.snapshot)
		if (
			revision.memory_revision < maximumMemoryRevision ||
			revision.config_revision <= maximumConfigRevision
		)
			throw new Error(
				'staged target must preserve current memory and advance configuration revision',
			)
	}
	const affected = input.validated_proposal.proposal.target_lens_ids
	const pins = input.transformation.source_pins
	if (
		!sameStringSet(
			pins.map((pin) => pin.lens_id),
			affected,
		)
	) {
		throw new Error('source revision pins must exactly match affected lenses')
	}
	if (
		new Set(pins.map((pin) => pin.lens_id)).size !== pins.length ||
		new Set(pins.map((pin) => pin.physical_store_id)).size !== pins.length
	)
		throw new Error('source revision pins must be unique')
	for (const pin of pins) {
		if (
			!validRevision(pin.memory_revision) ||
			!validRevision(pin.config_revision) ||
			pin.state_digest.length === 0
		)
			throw new Error(
				'source pins require valid revisions and a full-state digest',
			)
		const sourceLens = base.lenses.find((lens) => lens.id === pin.lens_id)
		if (!sourceLens || sourceLens.physical_store_id !== pin.physical_store_id) {
			throw new ActivationConflict(
				'source-revision',
				'source physical store does not match its registry pin',
			)
		}
	}
	if (
		new Set(input.transformation.mappings.map((mapping) => mapping.id)).size !==
		input.transformation.mappings.length
	)
		throw new Error('memory mapping ids must be unique')
	const pinnedLensIds = new Set(pins.map((pin) => pin.lens_id))
	for (const mapping of input.transformation.mappings) {
		if (
			mapping.activation_id !== input.activation_id ||
			!pinnedLensIds.has(mapping.source_lens_id) ||
			!validTimestamp(mapping.created_at)
		)
			throw new Error(
				'memory mapping does not belong to this activation source',
			)
	}
}

function reserveActivationRecords(
	store: AtomicBrainStore,
	record: BrainEvolutionActivationRecord,
	stages: BrainEvolutionStageRecord[],
	mappings: BrainMemoryMappingRecord[],
): void {
	if (store.evolutionActivations.get(record.id)) {
		throw new ActivationConflict(
			'activation-id-reused',
			'activation id is already used',
		)
	}
	if (store.registryRevisions.get(record.target_registry.id)) {
		throw new ActivationConflict(
			'activation-id-reused',
			'target registry id is already used',
		)
	}
	const reservedPhysicalIds = new Set([
		...store.registryRevisions
			.list()
			.flatMap((revision) =>
				revision.lenses.map((lens) => lens.physical_store_id),
			),
		...store.evolutionStages.list().map((stage) => stage.physical_store_id),
	])
	for (const stage of stages) {
		if (store.evolutionStages.get(stage.id)) {
			throw new ActivationConflict(
				'activation-id-reused',
				'stage id is already used',
			)
		}
		if (reservedPhysicalIds.has(stage.physical_store_id)) {
			throw new ActivationConflict(
				'activation-id-reused',
				'target physical store id is already reserved',
			)
		}
		reservedPhysicalIds.add(stage.physical_store_id)
	}
	for (const mapping of mappings) {
		if (store.memoryMappings.get(mapping.id)) {
			throw new ActivationConflict(
				'activation-id-reused',
				'memory mapping id is already used',
			)
		}
	}
	store.evolutionActivations.add(record)
	for (const stage of stages) store.evolutionStages.add(stage)
	for (const mapping of mappings) store.memoryMappings.add(mapping)
}

async function validateFreshTargetStores(
	store: BrainStore,
	input: EvolutionActivationInput,
): Promise<void> {
	for (const target of input.transformation.targets) {
		const existing = await readNeuronStoreSnapshot(
			store.getNeuronStore(target.lens.physical_store_id),
		)
		if (snapshotRecordCount(existing) > 0) {
			throw new ActivationConflict(
				'activation-id-reused',
				'target physical store already contains state',
			)
		}
	}
}

function activationRecord(
	input: EvolutionActivationInput,
): BrainEvolutionActivationRecord {
	const affectedLensIds = [
		...input.validated_proposal.proposal.target_lens_ids,
		...input.validated_proposal.proposal.resulting_lenses.map(
			(lens) => lens.id,
		),
	]
	return {
		id: input.activation_id,
		proposal_id: input.validated_proposal.proposal.id,
		action: input.validated_proposal.proposal.action,
		intent_digest: digest(activationIntent(input)),
		mode: input.mode,
		base_registry_revision_id: input.base_registry_revision_id,
		target_registry: input.target_registry,
		source_pins: input.transformation.source_pins,
		affected_lens_ids: [...new Set(affectedLensIds)],
		staging_policy: input.staging_policy,
		transformation_ref: input.validated_proposal.proposal.transformation,
		deletion_mode: input.validated_proposal.proposal.deletion_mode,
		status: 'preparing',
		created_at: input.created_at,
		updated_at: input.updated_at,
	}
}

function stageRecords(
	input: EvolutionActivationInput,
): BrainEvolutionStageRecord[] {
	return input.transformation.targets.map((target) => ({
		id: target.stage_id,
		activation_id: input.activation_id,
		lens_id: target.lens.id,
		physical_store_id: target.lens.physical_store_id,
		lens: target.lens,
		snapshot: target.snapshot,
		status: 'pending',
		created_at: input.created_at,
		updated_at: input.updated_at,
	}))
}

function sameActivation(
	record: BrainEvolutionActivationRecord,
	input: EvolutionActivationInput,
): boolean {
	return record.intent_digest === digest(activationIntent(input))
}

async function notify(
	options: EvolutionActivationOptions,
	stage: Parameters<NonNullable<EvolutionActivationOptions['onStage']>>[0],
): Promise<void> {
	await options.onStage?.(stage)
}

function requireRecordsOwned<T extends { id: string }>(
	name: string,
	records: readonly T[],
	targets: readonly T[][],
): void {
	for (const record of records) {
		const owners = targets.filter((collection) =>
			collection.some((candidate) => portableEqual(candidate, record)),
		)
		if (owners.length !== 1) {
			throw new Error(
				`${name} record ${record.id} requires exactly one target owner`,
			)
		}
	}
}

function validateTargetReferences(target: NeuronStoreSnapshot): void {
	const memories = new Set(target.understanding.map((record) => record.id))
	const histories = new Map(
		target.learningHistory.map((record) => [record.id, record]),
	)
	const changes = new Set(target.memoryChanges.map((record) => record.id))
	const pendingWork = new Map(
		target.pendingWork.map((record) => [record.id, record]),
	)
	const pendingInputs = new Map(
		target.pendingInputs.map((record) => [record.id, record]),
	)
	const processedInputs = new Map(
		target.processedInputs.map((record) => [record.id, record]),
	)

	for (const record of target.memoryChanges) {
		if (record.affected_memory_ids.some((id) => !memories.has(id)))
			throw new Error('target memory change has a cross-target reference')
	}
	for (const record of target.learningHistory) {
		if (record.change_ids.some((id) => !changes.has(id)))
			throw new Error('target learning history has a cross-target reference')
	}
	for (const record of target.pendingInputs) {
		const work = pendingWork.get(record.pending_work_id)
		if (
			!work ||
			work.status !== 'pending' ||
			work.attempt_id !== record.attempt_id ||
			!work.input_ids.includes(record.id)
		)
			throw new Error('target pending input is separated from its pending work')
	}
	for (const work of target.pendingWork) {
		for (const inputId of work.input_ids) {
			const pendingInput = pendingInputs.get(inputId)
			if (
				work.status === 'pending' &&
				(!pendingInput || pendingInput.pending_work_id !== work.id)
			)
				throw new Error('target pending work is separated from its input index')
			if (
				work.status === 'deleted' &&
				pendingInput?.pending_work_id === work.id
			) {
				throw new Error('deleted target work retains a pending input index')
			}
		}
	}
	for (const attempt of target.learningAttempts) {
		const history = histories.get(attempt.history_id)
		if (!history || history.attempt_id !== attempt.id) {
			throw new Error('target learning attempt is separated from its history')
		}
		if (
			attempt.input_ids.some(
				(id) => processedInputs.get(id)?.attempt_id !== attempt.id,
			)
		) {
			throw new Error(
				'target learning attempt is separated from processed input state',
			)
		}
	}
	for (const record of target.outbox) {
		if (record.change_ids.some((id) => !changes.has(id)))
			throw new Error('target outbox has a cross-target change reference')
	}
}

function validateProcessingConservation(
	source: NeuronStoreSnapshot,
	targets: NeuronStoreSnapshot[],
): void {
	for (const target of targets) validateTargetReferences(target)
	requireRecordsOwned(
		'observation',
		source.observations,
		targets.map((target) => target.observations),
	)
	requireRecordsOwned(
		'evolution history',
		source.evolution,
		targets.map((target) => target.evolution),
	)
	requireRecordsOwned(
		'memory change',
		source.memoryChanges,
		targets.map((target) => target.memoryChanges),
	)
	requireRecordsOwned(
		'pending work',
		source.pendingWork,
		targets.map((target) => target.pendingWork),
	)
	requireRecordsOwned(
		'pending input',
		source.pendingInputs,
		targets.map((target) => target.pendingInputs),
	)
	requireRecordsOwned(
		'processed input',
		source.processedInputs,
		targets.map((target) => target.processedInputs),
	)
	requireRecordsOwned(
		'outbox',
		source.outbox,
		targets.map((target) => target.outbox),
	)
	requireRecordsOwned(
		'learning attempt',
		source.learningAttempts,
		targets.map((target) => target.learningAttempts),
	)
}

async function readFencedSourcesAndValidate(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
	stages: BrainEvolutionStageRecord[],
	transformationValidator?: EvolutionTransformationValidator,
): Promise<Map<string, NeuronStoreSnapshot>> {
	const targetSnapshots = new Map<string, NeuronStoreSnapshot>()
	for (const stage of stages) {
		if (!stage.snapshot)
			throw new Error(`staged snapshot ${stage.id} is unavailable`)
		targetSnapshots.set(stage.lens_id, stage.snapshot)
	}
	const mappings = await store.memoryMappings.list({ activation_id: record.id })
	const sources = new Map<string, NeuronStoreSnapshot>()
	for (const pin of record.source_pins) {
		const source = await readNeuronStoreSnapshot(
			store.getNeuronStore(pin.physical_store_id),
		)
		const revision = snapshotRevision(source)
		if (
			revision.memory_revision !== pin.memory_revision ||
			revision.config_revision !== pin.config_revision ||
			neuronStoreSnapshotDigest(source) !== pin.state_digest
		) {
			throw new ActivationConflict(
				'source-revision',
				'source state advanced after the supplied full-state pin',
			)
		}
		sources.set(pin.lens_id, source)
		validateMappingsForSource({
			activation: record,
			mappings,
			source_lens_id: pin.lens_id,
			source,
			targets: targetSnapshots,
			transformation_allowed: record.transformation_ref !== undefined,
		})
		if (record.action !== 'delete') {
			validateProcessingConservation(source, [...targetSnapshots.values()])
		}
	}
	if (record.transformation_ref) {
		if (
			!transformationValidator ||
			!isDeepStrictEqual(
				transformationValidator.reference,
				record.transformation_ref,
			)
		)
			throw new Error(
				'the approved snapshot transformation validator is required',
			)
		await transformationValidator.validate({
			proposal_id: record.proposal_id,
			reference: structuredClone(record.transformation_ref),
			sources: [...sources].map(([lensId, snapshot]) => ({
				lens_id: lensId,
				state_digest: neuronStoreSnapshotDigest(snapshot),
				snapshot: structuredClone(snapshot),
			})),
			targets: [...targetSnapshots].map(([lensId, snapshot]) => ({
				lens_id: lensId,
				state_digest: neuronStoreSnapshotDigest(snapshot),
				snapshot: structuredClone(snapshot),
			})),
			mappings: structuredClone(mappings),
		})
	}
	return sources
}

async function verifyFencedSourceDigests(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
): Promise<void> {
	for (const pin of record.source_pins) {
		const source = await readNeuronStoreSnapshot(
			store.getNeuronStore(pin.physical_store_id),
		)
		if (neuronStoreSnapshotDigest(source) !== pin.state_digest) {
			throw new ActivationConflict(
				'source-revision',
				'source state changed while the activation fence was held',
			)
		}
	}
}

async function beginAbandonActivation(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
	error: string,
): Promise<boolean> {
	return store.runAtomic((atomic) => {
		const current = atomic.evolutionActivations.get(record.id)
		const head = atomic.registryHeads.get(headId)
		if (
			!current ||
			current.intent_digest !== record.intent_digest ||
			current.status === 'completed' ||
			current.status === 'activated' ||
			current.status === 'abandoned' ||
			head?.revision_id === record.target_registry.id
		)
			return false
		atomic.evolutionActivations.update(record.id, {
			status: 'abandoning',
			error,
			updated_at: record.updated_at,
		})
		return true
	})
}

async function finishAbandonActivation(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
): Promise<boolean> {
	return store.runAtomic((atomic) => {
		const current = atomic.evolutionActivations.get(record.id)
		const head = atomic.registryHeads.get(headId)
		if (
			!current ||
			current.intent_digest !== record.intent_digest ||
			current.status !== 'abandoning' ||
			head?.revision_id === record.target_registry.id
		)
			return false
		atomic.evolutionActivations.update(record.id, {
			status: 'abandoned',
			updated_at: record.updated_at,
		})
		for (const stage of atomic.evolutionStages.list({
			activation_id: record.id,
		})) {
			atomic.evolutionStages.update(stage.id, {
				status: 'abandoned',
				snapshot: undefined,
				updated_at: record.updated_at,
			})
		}
		return true
	})
}

async function finishActivated(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
	runControl: EvolutionRunControl,
	options: EvolutionActivationOptions,
): Promise<void> {
	if (record.deletion_mode === 'lens-and-retained-knowledge') {
		for (const pin of record.source_pins) {
			await clearNeuronStore(store.getNeuronStore(pin.physical_store_id))
		}
	}
	await store.runAtomic((atomic) => {
		for (const stage of atomic.evolutionStages.list({
			activation_id: record.id,
		})) {
			atomic.evolutionStages.update(stage.id, {
				status: 'consumed',
				snapshot: undefined,
				updated_at: record.updated_at,
			})
		}
	})
	await runControl.resume(record.affected_lens_ids, record.target_registry.id)
	await store.runAtomic((atomic) => {
		const current = atomic.evolutionActivations.get(record.id)
		if (current && current.status !== 'completed') {
			atomic.evolutionActivations.update(record.id, {
				status: 'completed',
				updated_at: record.updated_at,
			})
		}
	})
	await notify(options, 'completed')
}

async function clearRetiredPendingInputs(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
): Promise<void> {
	const authoritativePhysicalIds = new Set(
		record.target_registry.lenses.map((lens) => lens.physical_store_id),
	)
	for (const pin of record.source_pins) {
		if (authoritativePhysicalIds.has(pin.physical_store_id)) continue
		await store.getNeuronStore(pin.physical_store_id).runAtomic((atomic) => {
			for (const work of atomic.pendingWork.list()) {
				if (work.inputs !== undefined) {
					atomic.pendingWork.update(work.id, { inputs: undefined })
				}
			}
		})
	}
}

async function completeActivation(
	store: BrainStore,
	record: BrainEvolutionActivationRecord,
	runControl: EvolutionRunControl,
	options: EvolutionActivationOptions,
): Promise<void> {
	let head = await store.registryHeads.get(headId)
	if (!head) throw new Error('evolution registry is not initialized')
	if (
		head.revision_id !== record.base_registry_revision_id &&
		head.revision_id !== record.target_registry.id
	)
		throw new ActivationConflict(
			'registry-revision',
			'authoritative registry changed during activation',
		)

	await runControl.quiesce(record.affected_lens_ids)
	await runControl.waitForIdle(record.affected_lens_ids)
	await notify(options, 'quiesced')
	head = await store.registryHeads.get(headId)
	if (!head) throw new Error('evolution registry is not initialized')
	if (head.revision_id !== record.target_registry.id) {
		if (head.revision_id !== record.base_registry_revision_id) {
			throw new ActivationConflict(
				'registry-revision',
				'authoritative registry changed after quiescence',
			)
		}
		const stages = await store.evolutionStages.list({
			activation_id: record.id,
		})
		if (
			stages.length !==
				record.target_registry.lenses.filter((lens) =>
					record.affected_lens_ids.includes(lens.id),
				).length &&
			record.action !== 'delete'
		) {
			throw new Error('activation stage records are incomplete')
		}
		await readFencedSourcesAndValidate(
			store,
			record,
			stages,
			options.transformation_validator,
		)
		for (const stage of stages) {
			if (!stage.snapshot)
				throw new Error(`staged snapshot ${stage.id} is unavailable`)
			const targetStore = store.getNeuronStore(stage.physical_store_id)
			const existing = await readNeuronStoreSnapshot(targetStore)
			const existingCount = snapshotRecordCount(existing)
			if (stage.status === 'pending' && existingCount > 0) {
				throw new ActivationConflict(
					'activation-id-reused',
					'staged physical store was not empty before its reserved write',
				)
			}
			if (
				(stage.status === 'writing' || stage.status === 'ready') &&
				existingCount > 0 &&
				neuronStoreSnapshotDigest(existing) !==
					neuronStoreSnapshotDigest(stage.snapshot)
			) {
				throw new ActivationConflict(
					'activation-id-reused',
					'staged physical store contains different state',
				)
			}
			if (stage.status !== 'ready') {
				await store.evolutionStages.update(stage.id, {
					status: 'writing',
					updated_at: record.updated_at,
				})
				if (existingCount === 0)
					await replaceNeuronStore(targetStore, stage.snapshot)
			}
			await store.evolutionStages.update(stage.id, {
				status: 'ready',
				updated_at: record.updated_at,
			})
		}
		await store.evolutionActivations.update(record.id, {
			status: 'staged',
			updated_at: record.updated_at,
		})
		await notify(options, 'targets-written')
		await verifyFencedSourceDigests(store, record)
		await notify(options, 'before-registry-cas')
		await store.runAtomic((atomic) => {
			const currentHead = atomic.registryHeads.get(headId)
			if (
				!currentHead ||
				currentHead.revision_id !== record.base_registry_revision_id
			) {
				throw new ActivationConflict(
					'registry-revision',
					'authoritative registry changed before activation',
				)
			}
			const existingTarget = atomic.registryRevisions.get(
				record.target_registry.id,
			)
			if (
				existingTarget &&
				!isDeepStrictEqual(existingTarget, record.target_registry)
			) {
				throw new ActivationConflict(
					'activation-id-reused',
					'target registry id is already used',
				)
			}
			if (!existingTarget) atomic.registryRevisions.add(record.target_registry)
			for (const stage of atomic.evolutionStages.list({
				activation_id: record.id,
			})) {
				if (stage.status !== 'ready') {
					throw new ActivationConflict(
						'activation-id-reused',
						'target stage is not ready for publication',
					)
				}
				const reservations = atomic.evolutionStages.list({
					physical_store_id: stage.physical_store_id,
				})
				if (
					reservations.some(
						(reservation) => reservation.activation_id !== record.id,
					)
				) {
					throw new ActivationConflict(
						'activation-id-reused',
						'target physical store reservation changed before activation',
					)
				}
			}
			atomic.registryHeads.update(headId, {
				revision_id: record.target_registry.id,
				revision: record.target_registry.revision,
				updated_at: record.updated_at,
			})
			atomic.evolutionActivations.update(record.id, {
				status: 'activated',
				updated_at: record.updated_at,
			})
		})
		await notify(options, 'after-registry-cas')
		head = await store.registryHeads.get(headId)
	}
	if (!head || head.revision_id !== record.target_registry.id) {
		throw new ActivationConflict(
			'registry-revision',
			'target registry is not authoritative',
		)
	}
	await clearRetiredPendingInputs(store, record)
	await finishActivated(store, record, runControl, options)
}

export async function initializeEvolutionRegistry(
	store: BrainStore,
	input: InitializeEvolutionRegistryInput,
): Promise<BrainRegistryRevisionRecord> {
	if (!validRevision(input.revision))
		throw new Error(
			'registry revision must be a finite nonnegative safe integer',
		)
	if (!validTimestamp(input.created_at))
		throw new Error('registry timestamp must be normalized UTC')
	if (
		new Set(input.lenses.map((lens) => lens.id)).size !== input.lenses.length ||
		new Set(input.lenses.map((lens) => lens.physical_store_id)).size !==
			input.lenses.length
	)
		throw new Error('registry lens and physical store ids must be unique')
	const revision: BrainRegistryRevisionRecord = {
		id: input.head_revision_id,
		revision: input.revision,
		lenses: structuredClone(input.lenses),
		created_at: input.created_at,
	}
	return store.runAtomic((atomic) => {
		const existingHead = atomic.registryHeads.get(headId)
		if (existingHead) {
			const existing = atomic.registryRevisions.get(existingHead.revision_id)
			if (!existing || !isDeepStrictEqual(existing, revision)) {
				throw new Error('evolution registry is already initialized differently')
			}
			return existing
		}
		atomic.registryRevisions.add(revision)
		atomic.registryHeads.add({
			id: headId,
			revision_id: revision.id,
			revision: revision.revision,
			updated_at: input.created_at,
		})
		return revision
	})
}

export async function pinEvolutionRegistry(
	store: BrainStore,
	revisionId?: string,
): Promise<PinnedEvolutionRegistry> {
	const selectedId =
		revisionId ?? (await store.registryHeads.get(headId))?.revision_id
	if (!selectedId) throw new Error('evolution registry is not initialized')
	const revision = await store.registryRevisions.get(selectedId)
	if (!revision)
		throw new Error(`unknown evolution registry revision ${selectedId}`)
	const snapshot = structuredClone(revision)
	return {
		revision: snapshot,
		getLens(lensId) {
			const lens = snapshot.lenses.find((entry) => entry.id === lensId)
			return lens ? structuredClone(lens) : undefined
		},
	}
}

export async function activateEvolution(
	store: BrainStore,
	input: EvolutionActivationInput,
	runControl: EvolutionRunControl,
	options: EvolutionActivationOptions = {},
): Promise<EvolutionActivationResult> {
	let snapshot: EvolutionActivationInput
	let ownsAttempt = false
	let intendedDigest: string | undefined
	try {
		const validatedProposal = snapshotValidatedEvolutionProposal(
			input.validated_proposal,
		)
		snapshot = structuredClone({
			...input,
			validated_proposal: validatedProposal,
		})
		intendedDigest = digest(activationIntent(snapshot))
		const existing = await store.evolutionActivations.get(
			snapshot.activation_id,
		)
		if (existing) {
			if (!sameActivation(existing, snapshot)) {
				return { status: 'conflict', reason: 'activation-id-reused' }
			}
			if (existing.status === 'completed') {
				return {
					status: 'activated',
					registry_revision_id: existing.target_registry.id,
					deduplicated: true,
				}
			}
			if (existing.status === 'abandoned' || existing.status === 'failed') {
				return { status: 'conflict', reason: 'activation-id-reused' }
			}
			return {
				status: 'recovery-required',
				activation_id: existing.id,
				registry_revision_id:
					(await store.registryHeads.get(headId))?.revision_id ??
					existing.base_registry_revision_id,
				error:
					'matching activation is already in progress or requires recovery',
			}
		}
		await validateActivationAgainstStore(store, snapshot)
		await validateFreshTargetStores(store, snapshot)
		const record = activationRecord(snapshot)
		const stages = stageRecords(snapshot)
		await store.runAtomic((atomic) =>
			reserveActivationRecords(
				atomic,
				record,
				stages,
				snapshot.transformation.mappings,
			),
		)
		ownsAttempt = true
		await notify(options, 'journaled')
		await completeActivation(store, record, runControl, options)
		return {
			status: 'activated',
			registry_revision_id: record.target_registry.id,
			deduplicated: false,
		}
	} catch (error) {
		const activationId = input.activation_id
		const record = await store.evolutionActivations.get(activationId)
		const head = await store.registryHeads.get(headId)
		if (
			error instanceof EvolutionActivationInterruption ||
			(record && head?.revision_id === record.target_registry.id)
		) {
			return {
				status: 'recovery-required',
				activation_id: activationId,
				registry_revision_id:
					head?.revision_id ?? input.base_registry_revision_id,
				error: errorMessage(error),
			}
		}
		if (ownsAttempt && record && intendedDigest === record.intent_digest) {
			const abandoning = await beginAbandonActivation(
				store,
				record,
				errorMessage(error),
			)
			if (!abandoning) {
				return {
					status: 'recovery-required',
					activation_id: activationId,
					registry_revision_id:
						(await store.registryHeads.get(headId))?.revision_id ??
						input.base_registry_revision_id,
					error: errorMessage(error),
				}
			}
			try {
				await runControl.resume(
					record.affected_lens_ids,
					head?.revision_id ?? record.base_registry_revision_id,
				)
			} catch (publicationError) {
				return {
					status: 'recovery-required',
					activation_id: activationId,
					registry_revision_id:
						head?.revision_id ?? record.base_registry_revision_id,
					error: errorMessage(publicationError),
				}
			}
			if (!(await finishAbandonActivation(store, record))) {
				return {
					status: 'recovery-required',
					activation_id: activationId,
					registry_revision_id:
						(await store.registryHeads.get(headId))?.revision_id ??
						record.base_registry_revision_id,
					error: 'activation abandonment could not be finalized',
				}
			}
		}
		if (error instanceof ActivationConflict) {
			return { status: 'conflict', reason: error.reason }
		}
		return {
			status: 'failure',
			error: errorMessage(error),
			registry_revision_id:
				head?.revision_id ?? input.base_registry_revision_id,
		}
	}
}

export async function recoverEvolutionActivation(
	store: BrainStore,
	activationId: string,
	strategy: EvolutionRecoveryStrategy,
	runControl: EvolutionRunControl,
	options: EvolutionActivationOptions = {},
): Promise<EvolutionActivationResult> {
	const record = await store.evolutionActivations.get(activationId)
	if (!record)
		return {
			status: 'failure',
			error: 'activation journal not found',
			registry_revision_id:
				(await store.registryHeads.get(headId))?.revision_id ?? '',
		}
	if (record.status === 'completed') {
		return {
			status: 'activated',
			registry_revision_id: record.target_registry.id,
			deduplicated: true,
		}
	}
	if (record.status === 'abandoned' || record.status === 'failed') {
		return {
			status: 'failure',
			error: record.error ?? 'activation is not recoverable',
			registry_revision_id:
				(await store.registryHeads.get(headId))?.revision_id ?? '',
		}
	}
	const head = await store.registryHeads.get(headId)
	if (!head)
		return {
			status: 'failure',
			error: 'evolution registry is not initialized',
			registry_revision_id: '',
		}
	if (
		strategy === 'abandon' &&
		head.revision_id === record.base_registry_revision_id
	) {
		const abandoning =
			record.status === 'abandoning' ||
			(await beginAbandonActivation(
				store,
				record,
				'activation abandoned during recovery',
			))
		if (abandoning) {
			try {
				await runControl.resume(
					record.affected_lens_ids,
					record.base_registry_revision_id,
				)
			} catch (publicationError) {
				return {
					status: 'recovery-required',
					activation_id: record.id,
					registry_revision_id: record.base_registry_revision_id,
					error: errorMessage(publicationError),
				}
			}
			if (!(await finishAbandonActivation(store, record))) {
				return {
					status: 'recovery-required',
					activation_id: record.id,
					registry_revision_id: record.base_registry_revision_id,
					error: 'activation abandonment could not be finalized',
				}
			}
			return {
				status: 'failure',
				error: 'activation abandoned during recovery',
				registry_revision_id: record.base_registry_revision_id,
			}
		}
	}
	if (strategy === 'abandon' && head.revision_id !== record.target_registry.id)
		return { status: 'conflict', reason: 'registry-revision' }
	try {
		await completeActivation(store, record, runControl, options)
		return {
			status: 'activated',
			registry_revision_id: record.target_registry.id,
			deduplicated: true,
		}
	} catch (error) {
		const currentHead = await store.registryHeads.get(headId)
		if (
			error instanceof ActivationConflict &&
			currentHead?.revision_id !== record.target_registry.id
		) {
			const abandoning = await beginAbandonActivation(
				store,
				record,
				error.message,
			)
			if (abandoning) {
				try {
					await runControl.resume(
						record.affected_lens_ids,
						currentHead?.revision_id ?? record.base_registry_revision_id,
					)
				} catch (publicationError) {
					return {
						status: 'recovery-required',
						activation_id: record.id,
						registry_revision_id:
							currentHead?.revision_id ?? record.base_registry_revision_id,
						error: errorMessage(publicationError),
					}
				}
				if (!(await finishAbandonActivation(store, record))) {
					return {
						status: 'recovery-required',
						activation_id: record.id,
						registry_revision_id:
							currentHead?.revision_id ?? record.base_registry_revision_id,
						error: 'activation abandonment could not be finalized',
					}
				}
				return { status: 'conflict', reason: error.reason }
			}
		}
		return {
			status: 'recovery-required',
			activation_id: record.id,
			registry_revision_id:
				currentHead?.revision_id ?? record.base_registry_revision_id,
			error: errorMessage(error),
		}
	}
}

export async function pruneEvolutionStages(
	store: BrainStore,
	input: EvolutionStageRetentionInput,
): Promise<EvolutionStageRetentionResult> {
	if (!validRevision(input.max_terminal_stages)) {
		throw new Error(
			'max_terminal_stages must be a finite nonnegative safe integer',
		)
	}
	const candidates = await store.runAtomic((atomic) => {
		const terminal = atomic.evolutionStages
			.list()
			.filter(
				(stage) => stage.status === 'consumed' || stage.status === 'abandoned',
			)
			.sort((left, right) => {
				const byTime = right.updated_at.localeCompare(left.updated_at)
				return byTime === 0 ? right.id.localeCompare(left.id) : byTime
			})
		return terminal.slice(input.max_terminal_stages)
	})
	const registryPhysicalIds = new Set(
		(await store.registryRevisions.list()).flatMap((revision) =>
			revision.lenses.map((lens) => lens.physical_store_id),
		),
	)
	for (const stage of candidates) {
		if (
			stage.status === 'abandoned' &&
			!registryPhysicalIds.has(stage.physical_store_id)
		)
			await clearNeuronStore(store.getNeuronStore(stage.physical_store_id))
	}
	const deletedStageIds = await store.runAtomic((atomic) => {
		const ids: string[] = []
		const retainedPhysicalIds = new Set(
			atomic.registryRevisions
				.list()
				.flatMap((revision) =>
					revision.lenses.map((lens) => lens.physical_store_id),
				),
		)
		for (const candidate of candidates) {
			const current = atomic.evolutionStages.get(candidate.id)
			if (
				!current ||
				(current.status !== 'consumed' && current.status !== 'abandoned') ||
				(current.status === 'abandoned' &&
					retainedPhysicalIds.has(current.physical_store_id))
			)
				continue
			atomic.evolutionStages.delete(current.id)
			ids.push(current.id)
		}
		return ids
	})
	return { deleted_stage_ids: deletedStageIds }
}
