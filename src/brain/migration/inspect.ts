import { createHash } from 'node:crypto'
import type { EvolutionLensDefinition } from '../evolution/contracts'
import type {
	BrainNeuronRecord,
	NeuronStoreSnapshot,
	StateRecord,
	UnderstandingRecord,
} from '../../stores'
import type {
	LegacyMigrationInspectInput,
	LegacyMigrationInspectionResult,
	LegacyMigrationIssue,
	LegacyMigrationPlan,
	LegacyMigrationTarget,
	LegacyV006BrainSnapshot,
	LegacyV006MigrationSource,
	LegacyV006NeuronSnapshot,
} from './contracts'

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object') {
		const result = Object.create(null) as Record<string, unknown>
		for (const key of Object.keys(value).sort()) {
			const entry = (value as Record<string, unknown>)[key]
			if (entry !== undefined) {
				Object.defineProperty(result, key, {
					value: canonical(entry),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
		}
		return result
	}
	return value
}

export function migrationDigest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value)
	return (
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === value
	)
}

function stateValue(records: readonly StateRecord[], id: string): unknown {
	return records.find((record) => record.id === id)?.value
}

function recordIssue(
	issues: LegacyMigrationIssue[],
	message: string,
	lensId?: string,
): void {
	issues.push({
		code: 'invalid-legacy-record',
		message,
		...(lensId === undefined ? {} : { lensId }),
	})
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function validNumber(value: unknown, minimum: number, maximum: number): boolean {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= minimum &&
		value <= maximum
	)
}

function validateUniqueIds(
	records: readonly { id: string }[],
	name: string,
	issues: LegacyMigrationIssue[],
	lensId?: string,
): void {
	if (
		records.some(({ id }) => !nonEmptyString(id)) ||
		new Set(records.map(({ id }) => id)).size !== records.length
	) recordIssue(issues, `${name} ids must be non-empty and unique`, lensId)
}

function validListItem(record: LegacyV006NeuronSnapshot['understanding'][number]): boolean {
	if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return false
	const item = record.data as Record<string, unknown>
	if (
		item.id !== record.id || !item.data || typeof item.data !== 'object' ||
		Array.isArray(item.data) || !item.metadata || typeof item.metadata !== 'object' ||
		Array.isArray(item.metadata)
	) return false
	const metadata = item.metadata as Record<string, unknown>
	return (
		validNumber(metadata.confidence, 0, 1) &&
		Number.isSafeInteger(metadata.touchCount) &&
		(metadata.touchCount as number) >= 0 &&
		nonEmptyString(metadata.firstSeen) && validTimestamp(metadata.firstSeen) &&
		nonEmptyString(metadata.lastUpdated) && validTimestamp(metadata.lastUpdated) &&
		Array.isArray(metadata.signals) &&
		metadata.signals.every(nonEmptyString)
	)
}

function validateNeuronRecords(
	type: string,
	snapshot: LegacyV006NeuronSnapshot,
	issues: LegacyMigrationIssue[],
	lensId: string,
): void {
	validateUniqueIds(snapshot.state, 'legacy neuron state', issues, lensId)
	validateUniqueIds(snapshot.observations, 'legacy observations', issues, lensId)
	validateUniqueIds(snapshot.understanding, 'legacy understanding', issues, lensId)
	validateUniqueIds(snapshot.evolution, 'legacy neuron evolution', issues, lensId)
	for (const record of snapshot.state) {
		if (!validTimestamp(record.updated_at)) {
			recordIssue(issues, `legacy state ${record.id} has an invalid timestamp`, lensId)
		}
	}
	for (const record of snapshot.observations) {
		if (
			!validNumber(record.metadata_importance, 0, 1) ||
			!Number.isSafeInteger(record.metadata_tokens) || record.metadata_tokens < 0 ||
			(record.metadata_status !== 'pending' && record.metadata_status !== 'processed') ||
			!validTimestamp(record.metadata_created_at)
		) recordIssue(issues, `legacy observation ${record.id} is invalid`, lensId)
	}
	for (const record of snapshot.understanding) {
		if (
			!validNumber(record.metadata_confidence, 0, 1) ||
			!validTimestamp(record.metadata_created_at) ||
			!validTimestamp(record.metadata_updated_at) ||
			(type === 'text' && typeof record.data !== 'string') ||
			(type === 'list' && !validListItem(record))
		) recordIssue(issues, `legacy understanding ${record.id} is invalid`, lensId)
	}
	for (const record of snapshot.evolution) {
		if (
			!nonEmptyString(record.summary) ||
			(record.reasoning !== undefined && typeof record.reasoning !== 'string') ||
			!['routine', 'notable', 'critical'].includes(record.significance) ||
			!validTimestamp(record.created_at)
		) recordIssue(issues, `legacy neuron evolution ${record.id} is invalid`, lensId)
	}
}

function validateBrainRecords(
	source: LegacyV006BrainSnapshot,
	issues: LegacyMigrationIssue[],
): void {
	validateUniqueIds(source.state, 'legacy Brain state', issues)
	validateUniqueIds(source.neurons, 'legacy Brain neurons', issues)
	validateUniqueIds(source.internalNeurons, 'legacy Brain internal neurons', issues)
	validateUniqueIds(source.evolution, 'legacy Brain evolution', issues)
	validateUniqueIds(source.dismissedBatches, 'legacy dismissed batches', issues)
	const allNeuronIds = [
		...source.neurons.map(({ id }) => id),
		...source.internalNeurons.map(({ id }) => id),
	]
	if (new Set(allNeuronIds).size !== allNeuronIds.length) {
		recordIssue(issues, 'legacy external and internal neuron ids must be distinct')
	}
	for (const record of source.state) {
		if (!validTimestamp(record.updated_at)) {
			recordIssue(issues, `legacy Brain state ${record.id} has an invalid timestamp`)
		}
	}
	for (const record of [...source.neurons, ...source.internalNeurons]) {
		if (
			!nonEmptyString(record.type) ||
			(record.status !== undefined && record.status !== 'active' && record.status !== 'inactive')
		) recordIssue(issues, `legacy Brain neuron ${record.id} is invalid`, record.id)
	}
	for (const record of source.evolution) {
		if (!nonEmptyString(record.source) || !validTimestamp(record.created_at)) {
			recordIssue(issues, `legacy Brain evolution ${record.id} is invalid`)
		}
	}
	for (const record of source.dismissedBatches) {
		if (
			!validTimestamp(record.timestamp) ||
			!Number.isSafeInteger(record.retryCount) || record.retryCount < 0 ||
			!Array.isArray(record.gaps) || !record.gaps.every((gap) => typeof gap === 'string')
		) recordIssue(issues, `legacy dismissed batch ${record.id} is invalid`)
	}
	const sourceLensIds = source.lenses.map(({ record }) => record.id)
	if (
		new Set(sourceLensIds).size !== sourceLensIds.length ||
		sourceLensIds.length !== allNeuronIds.length ||
		allNeuronIds.some((id) => !sourceLensIds.includes(id))
	) recordIssue(issues, 'legacy Brain lens stores do not match its neuron records')
}

function validateStateCompatibility(
	input: LegacyMigrationInspectInput,
	record: BrainNeuronRecord,
	state: readonly StateRecord[],
	issues: LegacyMigrationIssue[],
): void {
	const models = stateValue(state, 'models')
	if (!models || typeof models !== 'object' || Array.isArray(models)) {
		recordIssue(issues, 'legacy neuron model slots are missing or invalid', record.id)
	} else {
		for (const [slot, reference] of Object.entries(models)) {
			const message = input.compatibility.validateModelReference({
				lensId: record.id,
				slot,
				reference: structuredClone(reference),
			})
			if (message) {
				issues.push({
					code: 'unavailable-model-runtime',
					message,
					lensId: record.id,
				})
			}
		}
	}
	for (const [kind, key] of [
		['observation', 'observation_schema'],
		['understanding', 'understanding_schema'],
	] as const) {
		const schema = stateValue(state, key)
		const message = input.compatibility.validateSchema({
			lensId: record.id,
			lensType: record.type,
			kind,
			schema: structuredClone(schema),
		})
		if (message) {
			issues.push({
				code: 'incompatible-schema',
				message,
				lensId: record.id,
			})
		}
	}
}

function validateBrainModels(
	input: LegacyMigrationInspectInput,
	state: readonly { id: string; value: unknown }[],
	issues: LegacyMigrationIssue[],
): void {
	const models = state.find((record) => record.id === 'models')?.value
	if (!models || typeof models !== 'object' || Array.isArray(models)) {
		recordIssue(issues, 'legacy Brain model slots are missing or invalid')
		return
	}
	for (const [slot, reference] of Object.entries(models)) {
		const message = input.compatibility.validateModelReference({
			slot,
			reference: structuredClone(reference),
		})
		if (message) {
			issues.push({ code: 'unavailable-model-runtime', message })
		}
	}
}

function validateLensDefinition(
	record: BrainNeuronRecord,
	lens: EvolutionLensDefinition,
	input: LegacyMigrationInspectInput,
	issues: LegacyMigrationIssue[],
): void {
	if (lens.id !== record.id || lens.type !== record.type) {
		recordIssue(
			issues,
			'legacy lens mapping changed the logical id or memory type',
			record.id,
		)
	}
	if (!input.compatibility.hasRecipe({ reference: lens.recipe, memoryType: lens.type })) {
		issues.push({
			code: 'unavailable-recipe',
			message: `recipe ${lens.recipe.id}@${lens.recipe.version} is unavailable for ${lens.type}`,
			lensId: record.id,
		})
	}
}

function migratedUnderstanding(
	type: string,
	records: LegacyV006NeuronSnapshot['understanding'],
): UnderstandingRecord[] {
	return records.map((record) => ({
		...record,
		metadata_confidence_provenance:
			type === 'list' ? 'legacy-touch-count' : 'legacy-default',
	}))
}

function migratedSnapshot(
	type: string,
	source: LegacyV006NeuronSnapshot,
	input: LegacyMigrationInspectInput,
	createdAt: string,
): NeuronStoreSnapshot {
	return structuredClone({
		observations: source.observations,
		understanding: migratedUnderstanding(type, source.understanding),
		evolution: source.evolution,
		state: source.state,
		learningHistory: [],
		memoryChanges: [],
		pendingWork: [],
		pendingInputs: [],
		processedInputs: [],
		outbox: [],
		learningAttempts: [],
		learningRevisions: [{
			id: 'current',
			memory_revision: input.revisions.initialMemoryRevision,
			config_revision: input.revisions.initialConfigRevision,
			updated_at: createdAt,
		}],
	})
}

function snapshotRecordCount(snapshot: LegacyV006NeuronSnapshot): number {
	return (
		snapshot.state.length +
		snapshot.observations.length +
		snapshot.understanding.length +
		snapshot.evolution.length
	)
}

async function targetFor(
	input: LegacyMigrationInspectInput,
	record: BrainNeuronRecord,
	internal: boolean,
	source: LegacyV006NeuronSnapshot,
	createdAt: string,
	issues: LegacyMigrationIssue[],
): Promise<LegacyMigrationTarget | undefined> {
	if (record.type !== 'text' && record.type !== 'list') {
		issues.push({
			code: 'unsupported-lens-type',
			message: `legacy lens type ${record.type} is unsupported`,
			lensId: record.id,
		})
		return undefined
	}
	if (snapshotRecordCount(source) > input.bounds.maxRecordsPerLens) {
		issues.push({
			code: 'bounds-exceeded',
			message: 'legacy lens exceeds the configured record bound',
			lensId: record.id,
		})
	}
	validateNeuronRecords(record.type, source, issues, record.id)
	const serialized = JSON.stringify(source)
	if (serialized.length > input.bounds.maxSnapshotChars) {
		issues.push({
			code: 'bounds-exceeded',
			message: 'legacy lens exceeds the configured serialized-size bound',
			lensId: record.id,
		})
	}
	validateStateCompatibility(input, record, source.state, issues)
	let lens: EvolutionLensDefinition
	try {
		lens = structuredClone(
			await input.compatibility.buildLens({
				record: structuredClone(record),
				state: structuredClone(source.state),
			}),
		)
	} catch (error) {
		recordIssue(
			issues,
			`legacy lens mapping failed: ${error instanceof Error ? error.message : String(error)}`,
			record.id,
		)
		return undefined
	}
	validateLensDefinition(record, lens, input, issues)
	const physicalStoreId = input.ids.targetPhysicalStoreIds[record.id]
	if (!physicalStoreId) {
		recordIssue(issues, 'target physical store id is missing', record.id)
		return undefined
	}
	if (internal && physicalStoreId !== record.id) {
		recordIssue(
			issues,
			'internal neuron physical store id must preserve its logical id',
			record.id,
		)
	}
	const snapshot = migratedSnapshot(record.type, source, input, createdAt)
	return {
		lensId: record.id,
		internal,
		physicalStoreId,
		lens,
		snapshot,
		snapshotDigest: migrationDigest(snapshot),
	}
}

function validateInput(input: LegacyMigrationInspectInput): void {
	if (!input.ids.migrationId || !input.ids.journalStateId || !input.source.sourceId) {
		throw new Error('migration, journal, and source ids are required')
	}
	if (
		!validLimit(input.bounds.maxLenses) ||
		!validLimit(input.bounds.maxBrainRecords) ||
		!validLimit(input.bounds.maxBrainChars) ||
		!validLimit(input.bounds.maxRecordsPerLens) ||
		!validLimit(input.bounds.maxSnapshotChars) ||
		!validLimit(input.bounds.maxDismissedBatches)
	) throw new Error('migration bounds must be positive safe integers')
	if (
		!validRevision(input.revisions.initialMemoryRevision) ||
		!validRevision(input.revisions.initialConfigRevision)
	) throw new Error('initial revisions must be nonnegative safe integers')
}

function planIntent(plan: Omit<LegacyMigrationPlan, 'intentDigest'>): unknown {
	return plan
}

export async function inspectLegacyV006Migration(
	input: LegacyMigrationInspectInput,
): Promise<LegacyMigrationInspectionResult> {
	validateInput(input)
	const issues: LegacyMigrationIssue[] = []
	if (input.source.declaredVersion !== '0.0.6') {
		issues.push({
			code: 'unsupported-version',
			message: `declared legacy version ${input.source.declaredVersion} is unsupported`,
		})
	}
	if (!['memory', 'sqlite-node', 'sqlite-bun'].includes(input.source.storeKind)) {
		issues.push({
			code: 'unsupported-store',
			message: `legacy store kind ${String(input.source.storeKind)} is unsupported`,
		})
	}
	const createdAt = input.clock.now()
	if (!validTimestamp(createdAt)) {
		throw new Error('migration clock must return a normalized UTC timestamp')
	}
	const sourceSnapshot = await input.source.read()
	const sourceFingerprint = migrationDigest(sourceSnapshot)
	const targets: LegacyMigrationTarget[] = []
	let brain: LegacyMigrationPlan['brain']

	if (input.source.kind === 'neuron') {
		const record: BrainNeuronRecord = {
			id: input.source.lensId,
			type: input.source.lensType,
			status: 'active',
		}
		const target = await targetFor(
			input,
			record,
			false,
			sourceSnapshot as LegacyV006NeuronSnapshot,
			createdAt,
			issues,
		)
		if (target) targets.push(target)
	} else {
		const source = sourceSnapshot as LegacyV006BrainSnapshot
		validateBrainRecords(source, issues)
		validateBrainModels(input, source.state, issues)
		const brainRecordCount =
			source.state.length + source.neurons.length + source.internalNeurons.length +
			source.evolution.length + source.dismissedBatches.length
		if (brainRecordCount > input.bounds.maxBrainRecords) {
			issues.push({
				code: 'bounds-exceeded',
				message: 'legacy Brain exceeds the configured record bound',
			})
		}
		if (JSON.stringify(source).length > input.bounds.maxBrainChars) {
			issues.push({
				code: 'bounds-exceeded',
				message: 'legacy Brain exceeds the configured serialized-size bound',
			})
		}
		if (source.lenses.length > input.bounds.maxLenses) {
			issues.push({
				code: 'bounds-exceeded',
				message: 'legacy Brain exceeds the configured lens bound',
			})
		}
		if (source.dismissedBatches.length > input.bounds.maxDismissedBatches) {
			issues.push({
				code: 'bounds-exceeded',
				message: 'legacy Brain exceeds the configured dismissed-work bound',
			})
		}
		for (const batch of source.dismissedBatches) {
			if (batch.status !== 'pending' && batch.status !== 'retried') {
				issues.push({
					code: 'unknown-dismissed-status',
					message: `dismissed batch ${batch.id} has unknown status ${batch.status}`,
				})
			}
		}
		for (const sourceLens of source.lenses) {
			const target = await targetFor(
				input,
				sourceLens.record,
				sourceLens.internal,
				sourceLens.store,
				createdAt,
				issues,
			)
			if (target) targets.push(target)
		}
		if (source.state.some((record) => record.id === input.ids.journalStateId)) {
			recordIssue(issues, 'migration journal state id collides with legacy Brain state')
		}
		brain = structuredClone({
			state: source.state,
			neurons: source.neurons,
			internalNeurons: source.internalNeurons,
			evolution: source.evolution,
			dismissedBatches: source.dismissedBatches,
		})
		if (
			!input.ids.targetRegistryRevisionId ||
			!validRevision(input.ids.targetRegistryRevision ?? Number.NaN)
		) {
			recordIssue(issues, 'Brain migration requires a target registry revision id and revision')
		}
	}
	if (
		input.source.kind === 'neuron' &&
		(sourceSnapshot as LegacyV006NeuronSnapshot).state.some(
			(record) => record.id === input.ids.journalStateId,
		)
	) {
		recordIssue(issues, 'migration journal state id collides with legacy neuron state')
	}
	const logicalIds = targets.map(({ lensId }) => lensId)
	if (new Set(logicalIds).size !== logicalIds.length) {
		recordIssue(issues, 'legacy lens ids must be unique')
	}

	const physicalIds = targets.map(({ physicalStoreId }) => physicalStoreId)
	if (new Set(physicalIds).size !== physicalIds.length) {
		recordIssue(issues, 'target physical store ids must be unique')
	}
	if (issues.length > 0) return { status: 'incompatible', issues }

	const withoutDigest: Omit<LegacyMigrationPlan, 'intentDigest'> = {
		kind: input.source.kind,
		migrationId: input.ids.migrationId,
		journalStateId: input.ids.journalStateId,
		sourceId: input.source.sourceId,
		sourceStoreKind: input.source.storeKind,
		sourceVersion: '0.0.6',
		sourceFingerprint,
		createdAt,
		revisions: structuredClone(input.revisions),
		...(input.source.kind === 'brain'
			? {
					targetRegistryRevisionId: input.ids.targetRegistryRevisionId,
					targetRegistryRevision: input.ids.targetRegistryRevision,
				}
			: {}),
		targets,
		...(brain ? { brain } : {}),
	}
	return {
		status: 'ready',
		plan: {
			...withoutDigest,
			intentDigest: migrationDigest(planIntent(withoutDigest)),
		},
	}
}

export async function legacySourceFingerprint(
	source: LegacyV006MigrationSource,
): Promise<string> {
	return migrationDigest(await source.read())
}
