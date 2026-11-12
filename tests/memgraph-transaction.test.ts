import { beforeEach, describe, expect, it, vi } from 'vitest'

const neo4jDouble = vi.hoisted(() => ({
	driver: vi.fn(),
	authNone: vi.fn(() => ({ scheme: 'none' })),
	authBasic: vi.fn(() => ({ scheme: 'basic' })),
}))

vi.mock('neo4j-driver', () => ({
	default: {
		driver: neo4jDouble.driver,
		auth: {
			none: neo4jDouble.authNone,
			basic: neo4jDouble.authBasic,
		},
		session: {
			READ: 'READ',
			WRITE: 'WRITE',
		},
	},
}))

import { createMemgraphGraphStore } from '../src/stores/memgraph'
import type { GraphCommitInput } from '../src/stores/memgraph/contracts'
import { validateCommitInput } from '../src/stores/memgraph/validation'

const options = {
	connection: {
		uri: 'bolt://127.0.0.1:7687',
		connectionTimeoutMs: 100,
		maxConnectionPoolSize: 1,
		transactionTimeoutMs: 100,
	},
	policy: {
		maxRecordsPerCommit: 8,
		maxSerializedCharsPerCommit: 4_000,
		maxContextEntities: 8,
		maxContextEdges: 8,
		maxContextChars: 4_000,
		maxTraversalDepth: 2,
		maxTraversalEntities: 8,
		maxTraversalEdges: 8,
		maxInspectionRecordsPerNamespace: 8,
		maxInspectionChars: 4_000,
	},
} as const

function revisionResult() {
	return {
		records: [
			{
				get(key: string) {
					if (key !== 'node') throw new Error(`unexpected record key ${key}`)
					return {
						properties: {
							memory_revision: 2,
							config_revision: 3,
							schema_json: JSON.stringify({
								lensId: 'lens',
								entityTypes: [],
								relations: [],
								identity: {
									exactNormalizedLabel: 'decision',
									allowModelDeclaredNew: true,
								},
							}),
						},
					}
				},
			},
		],
	}
}

const committedAt = '2026-09-30T12:00:00.000Z'

function validCommit(): GraphCommitInput {
	return {
		lensId: 'lens',
		schema: {
			lensId: 'lens',
			entityTypes: ['project'],
			relations: [{
				id: 'depends_on',
				description: 'A project depends on another project.',
				extractionInstructions: 'Extract only explicit project dependencies.',
				sourceEntityTypes: ['project'],
				targetEntityTypes: ['project'],
				directed: true,
				allowSelf: false,
			}],
			identity: {
				exactNormalizedLabel: 'decision',
				allowModelDeclaredNew: true,
			},
		},
		logicalAttemptId: 'attempt-a',
		pendingWorkId: 'work-a',
		expectedMemoryRevision: 2,
		expectedConfigRevision: 3,
		inputIds: ['input-a'],
		outcome: 'change',
		patch: {
			expectedRevision: 2,
			entityUpserts: [{ id: 'project-a', type: 'project', label: 'Project A', aliases: [] }],
			edgeChanges: [],
			pending: [],
			pendingInputIds: [],
		},
		history: {
			id: 'history-a',
			attempt_id: 'attempt-a',
			outcome: 'change',
			previous_memory_revision: 2,
			memory_revision: 3,
			config_revision: 3,
			input_ids: ['input-a'],
			change_ids: ['change-a'],
			created_at: committedAt,
		},
		changes: [{
			id: 'change-a',
			attempt_id: 'attempt-a',
			memory_revision: 3,
			kind: 'graph-update',
			affected_memory_ids: ['project-a'],
			created_at: committedAt,
		}],
		outbox: [],
		committedAt,
	}
}

function continuation() {
	return {
		id: 'work-b',
		attempt_id: 'attempt-b',
		input_ids: ['input-b'],
		status: 'pending' as const,
		retry_count: 0,
		available_at: committedAt,
		created_at: committedAt,
		updated_at: committedAt,
	}
}

function installDriver(input?: {
	readonly beginTransaction?: () => Promise<unknown>
	readonly closeSession?: () => Promise<void>
}) {
	const transaction = {
		run: vi.fn(async () => revisionResult()),
		commit: vi.fn(async () => {}),
		rollback: vi.fn(async () => {}),
	}
	const session = {
		beginTransaction: vi.fn(
			input?.beginTransaction ?? (async () => transaction),
		),
		close: vi.fn(input?.closeSession ?? (async () => {})),
	}
	const driver = {
		session: vi.fn(() => session),
		verifyConnectivity: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	}
	neo4jDouble.driver.mockReturnValue(driver)
	return { driver, session, transaction }
}

describe('Memgraph transaction resource handling', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('closes the session when beginning a transaction fails', async () => {
		const beginError = new Error('begin failed')
		const { session } = installDriver({
			beginTransaction: async () => {
				throw beginError
			},
		})
		const store = createMemgraphGraphStore(options)

		await expect(store.getRevisions('lens')).rejects.toBe(beginError)
		expect(session.close).toHaveBeenCalledTimes(1)
	})

	it('keeps the operation error primary when rollback also fails', async () => {
		const operationError = new Error('operation failed')
		const rollbackError = new Error('rollback failed')
		const { session, transaction } = installDriver()
		transaction.run.mockRejectedValueOnce(operationError)
		transaction.rollback.mockRejectedValueOnce(rollbackError)
		const store = createMemgraphGraphStore(options)

		await expect(store.getRevisions('lens')).rejects.toBe(operationError)
		expect(transaction.rollback).toHaveBeenCalledTimes(1)
		expect(session.close).toHaveBeenCalledTimes(1)
	})

	it('keeps the commit error primary when rollback also fails', async () => {
		const commitError = new Error('commit failed')
		const rollbackError = new Error('rollback failed')
		const { session, transaction } = installDriver()
		transaction.commit.mockRejectedValueOnce(commitError)
		transaction.rollback.mockRejectedValueOnce(rollbackError)
		const store = createMemgraphGraphStore(options)

		await expect(store.getRevisions('lens')).rejects.toBe(commitError)
		expect(transaction.rollback).toHaveBeenCalledTimes(1)
		expect(session.close).toHaveBeenCalledTimes(1)
	})

	it('does not let session close failure mask an earlier operation error', async () => {
		const operationError = new Error('operation failed')
		const closeError = new Error('close failed')
		const { session, transaction } = installDriver({
			closeSession: async () => {
				throw closeError
			},
		})
		transaction.run.mockRejectedValueOnce(operationError)
		const store = createMemgraphGraphStore(options)

		await expect(store.getRevisions('lens')).rejects.toBe(operationError)
		expect(transaction.rollback).toHaveBeenCalledTimes(1)
		expect(session.close).toHaveBeenCalledTimes(1)
	})

	it('closes once after success without replaying the transaction work', async () => {
		const { session, transaction } = installDriver()
		const store = createMemgraphGraphStore(options)

		await expect(store.getRevisions('lens')).resolves.toMatchObject({
			memory_revision: 2,
			config_revision: 3,
		})
		expect(session.beginTransaction).toHaveBeenCalledTimes(1)
		expect(transaction.run).toHaveBeenCalledTimes(1)
		expect(transaction.commit).toHaveBeenCalledTimes(1)
		expect(transaction.rollback).not.toHaveBeenCalled()
		expect(session.close).toHaveBeenCalledTimes(1)
	})

	it('keeps cancellation primary when its rollback fails', async () => {
		const controller = new AbortController()
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => { markStarted = resolve })
		const { session, transaction } = installDriver()
		transaction.run.mockImplementationOnce(async () => {
			markStarted?.()
			return new Promise<never>(() => {})
		})
		transaction.rollback.mockRejectedValueOnce(new Error('rollback failed'))
		const store = createMemgraphGraphStore(options)
		const running = store.getLearningContext({
			lensId: 'lens',
			expectedMemoryRevision: 2,
			expectedConfigRevision: 3,
			mentions: [],
			inputIds: ['input-a'],
			maxEntities: 1,
			maxEdges: 1,
			maxSerializedChars: 100,
		}, { signal: controller.signal })

		await started
		controller.abort()

		await expect(running).rejects.toMatchObject({ name: 'AbortError' })
		expect(transaction.rollback).toHaveBeenCalledTimes(1)
		expect(session.close).toHaveBeenCalledTimes(1)
	})
})

describe('Memgraph graph commit validation', () => {
	it.each([
		['inputs', { inputs: [{ id: 'input-b', text: 'unresolved source text' }] }],
		['payload', { payload: { text: 'opaque source text' } }],
	])('rejects forged residual %s source content', (_field, extra) => {
		const input = {
			...validCommit(),
			remainingWork: { ...continuation(), ...extra },
		} as unknown as GraphCommitInput

		expect(() => validateCommitInput(input, options.policy)).toThrow(
			'remaining work cannot supply source content',
		)
	})

	it('rejects duplicate graph patch identities before storage', () => {
		const base = validCommit()
		const input: GraphCommitInput = {
			...base,
			patch: {
				...base.patch!,
				entityUpserts: [base.patch!.entityUpserts[0]!, base.patch!.entityUpserts[0]!],
			},
		}

		expect(() => validateCommitInput(input, options.policy)).toThrow(
			'graph patch entity ids must be unique',
		)
	})

	it('rejects a graph patch pinned to another memory revision', () => {
		const base = validCommit()
		const input: GraphCommitInput = {
			...base,
			patch: { ...base.patch!, expectedRevision: 1 },
		}

		expect(() => validateCommitInput(input, options.policy)).toThrow(
			'graph patch revision does not match commit revision',
		)
	})

	it('rejects learning history that does not describe the commit', () => {
		const base = validCommit()
		const input: GraphCommitInput = {
			...base,
			history: { ...base.history, memory_revision: 4 },
		}

		expect(() => validateCommitInput(input, options.policy)).toThrow(
			'learning history does not match graph commit',
		)
	})
})
