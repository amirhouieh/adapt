import type { LearningResult } from '../../learning'
import type {
	GraphCommitInput,
	MemgraphGraphStore,
} from '../../stores/memgraph/contracts'
import type {
	LearningCommitResult,
	LearningHistoryRecord,
	MemoryChangeRecord,
	OutboxRecord,
	PendingWorkContinuation,
} from '../../stores/types'
import type { GraphLensSchema, GraphPatch } from './contracts'
import { graphPatchSchema } from './recipe'

export interface CommitGraphRecipeInput {
	readonly lensId: string
	readonly schema: GraphLensSchema
	readonly logicalAttemptId: string
	readonly pendingWorkId: string
	readonly expectedMemoryRevision: number
	readonly expectedConfigRevision: number
	readonly result: LearningResult
	readonly remainingWork?: PendingWorkContinuation
	readonly history: LearningHistoryRecord
	readonly changes: readonly MemoryChangeRecord[]
	readonly outbox: readonly OutboxRecord[]
	readonly committedAt: string
}

export type GraphCommitCapability = Pick<MemgraphGraphStore, 'commit'>

export function graphCommitInput(
	input: CommitGraphRecipeInput,
): GraphCommitInput {
	if (
		input.result.outcome !== 'change' &&
		input.result.outcome !== 'no_change'
	) {
		throw new Error('only a settled graph learning result can be committed')
	}
	const inputIds = input.result.consumedInputIds
	if (inputIds === undefined) {
		throw new Error('graph learning result omitted consumed input ids')
	}
	let patch: GraphPatch | undefined
	if (input.result.outcome === 'change') {
		if (
			input.result.expectedMemoryRevision !== input.expectedMemoryRevision ||
			input.result.expectedConfigurationRevision !==
				input.expectedConfigRevision
		) {
			throw new Error('graph learning result does not match commit revisions')
		}
		patch = graphPatchSchema.parse(input.result.patch)
	}
	return {
		lensId: input.lensId,
		schema: input.schema,
		logicalAttemptId: input.logicalAttemptId,
		pendingWorkId: input.pendingWorkId,
		expectedMemoryRevision: input.expectedMemoryRevision,
		expectedConfigRevision: input.expectedConfigRevision,
		inputIds: [...inputIds],
		...(input.remainingWork === undefined
			? {}
			: { remainingWork: input.remainingWork }),
		outcome: input.result.outcome === 'change' ? 'change' : 'no-change',
		...(patch === undefined ? {} : { patch }),
		history: input.history,
		changes: input.changes,
		outbox: input.outbox,
		committedAt: input.committedAt,
	}
}

export function commitGraphRecipeResult(
	store: GraphCommitCapability,
	input: CommitGraphRecipeInput,
): Promise<LearningCommitResult> {
	return store.commit(graphCommitInput(input))
}
