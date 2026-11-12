import type {
	AtomicBrainStore,
	AtomicCollection,
	AtomicNeuronStore,
	BrainRegistryRevisionRecord,
	BrainStateRecord,
	BrainStore,
	NeuronStore,
	NeuronStoreSnapshot,
	StateRecord,
} from '../../stores'
import type {
	LegacyBrainMigrationExecutionInput,
	LegacyMigrationExecutionResult,
	LegacyMigrationPlan,
	LegacyMigrationTarget,
	LegacyNeuronMigrationExecutionInput,
} from './contracts'
import { legacySourceFingerprint, migrationDigest } from './inspect'

interface MigrationJournalTarget {
	lensId: string
	physicalStoreId: string
	snapshotDigest: string
	status: 'pending' | 'ready'
}

interface MigrationJournal {
	kind: 'adapt-v2-legacy-migration'
	version: 1
	migrationId: string
	intentDigest: string
	sourceId: string
	sourceFingerprint: string
	migrationKind: 'brain' | 'neuron'
	status: 'preparing' | 'completed'
	targetRegistryRevisionId?: string
	targets: MigrationJournalTarget[]
	createdAt: string
	updatedAt: string
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value)
	return (
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === value
	)
}

function planDigest(plan: LegacyMigrationPlan): string {
	const { intentDigest: _intentDigest, ...intent } = plan
	return migrationDigest(intent)
}

function journalFor(
	plan: LegacyMigrationPlan,
	updatedAt: string,
): MigrationJournal {
	return {
		kind: 'adapt-v2-legacy-migration',
		version: 1,
		migrationId: plan.migrationId,
		intentDigest: plan.intentDigest,
		sourceId: plan.sourceId,
		sourceFingerprint: plan.sourceFingerprint,
		migrationKind: plan.kind,
		status: 'preparing',
		...(plan.targetRegistryRevisionId
			? { targetRegistryRevisionId: plan.targetRegistryRevisionId }
			: {}),
		targets: plan.targets.map((target) => ({
			lensId: target.lensId,
			physicalStoreId: target.physicalStoreId,
			snapshotDigest: target.snapshotDigest,
			status: 'pending',
		})),
		createdAt: plan.createdAt,
		updatedAt,
	}
}

function parseJournal(
	record: StateRecord | BrainStateRecord | undefined,
): MigrationJournal | undefined {
	if (!record) return undefined
	const value = record.value as Partial<MigrationJournal> | undefined
	if (
		!value ||
		value.kind !== 'adapt-v2-legacy-migration' ||
		value.version !== 1 ||
		typeof value.migrationId !== 'string' ||
		typeof value.intentDigest !== 'string' ||
		!Array.isArray(value.targets) ||
		(value.status !== 'preparing' && value.status !== 'completed') ||
		value.targets.some(
			(target) =>
				!target ||
				typeof target !== 'object' ||
				typeof target.lensId !== 'string' ||
				typeof target.physicalStoreId !== 'string' ||
				typeof target.snapshotDigest !== 'string' ||
				(target.status !== 'pending' && target.status !== 'ready'),
		)
	)
		throw new Error('migration journal is invalid or unsupported')
	return structuredClone(value as MigrationJournal)
}

function sameJournal(
	journal: MigrationJournal,
	plan: LegacyMigrationPlan,
): boolean {
	return (
		journal.migrationId === plan.migrationId &&
		journal.intentDigest === plan.intentDigest &&
		journal.sourceId === plan.sourceId &&
		journal.sourceFingerprint === plan.sourceFingerprint &&
		journal.migrationKind === plan.kind
	)
}

function writeRecords<T extends { id: string }>(
	collection: AtomicCollection<T>,
	records: readonly T[],
): void {
	collection.clear()
	for (const record of records) collection.add(structuredClone(record))
}

function writeNeuronSnapshot(
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

function atomicNeuronSnapshot(
	store: AtomicNeuronStore,
	journalStateId?: string,
): NeuronStoreSnapshot {
	return {
		observations: store.observations.list(),
		understanding: store.understanding.list(),
		evolution: store.evolution.list(),
		state: store.state.list().filter((record) => record.id !== journalStateId),
		learningHistory: store.learningHistory.list(),
		memoryChanges: store.memoryChanges.list(),
		pendingWork: store.pendingWork.list(),
		pendingInputs: store.pendingInputs.list(),
		processedInputs: store.processedInputs.list(),
		outbox: store.outbox.list(),
		learningAttempts: store.learningAttempts.list(),
		learningRevisions: store.learningRevisions.list(),
	}
}

async function readNeuronSnapshot(
	store: NeuronStore,
	journalStateId?: string,
): Promise<NeuronStoreSnapshot> {
	return store.runAtomic((atomic) =>
		atomicNeuronSnapshot(atomic, journalStateId),
	)
}

function snapshotEmpty(snapshot: NeuronStoreSnapshot): boolean {
	return Object.values(snapshot).every((records) => records.length === 0)
}

function updateStateRecord(
	state: AtomicCollection<StateRecord> | AtomicCollection<BrainStateRecord>,
	id: string,
	value: MigrationJournal,
	updatedAt: string,
): void {
	const record = state.get(id)
	if (record) state.update(id, { value, updated_at: updatedAt })
	else state.add({ id, value, updated_at: updatedAt })
}

function requirePlan(
	plan: LegacyMigrationPlan,
	kind: 'brain' | 'neuron',
): LegacyMigrationPlan {
	const snapshot = structuredClone(plan)
	if (snapshot.kind !== kind)
		throw new Error(`migration plan kind must be ${kind}`)
	if (snapshot.intentDigest !== planDigest(snapshot)) {
		throw new Error('migration plan intent digest does not match its contents')
	}
	return snapshot
}

async function requireStableSource(
	source:
		| LegacyBrainMigrationExecutionInput['source']
		| LegacyNeuronMigrationExecutionInput['source'],
	plan: LegacyMigrationPlan,
): Promise<void> {
	if (source.sourceId !== plan.sourceId)
		throw new Error('migration source id changed')
	if ((await legacySourceFingerprint(source)) !== plan.sourceFingerprint) {
		throw new Error('offline legacy source changed after inspection')
	}
}

function brainStoreEmpty(
	store: AtomicBrainStore,
	journalStateId: string,
): boolean {
	return (
		store.state.list().every((record) => record.id === journalStateId) &&
		store.neurons.list().length === 0 &&
		store.internalNeurons.list().length === 0 &&
		store.evolution.list().length === 0 &&
		store.dismissedBatches.list().length === 0 &&
		store.registryHeads.list().length === 0 &&
		store.registryRevisions.list().length === 0 &&
		store.evolutionActivations.list().length === 0 &&
		store.evolutionStages.list().length === 0 &&
		store.memoryMappings.list().length === 0
	)
}

async function beginBrainJournal(
	store: BrainStore,
	plan: LegacyMigrationPlan,
	updatedAt: string,
): Promise<{ journal: MigrationJournal; completed: boolean }> {
	return store.runAtomic((atomic) => {
		const existing = parseJournal(atomic.state.get(plan.journalStateId))
		if (existing) {
			if (!sameJournal(existing, plan))
				throw new Error('migration journal intent conflict')
			return { journal: existing, completed: existing.status === 'completed' }
		}
		if (!brainStoreEmpty(atomic, plan.journalStateId)) {
			throw new Error('target Brain store must be empty before migration')
		}
		const journal = journalFor(plan, updatedAt)
		updateStateRecord(atomic.state, plan.journalStateId, journal, updatedAt)
		return { journal, completed: false }
	})
}

async function verifyCompletedBrain(
	store: BrainStore,
	plan: LegacyMigrationPlan,
): Promise<void> {
	const head = await store.registryHeads.get('current')
	if (head?.revision_id !== plan.targetRegistryRevisionId) {
		throw new Error('completed migration registry head is not authoritative')
	}
	const revision = plan.targetRegistryRevisionId
		? await store.registryRevisions.get(plan.targetRegistryRevisionId)
		: undefined
	if (!revision || revision.revision !== plan.targetRegistryRevision) {
		throw new Error('completed migration registry revision is unavailable')
	}
	if (migrationDigest(revision) !== migrationDigest(registryRevision(plan))) {
		throw new Error('completed migration registry revision changed')
	}
}

async function verifyTargetDigest(
	store: BrainStore,
	target: LegacyMigrationTarget,
): Promise<void> {
	const snapshot = await readNeuronSnapshot(
		store.getNeuronStore(target.physicalStoreId),
	)
	if (migrationDigest(snapshot) !== target.snapshotDigest) {
		throw new Error(
			`target physical store ${target.physicalStoreId} changed during verification`,
		)
	}
}

async function writeBrainTarget(
	store: BrainStore,
	plan: LegacyMigrationPlan,
	target: LegacyMigrationTarget,
	updatedAt: string,
): Promise<MigrationJournal> {
	const targetStore = store.getNeuronStore(target.physicalStoreId)
	await targetStore.runAtomic((atomic) => {
		const existing = atomicNeuronSnapshot(atomic)
		if (snapshotEmpty(existing)) writeNeuronSnapshot(atomic, target.snapshot)
		else if (migrationDigest(existing) !== target.snapshotDigest) {
			throw new Error(
				`target physical store ${target.physicalStoreId} contains different state`,
			)
		}
	})
	const written = await readNeuronSnapshot(targetStore)
	if (migrationDigest(written) !== target.snapshotDigest) {
		throw new Error(
			`target physical store ${target.physicalStoreId} failed verification`,
		)
	}
	return store.runAtomic((atomic) => {
		const current = parseJournal(atomic.state.get(plan.journalStateId))
		if (
			!current ||
			!sameJournal(current, plan) ||
			current.status !== 'preparing'
		) {
			throw new Error('migration journal changed while staging targets')
		}
		const next: MigrationJournal = {
			...current,
			targets: current.targets.map((entry) =>
				entry.lensId === target.lensId ? { ...entry, status: 'ready' } : entry,
			),
			updatedAt,
		}
		updateStateRecord(atomic.state, plan.journalStateId, next, updatedAt)
		return next
	})
}

function registryRevision(
	plan: LegacyMigrationPlan,
): BrainRegistryRevisionRecord {
	if (
		plan.targetRegistryRevisionId === undefined ||
		plan.targetRegistryRevision === undefined
	) {
		throw new Error('Brain migration plan lacks a registry revision')
	}
	return {
		id: plan.targetRegistryRevisionId,
		revision: plan.targetRegistryRevision,
		lenses: plan.targets
			.filter((target) => !target.internal)
			.map((target) => ({
				id: target.lens.id,
				physical_store_id: target.physicalStoreId,
				type: target.lens.type,
				config: structuredClone(target.lens),
				dependencies: [...target.lens.dependencies],
			})),
		created_at: plan.createdAt,
	}
}

function publishBrain(
	store: AtomicBrainStore,
	plan: LegacyMigrationPlan,
	journal: MigrationJournal,
	updatedAt: string,
): void {
	const brain = plan.brain
	if (!brain) throw new Error('Brain migration plan lacks Brain records')
	const current = parseJournal(store.state.get(plan.journalStateId))
	if (
		!current ||
		!sameJournal(current, plan) ||
		current.status !== 'preparing'
	) {
		throw new Error('migration journal changed before publication')
	}
	if (!brainStoreEmpty(store, plan.journalStateId)) {
		throw new Error(
			'target Brain store changed while migration targets were staged',
		)
	}
	if (journal.targets.some((target) => target.status !== 'ready')) {
		throw new Error('migration targets are not all ready')
	}
	writeRecords(store.state, brain.state)
	writeRecords(store.neurons, brain.neurons)
	writeRecords(store.internalNeurons, brain.internalNeurons)
	writeRecords(store.evolution, brain.evolution)
	writeRecords(store.dismissedBatches, brain.dismissedBatches)
	const revision = registryRevision(plan)
	writeRecords(store.registryRevisions, [revision])
	writeRecords(store.registryHeads, [
		{
			id: 'current',
			revision_id: revision.id,
			revision: revision.revision,
			updated_at: updatedAt,
		},
	])
	const completed: MigrationJournal = {
		...journal,
		status: 'completed',
		updatedAt,
	}
	updateStateRecord(store.state, plan.journalStateId, completed, updatedAt)
}

export async function executeLegacyV006BrainMigration(
	input: LegacyBrainMigrationExecutionInput,
): Promise<LegacyMigrationExecutionResult> {
	try {
		const plan = requirePlan(input.plan, 'brain')
		const source = input.source
		const targetStore = input.target
		const targetId = input.targetId
		const options = input.options
		const clock = input.clock
		if (targetId === plan.sourceId)
			throw new Error('source and target stores must be distinct')
		await input.assertTargetExclusive()
		await requireStableSource(source, plan)
		const updatedAt = clock.now()
		if (!validTimestamp(updatedAt))
			throw new Error('migration clock must return a normalized UTC timestamp')
		let { journal, completed } = await beginBrainJournal(
			targetStore,
			plan,
			updatedAt,
		)
		if (completed) {
			await verifyCompletedBrain(targetStore, plan)
			return {
				status: 'completed',
				deduplicated: true,
				registryRevisionId: plan.targetRegistryRevisionId,
			}
		}
		await options?.onStage?.('after-journal')
		for (const target of plan.targets) {
			journal = await writeBrainTarget(targetStore, plan, target, updatedAt)
			await options?.verifier?.verifyTarget({
				plan: structuredClone(plan),
				target: structuredClone(target),
				store: targetStore.getNeuronStore(target.physicalStoreId),
			})
			await verifyTargetDigest(targetStore, target)
			await options?.onStage?.('after-target-write', target.lensId)
		}
		await options?.onStage?.('before-publish')
		for (const target of plan.targets)
			await verifyTargetDigest(targetStore, target)
		await targetStore.runAtomic((atomic) =>
			publishBrain(atomic, plan, journal, updatedAt),
		)
		await options?.onStage?.('after-publish')
		return {
			status: 'completed',
			deduplicated: false,
			registryRevisionId: plan.targetRegistryRevisionId,
		}
	} catch (error) {
		return { status: 'failure', error }
	}
}

export async function executeLegacyV006NeuronMigration(
	input: LegacyNeuronMigrationExecutionInput,
): Promise<LegacyMigrationExecutionResult> {
	try {
		const plan = requirePlan(input.plan, 'neuron')
		const source = input.source
		const targetStore = input.target
		const targetId = input.targetId
		const options = input.options
		const clock = input.clock
		if (targetId === plan.sourceId)
			throw new Error('source and target stores must be distinct')
		if (plan.targets.length !== 1)
			throw new Error('standalone migration requires exactly one target')
		await input.assertTargetExclusive()
		await requireStableSource(source, plan)
		const updatedAt = clock.now()
		if (!validTimestamp(updatedAt))
			throw new Error('migration clock must return a normalized UTC timestamp')
		const target = plan.targets[0]
		if (!target) throw new Error('standalone migration target is missing')
		const initial = await targetStore.runAtomic((atomic) => {
			const existing = parseJournal(atomic.state.get(plan.journalStateId))
			if (existing) {
				if (!sameJournal(existing, plan))
					throw new Error('migration journal intent conflict')
				return existing
			}
			const snapshot = atomicNeuronSnapshot(atomic)
			if (!snapshotEmpty(snapshot))
				throw new Error('target neuron store must be empty before migration')
			const journal = journalFor(plan, updatedAt)
			updateStateRecord(atomic.state, plan.journalStateId, journal, updatedAt)
			return journal
		})
		if (initial.status === 'completed') {
			return { status: 'completed', deduplicated: true }
		}
		await options?.onStage?.('after-journal')
		await targetStore.runAtomic((atomic) => {
			const journal = parseJournal(atomic.state.get(plan.journalStateId))
			if (!journal || !sameJournal(journal, plan))
				throw new Error('migration journal changed before standalone write')
			const existing = atomicNeuronSnapshot(atomic, plan.journalStateId)
			if (snapshotEmpty(existing)) writeNeuronSnapshot(atomic, target.snapshot)
			else if (migrationDigest(existing) !== target.snapshotDigest) {
				throw new Error('standalone migration target contains different state')
			}
			const ready: MigrationJournal = {
				...journal,
				targets: journal.targets.map((entry) => ({
					...entry,
					status: 'ready',
				})),
				updatedAt,
			}
			updateStateRecord(atomic.state, plan.journalStateId, ready, updatedAt)
		})
		await options?.onStage?.('after-target-write', target.lensId)
		await options?.verifier?.verifyTarget({
			plan: structuredClone(plan),
			target: structuredClone(target),
			store: targetStore,
		})
		await targetStore.runAtomic((atomic) => {
			const journal = parseJournal(atomic.state.get(plan.journalStateId))
			if (
				!journal ||
				!sameJournal(journal, plan) ||
				journal.targets.some((entry) => entry.status !== 'ready')
			)
				throw new Error(
					'migration journal changed before standalone completion',
				)
			const current = atomicNeuronSnapshot(atomic, plan.journalStateId)
			if (migrationDigest(current) !== target.snapshotDigest) {
				throw new Error(
					'standalone migration target changed during verification',
				)
			}
			const completed: MigrationJournal = {
				...journal,
				status: 'completed',
				updatedAt,
			}
			updateStateRecord(atomic.state, plan.journalStateId, completed, updatedAt)
		})
		return { status: 'completed', deduplicated: false }
	} catch (error) {
		return { status: 'failure', error }
	}
}

export function migrationFailureMessage(
	result: LegacyMigrationExecutionResult,
): string | undefined {
	return result.status === 'failure' ? errorMessage(result.error) : undefined
}
