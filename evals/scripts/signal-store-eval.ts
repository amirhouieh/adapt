import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspect } from 'node:util'
import {
	createSignalStateStore,
	type EnqueueSignalAssessmentInput,
	type RecordAcceptedSignalInput,
	type SignalProposal,
	type SignalStatePolicy,
} from '../../src/brain/signals'
import { MemoryBrainStore } from '../../src/stores/memory/brain'
import type { BrainStore } from '../../src/stores'

type AdapterConfig =
	| { readonly kind: 'memory'; readonly persistent: false }
	| { readonly kind: 'node-sqlite' | 'bun-sqlite'; readonly persistent: true; readonly databaseFile: string }

interface EvalConfig {
	readonly datasetPath: string
	readonly artifactRoot: string
	readonly runId: string
	readonly adapters: Readonly<Record<string, AdapterConfig>>
	readonly policies: {
		readonly main: SignalStatePolicy
		readonly capacity: SignalStatePolicy
		readonly retention: SignalStatePolicy
	}
}

interface EvalDataset {
	readonly provenance: string
	readonly times: Readonly<Record<string, string>>
	readonly workers: {
		readonly assessment: string
		readonly assessmentLease1: string
		readonly assessmentLease2: string
		readonly assessmentLease3: string
		readonly delivery: string
		readonly deliveryLease1: string
		readonly deliveryLease2: string
		readonly deliveryLease3: string
		readonly claimLimit: number
		readonly assessmentRetryError: string
		readonly deliveryRetryError: string
	}
	readonly primary: {
		readonly assessment: EnqueueSignalAssessmentInput
		readonly conflictingChanges: EnqueueSignalAssessmentInput['scopedChanges']
		readonly signalId: string
		readonly deliveryId: string
		readonly proposal: SignalProposal
	}
	readonly exactReplay: {
		readonly assessmentId: string
		readonly unusedSignalId: string
		readonly unusedDeliveryId: string
	}
	readonly cooldown: {
		readonly assessment: EnqueueSignalAssessmentInput
		readonly signalId: string
		readonly deliveryId: string
		readonly proposal: SignalProposal
	}
	readonly retry: { readonly assessment: EnqueueSignalAssessmentInput }
	readonly capacity: {
		readonly first: EnqueueSignalAssessmentInput
		readonly second: EnqueueSignalAssessmentInput
	}
	readonly retention: {
		readonly acceptedAssessment: EnqueueSignalAssessmentInput
		readonly pendingAssessment: EnqueueSignalAssessmentInput
		readonly signalId: string
		readonly deliveryId: string
		readonly proposal: SignalProposal
	}
}

interface RawOperation {
	readonly sequence: number
	readonly label: string
	readonly input: unknown
	readonly output?: unknown
	readonly failure?: unknown
}

function exact(value: unknown): string {
	return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, breakLength: 100 })
}

async function openStore(adapter: AdapterConfig, databasePath: string | undefined): Promise<BrainStore> {
	if (adapter.kind === 'memory') return new MemoryBrainStore()
	if (databasePath === undefined) throw new Error('persistent adapter requires a database path')
	if (adapter.kind === 'node-sqlite') {
		const { SQLiteBrainStore } = await import('../../src/stores/sqlite/node/brain')
		return new SQLiteBrainStore(databasePath)
	}
	const { SQLiteBrainStore } = await import('../../src/stores/sqlite/bun/brain')
	return new SQLiteBrainStore(databasePath)
}

async function main(): Promise<void> {
	const configPathInput = process.argv[2]
	const adapterName = process.argv[3]
	if (configPathInput === undefined || adapterName === undefined) {
		throw new Error('provide config path and adapter name')
	}
	const configPath = resolve(configPathInput)
	const configRaw = readFileSync(configPath, 'utf8')
	const config = JSON.parse(configRaw) as EvalConfig
	const adapter = config.adapters[adapterName]
	if (adapter === undefined) throw new Error(`unknown supplied adapter: ${adapterName}`)
	const datasetPath = resolve(config.datasetPath)
	const datasetRaw = readFileSync(datasetPath, 'utf8')
	const dataset = JSON.parse(datasetRaw) as EvalDataset
	const startedAt = new Date().toISOString()
	const artifactDirectory = resolve(config.artifactRoot, config.runId, adapterName)
	if (existsSync(artifactDirectory)) throw new Error(`artifact directory already exists: ${artifactDirectory}`)
	mkdirSync(artifactDirectory, { recursive: true })
	writeFileSync(resolve(artifactDirectory, 'config.input.raw.json'), configRaw)
	writeFileSync(resolve(artifactDirectory, 'dataset.input.raw.json'), datasetRaw)

	const databasePath = adapter.persistent ? resolve(artifactDirectory, adapter.databaseFile) : undefined
	let brain = await openStore(adapter, databasePath)
	let mainStore = createSignalStateStore({ store: brain, policy: config.policies.main })
	const operations: RawOperation[] = []
	let sequence = 0
	const capture = async <Result>(label: string, input: unknown, call: () => Promise<Result>): Promise<Result | undefined> => {
		sequence += 1
		const stableInput = structuredClone(input)
		try {
			const output = await call()
			operations.push({ sequence, label, input: stableInput, output })
			return output
		} catch (failure) {
			operations.push({ sequence, label, input: stableInput, failure })
			return undefined
		}
	}
	const time = dataset.times
	const workers = dataset.workers
	const claim = (token: string, now: string, leaseExpiresAt: string) => ({
		consumerId: workers.assessment,
		leaseToken: token,
		now,
		leaseExpiresAt,
		limit: workers.claimLimit,
	})
	const deliveryClaim = (token: string, now: string, leaseExpiresAt: string) => ({
		consumerId: workers.delivery,
		leaseToken: token,
		now,
		leaseExpiresAt,
		limit: workers.claimLimit,
	})
	const accepted = (
		assessmentId: string,
		leaseToken: string,
		signalId: string,
		deliveryId: string,
		proposal: SignalProposal,
		completedAt: string,
	): RecordAcceptedSignalInput => ({
		assessmentId,
		consumerId: workers.assessment,
		leaseToken,
		signalId,
		deliveryId,
		proposal,
		settledSilentChanges: [],
		completedAt,
		deliveryAvailableAt: completedAt,
	})

	try {
		await capture('enqueue-primary', dataset.primary.assessment, () => mainStore.enqueueAssessment(dataset.primary.assessment))
		await capture('enqueue-primary-identical-replay', dataset.primary.assessment, () => mainStore.enqueueAssessment(dataset.primary.assessment))
		const conflictingAssessment = { ...dataset.primary.assessment, scopedChanges: dataset.primary.conflictingChanges }
		await capture('enqueue-primary-conflicting-id-reuse', conflictingAssessment, () => mainStore.enqueueAssessment(conflictingAssessment))
		const primaryClaim = claim(workers.assessmentLease1, time.created!, time.firstLeaseExpiry!)
		await capture('claim-primary', primaryClaim, () => mainStore.claimAssessments(primaryClaim))
		const primaryAccepted = accepted(dataset.primary.assessment.id, workers.assessmentLease1, dataset.primary.signalId, dataset.primary.deliveryId, dataset.primary.proposal, time.accepted!)
		await capture('record-primary-accepted', primaryAccepted, () => mainStore.recordAccepted(primaryAccepted))
		await capture('record-primary-accepted-replay', primaryAccepted, () => mainStore.recordAccepted(primaryAccepted))

		if (adapter.persistent) {
			await capture('close-before-persistent-reopen', { adapter: adapter.kind, databasePath }, () => brain.dispose())
			brain = await openStore(adapter, databasePath)
			mainStore = createSignalStateStore({ store: brain, policy: config.policies.main })
			operations.push({ sequence: ++sequence, label: 'open-persistent-store', input: { adapter: adapter.kind, databasePath }, output: { opened: true } })
			await capture('snapshot-after-persistent-reopen', { adapter: adapter.kind, databasePath }, () => mainStore.snapshot())
		} else {
			operations.push({ sequence: ++sequence, label: 'persistent-reopen-not-applicable', input: { adapter: adapter.kind }, output: { persistent: false } })
		}

		const exactAssessment = { ...dataset.primary.assessment, id: dataset.exactReplay.assessmentId, availableAt: time.accepted!, createdAt: time.accepted! }
		await capture('enqueue-exact-change-replay', exactAssessment, () => mainStore.enqueueAssessment(exactAssessment))
		const exactClaim = claim(workers.assessmentLease2, time.accepted!, time.firstLeaseExpiry!)
		await capture('claim-exact-change-replay', exactClaim, () => mainStore.claimAssessments(exactClaim))
		const exactAccepted = accepted(exactAssessment.id, workers.assessmentLease2, dataset.exactReplay.unusedSignalId, dataset.exactReplay.unusedDeliveryId, dataset.primary.proposal, time.accepted!)
		await capture('record-exact-change-replay', exactAccepted, () => mainStore.recordAccepted(exactAccepted))

		await capture('enqueue-new-change-same-cooldown-scope', dataset.cooldown.assessment, () => mainStore.enqueueAssessment(dataset.cooldown.assessment))
		const cooldownClaim = claim(workers.assessmentLease2, time.accepted!, time.firstLeaseExpiry!)
		await capture('claim-new-change-same-cooldown-scope', cooldownClaim, () => mainStore.claimAssessments(cooldownClaim))
		const cooldownAccepted = accepted(dataset.cooldown.assessment.id, workers.assessmentLease2, dataset.cooldown.signalId, dataset.cooldown.deliveryId, dataset.cooldown.proposal, time.accepted!)
		await capture('record-new-change-same-cooldown-scope', cooldownAccepted, () => mainStore.recordAccepted(cooldownAccepted))

		await capture('enqueue-retry-assessment', dataset.retry.assessment, () => mainStore.enqueueAssessment(dataset.retry.assessment))
		const retryFirstClaim = claim(workers.assessmentLease1, time.accepted!, time.firstLeaseExpiry!)
		await capture('claim-retry-assessment-first-lease', retryFirstClaim, () => mainStore.claimAssessments(retryFirstClaim))
		const retrySecondClaim = claim(workers.assessmentLease2, time.afterFirstLeaseExpiry!, time.secondLeaseExpiry!)
		await capture('reclaim-assessment-after-expired-lease', retrySecondClaim, () => mainStore.claimAssessments(retrySecondClaim))
		const retryInput = {
			assessmentId: dataset.retry.assessment.id,
			consumerId: workers.assessment,
			leaseToken: workers.assessmentLease2,
			retryAt: time.assessmentRetry!,
			settledAt: time.afterFirstLeaseExpiry!,
			error: workers.assessmentRetryError,
		}
		await capture('retry-assessment', retryInput, () => mainStore.retryAssessment(retryInput))
		const retryFinalClaim = claim(workers.assessmentLease3, time.assessmentReclaim!, time.assessmentFinalExpiry!)
		await capture('claim-retried-assessment', retryFinalClaim, () => mainStore.claimAssessments(retryFinalClaim))
		const silentInput = {
			assessmentId: dataset.retry.assessment.id,
			consumerId: workers.assessment,
			leaseToken: workers.assessmentLease3,
			settledChanges: dataset.retry.assessment.scopedChanges,
			completedAt: time.assessmentSettled!,
		}
		await capture('record-retried-assessment-silent', silentInput, () => mainStore.recordSilent(silentInput))

		const firstDeliveryClaim = deliveryClaim(workers.deliveryLease1, time.accepted!, time.firstLeaseExpiry!)
		await capture('claim-delivery-first-lease', firstDeliveryClaim, () => mainStore.claimDeliveries(firstDeliveryClaim))
		const secondDeliveryClaim = deliveryClaim(workers.deliveryLease2, time.afterFirstLeaseExpiry!, time.secondLeaseExpiry!)
		await capture('reclaim-delivery-after-expired-lease', secondDeliveryClaim, () => mainStore.claimDeliveries(secondDeliveryClaim))
		const deliveryRetry = {
			id: dataset.primary.deliveryId,
			consumerId: workers.delivery,
			leaseToken: workers.deliveryLease2,
			outcome: 'retry' as const,
			settledAt: time.deliveryRetrySettled!,
			retryAt: time.deliveryRetry!,
			error: workers.deliveryRetryError,
		}
		await capture('retry-delivery', deliveryRetry, () => mainStore.settleDelivery(deliveryRetry))
		const finalDeliveryClaim = deliveryClaim(workers.deliveryLease3, time.deliveryReclaim!, time.deliveryFinalExpiry!)
		await capture('claim-retried-delivery', finalDeliveryClaim, () => mainStore.claimDeliveries(finalDeliveryClaim))
		const delivered = {
			id: dataset.primary.deliveryId,
			consumerId: workers.delivery,
			leaseToken: workers.deliveryLease3,
			outcome: 'delivered' as const,
			settledAt: time.delivered!,
		}
		await capture('settle-delivery', delivered, () => mainStore.settleDelivery(delivered))
		await capture('main-final-snapshot', { stateRecordId: config.policies.main.stateRecordId }, () => mainStore.snapshot())

		const capacityStore = createSignalStateStore({ store: brain, policy: config.policies.capacity })
		await capture('capacity-enqueue-first', dataset.capacity.first, () => capacityStore.enqueueAssessment(dataset.capacity.first))
		await capture('capacity-enqueue-second', dataset.capacity.second, () => capacityStore.enqueueAssessment(dataset.capacity.second))
		await capture('capacity-snapshot', { stateRecordId: config.policies.capacity.stateRecordId }, () => capacityStore.snapshot())

		const retentionStore = createSignalStateStore({ store: brain, policy: config.policies.retention })
		await capture('retention-enqueue-accepted', dataset.retention.acceptedAssessment, () => retentionStore.enqueueAssessment(dataset.retention.acceptedAssessment))
		const retentionClaim = claim(workers.assessmentLease1, time.created!, time.firstLeaseExpiry!)
		await capture('retention-claim-accepted', retentionClaim, () => retentionStore.claimAssessments(retentionClaim))
		const retentionAccepted = accepted(dataset.retention.acceptedAssessment.id, workers.assessmentLease1, dataset.retention.signalId, dataset.retention.deliveryId, dataset.retention.proposal, time.accepted!)
		await capture('retention-record-accepted', retentionAccepted, () => retentionStore.recordAccepted(retentionAccepted))
		await capture('retention-enqueue-pending', dataset.retention.pendingAssessment, () => retentionStore.enqueueAssessment(dataset.retention.pendingAssessment))
		await capture('retention-prune-expired-with-live-work', { now: time.expired }, () => retentionStore.prune(time.expired!))
		const retentionDeliveryClaim = deliveryClaim(workers.deliveryLease1, time.expired!, time.afterExpiredDelivery!)
		await capture('retention-claim-live-delivery', retentionDeliveryClaim, () => retentionStore.claimDeliveries(retentionDeliveryClaim))
		const retentionDelivered = {
			id: dataset.retention.deliveryId,
			consumerId: workers.delivery,
			leaseToken: workers.deliveryLease1,
			outcome: 'delivered' as const,
			settledAt: time.expired!,
		}
		await capture('retention-settle-delivery', retentionDelivered, () => retentionStore.settleDelivery(retentionDelivered))
		await capture('retention-prune-after-delivery', { now: time.afterExpiredDelivery }, () => retentionStore.prune(time.afterExpiredDelivery!))
		await capture('retention-final-snapshot', { stateRecordId: config.policies.retention.stateRecordId }, () => retentionStore.snapshot())
	} finally {
		try {
			await brain.dispose()
			operations.push({ sequence: ++sequence, label: 'close-final-store', input: { adapter: adapter.kind, databasePath }, output: { closed: true } })
		} catch (failure) {
			operations.push({ sequence: ++sequence, label: 'close-final-store', input: { adapter: adapter.kind, databasePath }, failure })
		}
		writeFileSync(resolve(artifactDirectory, 'raw-operations.inspect.txt'), exact(operations))
		writeFileSync(resolve(artifactDirectory, 'metadata.json'), `${JSON.stringify({
			startedAt,
			completedAt: new Date().toISOString(),
			adapterName,
			adapter,
			runtime: {
				node: process.version,
				bun: (globalThis as { Bun?: { version?: string } }).Bun?.version,
			},
			configPath,
			datasetPath,
			databasePath,
			operationCount: operations.length,
			grading: null,
		}, null, 2)}\n`)
	}

	console.log(artifactDirectory)
}

await main()
