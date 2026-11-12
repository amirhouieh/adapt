import { describe, expect, it } from 'vitest'
import { assessSignals, type SignalAssessmentInput } from '../src/brain/signals'
import type { LearningModelCapability } from '../src/learning'

function model(value: unknown, onGenerate?: () => void): Pick<LearningModelCapability, 'generate'> {
	return {
		async generate() {
			onGenerate?.()
			return { value, raw: { value }, finishReason: 'stop' }
		},
	}
}

function input(modelCapability: Pick<LearningModelCapability, 'generate'>): SignalAssessmentInput {
	return {
		assessmentId: 'assessment-1',
		changes: [
			{ lensId: 'project-a', changeId: 'change-a', memoryId: 'memory-a', memoryRevision: 2, kind: 'relationship_changed', summary: 'Project A now depends on Team X.', affectedMemoryIds: ['entity-a'] },
			{ lensId: 'project-b', changeId: 'change-b', memoryId: 'memory-b', memoryRevision: 4, kind: 'relationship_changed', summary: 'Project B now depends on Team X.', affectedMemoryIds: ['entity-b'] },
		],
		memories: [
			{ lensId: 'project-a', memoryId: 'memory-a', memoryRevision: 2, memoryType: 'graph', purpose: 'Project A dependencies', content: { dependency: 'Team X', scopedEntityId: 'team-x-a' } },
			{ lensId: 'project-b', memoryId: 'memory-b', memoryRevision: 4, memoryType: 'text', purpose: 'Project B delivery', content: 'Current delivery depends on Team X.' },
		],
		priorSignals: [],
		policy: { id: 'signals', version: '1', instructions: 'Signal only material delivery implications.', cooldownScopeId: 'delivery-risk', maxChanges: 4, maxMemories: 4, maxPriorSignals: 4, maxContextCharacters: 10_000, maxRequestCharacters: 20_000, maxSignalCharacters: 500 },
		model: modelCapability,
		signal: new AbortController().signal,
	}
}

describe('signal assessment', () => {
	it('accepts a cross-lens implication with different scoped identities', async () => {
		const result = await assessSignals(input(model({ status: 'signal', meaning: 'Both projects now share a Team X delivery dependency.', materialChange: 'A Team X delay can affect both projects.', affectedLensIds: ['project-a', 'project-b'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }, { lensId: 'project-b', memoryId: 'memory-b' }], signalChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }], silentChanges: [], pendingChanges: [], reason: '' })))
		expect(result).toMatchObject({ status: 'proposed', proposal: { affectedLensIds: ['project-a', 'project-b'], scopedChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }] } })
	})

	it('allows a warranted single-lens signal', async () => {
		const base = input(model({ status: 'signal', meaning: 'Project A lost its only deployment dependency.', materialChange: 'Delivery is now blocked.', affectedLensIds: ['project-a'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }], signalChanges: [{ lensId: 'project-a', changeId: 'change-a' }], silentChanges: [], pendingChanges: [], reason: '' }))
		const result = await assessSignals({ ...base, changes: base.changes.slice(0, 1), memories: base.memories.slice(0, 1) })
		expect(result).toMatchObject({ status: 'proposed', proposal: { affectedLensIds: ['project-a'] } })
	})

	it('rejects invented ids despite a schema-valid model result', async () => {
		const result = await assessSignals(input(model({ status: 'signal', meaning: 'Invented', materialChange: 'Invented', affectedLensIds: ['project-a'], affectedMemories: [{ lensId: 'project-a', memoryId: 'missing-memory' }], signalChanges: [{ lensId: 'project-a', changeId: 'change-a' }], silentChanges: [{ lensId: 'project-b', changeId: 'change-b' }], pendingChanges: [], reason: '' })))
		expect(result).toMatchObject({ status: 'failure', code: 'invalid_result' })
	})

	it('does not return a late successful result after cancellation', async () => {
		const controller = new AbortController()
		const base = input(model({ status: 'silent', meaning: '', materialChange: '', affectedLensIds: [], affectedMemories: [], signalChanges: [], silentChanges: [], pendingChanges: [], reason: 'No material change.' }, () => controller.abort()))
		const result = await assessSignals({ ...base, signal: controller.signal })
		expect(result).toMatchObject({ status: 'defer', code: 'cancelled' })
	})

	it('keeps duplicate local change ids distinct by lens and explicitly settles the full batch', async () => {
		const base = input(model({ status: 'signal', meaning: 'Shared risk.', materialChange: 'Both changed.', affectedLensIds: ['project-a'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }], signalChanges: [{ lensId: 'project-a', changeId: 'same-change' }], silentChanges: [{ lensId: 'project-b', changeId: 'same-change' }], pendingChanges: [], reason: '' }))
		const result = await assessSignals({ ...base, changes: [{ ...base.changes[0]!, changeId: 'same-change' }, { ...base.changes[1]!, changeId: 'same-change' }] })
		expect(result).toMatchObject({ status: 'proposed', proposal: { scopedChanges: [{ lensId: 'project-a', changeId: 'same-change' }] }, settledSilentChanges: [{ lensId: 'project-b', changeId: 'same-change' }] })
	})

	it('rejects a change reference placed in both signal and silent partitions', async () => {
		const result = await assessSignals(input(model({
			status: 'signal', meaning: 'Shared risk.', materialChange: 'Both changed.',
			affectedLensIds: ['project-a'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }],
			signalChanges: [{ lensId: 'project-a', changeId: 'change-a' }],
			silentChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }],
			pendingChanges: [], reason: '',
		})))
		expect(result).toMatchObject({ status: 'failure', code: 'invalid_result' })
	})

	it('defers the whole assessment when any scoped change remains uncertain', async () => {
		const result = await assessSignals(input(model({
			status: 'defer', meaning: '', materialChange: '', affectedLensIds: [], affectedMemories: [],
			signalChanges: [], silentChanges: [],
			pendingChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }],
			reason: 'The relationship between the changes is unresolved.',
		})))
		expect(result).toMatchObject({
			status: 'defer', code: 'semantic_unknown',
			pendingChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }],
		})
	})

	it('defers before a model call when bounded context is exceeded', async () => {
		let calls = 0
		const base = input(model({}, () => { calls += 1 }))
		const result = await assessSignals({ ...base, policy: { ...base.policy, maxContextCharacters: 1 } })
		expect(result).toMatchObject({ status: 'defer', code: 'request_bound' })
		expect(calls).toBe(0)
	})

	it('rejects a change whose supplied current memory revision does not match', async () => {
		let calls = 0
		const base = input(model({}, () => { calls += 1 }))
		const result = await assessSignals({ ...base, memories: [{ ...base.memories[0]!, memoryRevision: 99 }, base.memories[1]!] })
		expect(result).toMatchObject({ status: 'failure', code: 'invalid_input' })
		expect(calls).toBe(0)
	})

	it('snapshots semantic inputs before awaiting the provider', async () => {
		let release = () => {}
		const gate = new Promise<void>((resolve) => { release = resolve })
		const output = { status: 'signal', meaning: 'Shared dependency.', materialChange: 'Both plans changed.', affectedLensIds: ['project-a', 'project-b'], affectedMemories: [{ lensId: 'project-a', memoryId: 'memory-a' }, { lensId: 'project-b', memoryId: 'memory-b' }], signalChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }], silentChanges: [], pendingChanges: [], reason: '' }
		const base = input({
			async generate() { await gate; return { value: output, raw: output, finishReason: 'stop' } },
		})
		const running = assessSignals(base)
		;(base.changes as Array<{ lensId: string }>)[0]!.lensId = 'mutated-lens'
		;(base.policy as { maxSignalCharacters: number }).maxSignalCharacters = 1
		release()
		const result = await running
		expect(result).toMatchObject({ status: 'proposed', proposal: { scopedChanges: [{ lensId: 'project-a', changeId: 'change-a' }, { lensId: 'project-b', changeId: 'change-b' }] } })
	})
})
