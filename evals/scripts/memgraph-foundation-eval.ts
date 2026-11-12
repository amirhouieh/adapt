/**
 * Records a fixed mechanical run through the production Memgraph graph store.
 * It calls no model and performs no grading, assertions, or expected-output
 * comparisons. Reviewers assess the exact supplied inputs, returned values,
 * injected failure, and store inspections saved in the artifact directory.
 *
 * Run:
 *   ./node_modules/.bin/tsx evals/scripts/memgraph-foundation-eval.ts <config-path>
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'

import {
	commitGraphRecipeResult,
	type CommitGraphRecipeInput,
	type GraphLensSchema,
} from '../../src/neurons/graph'
import {
	createMemgraphGraphStore,
	type MemgraphGraphStore,
	type MemgraphGraphStoreOptions,
} from '../../src/stores/memgraph'
import type { PendingWorkRecord } from '../../src/stores/types'

interface EvalConfig {
	readonly connection: MemgraphGraphStoreOptions['connection']
	readonly policy: MemgraphGraphStoreOptions['policy']
	readonly datasetPath: string
	readonly artifactRoot: string
	readonly runId: string
	readonly failure: {
		readonly stage: 'after-graph'
		readonly message: string
	}
	readonly inspection: {
		readonly maxRecordsPerNamespace: number
		readonly maxSerializedChars: number
	}
	readonly fullContext: {
		readonly maxEntities: number
		readonly maxEdges: number
		readonly maxSerializedChars: number
	}
	readonly boundedContext: {
		readonly maxEntities: number
		readonly maxEdges: number
		readonly maxSerializedChars: number
	}
	readonly fullTraversal: {
		readonly maxDepth: number
		readonly maxEntities: number
		readonly maxEdges: number
		readonly maxSerializedChars: number
	}
	readonly boundedTraversal: {
		readonly maxDepth: number
		readonly maxEntities: number
		readonly maxEdges: number
		readonly maxSerializedChars: number
	}
	readonly outbox: {
		readonly consumerId: string
		readonly firstLeaseToken: string
		readonly secondLeaseToken: string
		readonly claimAt: string
		readonly firstLeaseExpiresAt: string
		readonly firstSettledAt: string
		readonly retryAt: string
		readonly reclaimAt: string
		readonly secondLeaseExpiresAt: string
		readonly finalSettledAt: string
		readonly retryError: string
		readonly limit: number
	}
}

type SuppliedCommit = Omit<CommitGraphRecipeInput, 'lensId' | 'schema'>

interface EvalDataset {
	readonly provenance: string
	readonly lensId: string
	readonly schema: GraphLensSchema
	readonly initializedAt: string
	readonly partial: {
		readonly work: PendingWorkRecord
		readonly commit: SuppliedCommit
	}
	readonly correction: {
		readonly commit: SuppliedCommit
	}
	readonly rollbackRetry: {
		readonly work: PendingWorkRecord
		readonly commit: SuppliedCommit
		readonly conflictingChangeSummary: string
	}
	readonly reads: {
		readonly mentions: readonly {
			readonly id: string
			readonly label: string
			readonly entityType: string
		}[]
		readonly inputIds: readonly string[]
		readonly startEntityIds: readonly string[]
		readonly relationIds: readonly string[]
		readonly direction: 'outgoing' | 'incoming' | 'both'
	}
	readonly outbox: {
		readonly deliveredId: string
		readonly retriedId: string
		readonly additionalDeliveredId: string
	}
	readonly schemas: {
		readonly metadataOnly: GraphLensSchema
		readonly incompatible: GraphLensSchema
		readonly conflictingInitialization: GraphLensSchema
		readonly metadataUpdatedAt: string
		readonly incompatibleUpdatedAt: string
	}
}

function exactInspect(value: unknown): string {
	return inspect(value, {
		depth: null,
		maxArrayLength: null,
		maxStringLength: null,
	})
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const suppliedConfigPath = process.argv[2]
if (suppliedConfigPath === undefined) {
	throw new Error('provide a Memgraph foundation eval config path')
}
const configPath = resolve(suppliedConfigPath)
const configRaw = readFileSync(configPath, 'utf8')
const config = JSON.parse(configRaw) as EvalConfig
const datasetPath = resolve(config.datasetPath)
const datasetRaw = readFileSync(datasetPath, 'utf8')
const dataset = JSON.parse(datasetRaw) as EvalDataset
const artifactDirectory = resolve(config.artifactRoot, config.runId)

function storeOptions(
	onCommitStage?: MemgraphGraphStoreOptions['onCommitStage'],
): MemgraphGraphStoreOptions {
	return {
		connection: config.connection,
		policy: config.policy,
		...(onCommitStage === undefined ? {} : { onCommitStage }),
	}
}

function completeCommit(commit: SuppliedCommit): CommitGraphRecipeInput {
	return {
		lensId: dataset.lensId,
		schema: dataset.schema,
		...commit,
	}
}

let store: MemgraphGraphStore | undefined
let injectedFailure: Error | undefined
let failureArmed = false

async function openStore(): Promise<MemgraphGraphStore> {
	const value = createMemgraphGraphStore(storeOptions((stage) => {
		if (failureArmed && stage === config.failure.stage) {
			injectedFailure = new Error(config.failure.message)
			throw injectedFailure
		}
	}))
	await value.initialize()
	return value
}

async function reconnect(): Promise<void> {
	await store?.close()
	store = await openStore()
}

async function main(): Promise<void> {
	if (existsSync(artifactDirectory)) {
		throw new Error(`eval artifact directory already exists: ${artifactDirectory}`)
	}
	mkdirSync(artifactDirectory, { recursive: true })
	writeFileSync(resolve(artifactDirectory, 'config.input.raw.json'), configRaw)
	writeFileSync(resolve(artifactDirectory, 'dataset.input.raw.json'), datasetRaw)

	const initializeInput = {
		lensId: dataset.lensId,
		schema: dataset.schema,
		initializedAt: dataset.initializedAt,
	}
	const partialCommit = completeCommit(dataset.partial.commit)
	const correctionCommit = completeCommit(dataset.correction.commit)
	const rollbackCommit = completeCommit(dataset.rollbackRetry.commit)
	const conflictingRollbackCommit: CommitGraphRecipeInput = {
		...rollbackCommit,
		changes: rollbackCommit.changes.map((change, index) =>
			index === 0
				? { ...change, summary: dataset.rollbackRetry.conflictingChangeSummary }
				: change,
		),
	}
	const fullContextInput = {
		lensId: dataset.lensId,
		expectedMemoryRevision: 3,
		expectedConfigRevision: 0,
		mentions: dataset.reads.mentions,
		inputIds: dataset.reads.inputIds,
		...config.fullContext,
	}
	const boundedContextInput = {
		...fullContextInput,
		...config.boundedContext,
	}
	const fullTraversalInput = {
		lensId: dataset.lensId,
		startEntityIds: dataset.reads.startEntityIds,
		relationIds: dataset.reads.relationIds,
		direction: dataset.reads.direction,
		policy: {
			maxDepth: config.fullTraversal.maxDepth,
			maxEntities: config.fullTraversal.maxEntities,
			maxEdges: config.fullTraversal.maxEdges,
		},
		maxSerializedChars: config.fullTraversal.maxSerializedChars,
	}
	const boundedTraversalInput = {
		...fullTraversalInput,
		policy: {
			maxDepth: config.boundedTraversal.maxDepth,
			maxEntities: config.boundedTraversal.maxEntities,
			maxEdges: config.boundedTraversal.maxEdges,
		},
		maxSerializedChars: config.boundedTraversal.maxSerializedChars,
	}
	const firstClaimInput = {
		lensId: dataset.lensId,
		consumer_id: config.outbox.consumerId,
		lease_token: config.outbox.firstLeaseToken,
		now: config.outbox.claimAt,
		lease_expires_at: config.outbox.firstLeaseExpiresAt,
		limit: config.outbox.limit,
	}
	const deliverInput = {
		lensId: dataset.lensId,
		id: dataset.outbox.deliveredId,
		consumer_id: config.outbox.consumerId,
		lease_token: config.outbox.firstLeaseToken,
		outcome: 'delivered' as const,
		settled_at: config.outbox.firstSettledAt,
	}
	const additionalDeliverInput = {
		...deliverInput,
		id: dataset.outbox.additionalDeliveredId,
	}
	const retryInput = {
		lensId: dataset.lensId,
		id: dataset.outbox.retriedId,
		consumer_id: config.outbox.consumerId,
		lease_token: config.outbox.firstLeaseToken,
		outcome: 'retry' as const,
		settled_at: config.outbox.firstSettledAt,
		retry_at: config.outbox.retryAt,
		error: config.outbox.retryError,
	}
	const secondClaimInput = {
		...firstClaimInput,
		lease_token: config.outbox.secondLeaseToken,
		now: config.outbox.reclaimAt,
		lease_expires_at: config.outbox.secondLeaseExpiresAt,
	}
	const finalDeliverInput = {
		...deliverInput,
		id: dataset.outbox.retriedId,
		lease_token: config.outbox.secondLeaseToken,
		settled_at: config.outbox.finalSettledAt,
	}
	const metadataConfigureInput = {
		lensId: dataset.lensId,
		expectedConfigRevision: 0,
		nextConfigRevision: 1,
		schema: dataset.schemas.metadataOnly,
		updatedAt: dataset.schemas.metadataUpdatedAt,
	}
	const incompatibleConfigureInput = {
		lensId: dataset.lensId,
		expectedConfigRevision: 1,
		nextConfigRevision: 2,
		schema: dataset.schemas.incompatible,
		updatedAt: dataset.schemas.incompatibleUpdatedAt,
	}
	writeJson(resolve(artifactDirectory, 'constructed-input.raw.json'), {
		initializeInput,
		partialEnqueue: { lensId: dataset.lensId, work: dataset.partial.work },
		partialCommit,
		correctionCommit,
		rollbackEnqueue: { lensId: dataset.lensId, work: dataset.rollbackRetry.work },
		rollbackCommit,
		conflictingRollbackCommit,
		fullContextInput,
		boundedContextInput,
		fullTraversalInput,
		boundedTraversalInput,
		firstClaimInput,
		deliverInput,
		additionalDeliverInput,
		retryInput,
		secondClaimInput,
		finalDeliverInput,
		metadataConfigureInput,
		incompatibleConfigureInput,
	})

	store = await openStore()
	const initialized = await store.initializeLens(initializeInput)
	const partialEnqueue = await store.enqueue({
		lensId: dataset.lensId,
		work: dataset.partial.work,
	})
	const partialResult = await commitGraphRecipeResult(store, partialCommit)
	const partialDuplicate = await commitGraphRecipeResult(store, partialCommit)
	const residual = await store.getPendingWork(
		dataset.lensId,
		dataset.partial.commit.remainingWork?.id ?? '',
	)
	const afterPartial = await store.inspect(dataset.lensId, config.inspection)
	const correctionResult = await commitGraphRecipeResult(store, correctionCommit)
	const afterCorrection = await store.inspect(dataset.lensId, config.inspection)

	const rollbackEnqueue = await store.enqueue({
		lensId: dataset.lensId,
		work: dataset.rollbackRetry.work,
	})
	failureArmed = true
	const injectedFailureResult = await commitGraphRecipeResult(store, rollbackCommit)
	failureArmed = false
	const afterInjectedFailure = await store.inspect(dataset.lensId, config.inspection)
	const revisionsAfterFailure = await store.getRevisions(dataset.lensId)
	const pendingAfterFailure = await store.getPendingWork(
		dataset.lensId,
		dataset.rollbackRetry.work.id,
	)
	const retryResult = await commitGraphRecipeResult(store, rollbackCommit)
	const retryDuplicate = await commitGraphRecipeResult(store, rollbackCommit)
	const fullIntentConflict = await commitGraphRecipeResult(
		store,
		conflictingRollbackCommit,
	)

	await reconnect()
	const revisionsAfterReconnect = await store.getRevisions(dataset.lensId)
	const inspectionAfterReconnect = await store.inspect(
		dataset.lensId,
		config.inspection,
	)
	const fullContext = await store.getLearningContext(
		fullContextInput,
		{ signal: new AbortController().signal },
	)
	const boundedContext = await store.getLearningContext(
		boundedContextInput,
		{ signal: new AbortController().signal },
	)
	const fullTraversal = await store.traverse(
		fullTraversalInput,
		{ signal: new AbortController().signal },
	)
	const boundedTraversal = await store.traverse(
		boundedTraversalInput,
		{ signal: new AbortController().signal },
	)

	const firstClaim = await store.claimOutbox(firstClaimInput)
	const delivered = await store.settleOutbox(deliverInput)
	const additionalDelivered = await store.settleOutbox(additionalDeliverInput)
	const retried = await store.settleOutbox(retryInput)
	const secondClaim = await store.claimOutbox(secondClaimInput)
	const retryDelivered = await store.settleOutbox(finalDeliverInput)
	const afterOutbox = await store.inspect(dataset.lensId, config.inspection)

	const existingSchema = await store.initializeLens(initializeInput)
	const conflictingInitialization = await store.initializeLens({
		...initializeInput,
		schema: dataset.schemas.conflictingInitialization,
	})
	const metadataConfigured = await store.configureLens(metadataConfigureInput)
	const incompatibleConfiguration = await store.configureLens(
		incompatibleConfigureInput,
	)
	const finalRevisions = await store.getRevisions(dataset.lensId)
	const finalInspection = await store.inspect(dataset.lensId, config.inspection)

	const output = {
		initialized,
		partialEnqueue,
		partialResult,
		partialDuplicate,
		residual,
		afterPartial,
		correctionResult,
		afterCorrection,
		rollbackEnqueue,
		injectedFailureResult,
		afterInjectedFailure,
		revisionsAfterFailure,
		pendingAfterFailure,
		retryResult,
		retryDuplicate,
		fullIntentConflict,
		revisionsAfterReconnect,
		inspectionAfterReconnect,
		fullContext,
		boundedContext,
		fullTraversal,
		boundedTraversal,
		firstClaim,
		delivered,
		additionalDelivered,
		retried,
		secondClaim,
		retryDelivered,
		afterOutbox,
		existingSchema,
		conflictingInitialization,
		metadataConfigured,
		incompatibleConfiguration,
		finalRevisions,
		finalInspection,
	}
	writeJson(resolve(artifactDirectory, 'output.raw.json'), output)
	writeFileSync(
		resolve(artifactDirectory, 'output.inspect.txt'),
		`${exactInspect(output)}\n`,
	)
	writeFileSync(
		resolve(artifactDirectory, 'injected-failure.inspect.txt'),
		`${exactInspect(injectedFailure)}\n`,
	)
	writeJson(resolve(artifactDirectory, 'metadata.json'), {
		script: 'evals/scripts/memgraph-foundation-eval.ts',
		configPath,
		datasetPath,
		adapter: 'production MemgraphGraphStore',
		model: null,
		grading: null,
		lensId: dataset.lensId,
		failureStage: config.failure.stage,
	})
	console.log(artifactDirectory)
}

main().catch((error: unknown) => {
	if (existsSync(artifactDirectory)) {
		writeFileSync(
			resolve(artifactDirectory, 'raw-failure.inspect.txt'),
			`${exactInspect(error)}\n`,
		)
	}
	console.error(error)
	process.exitCode = 1
}).finally(async () => {
	try { await store?.close() } catch { /* preserve the primary eval result */ }
})
