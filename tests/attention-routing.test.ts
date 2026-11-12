import { describe, expect, it } from 'vitest'
import type { LearningModelCapability } from '../src/learning'
import {
	createBoundedCandidateSelector,
	createLiteralMetadataCandidateSelector,
	retainDiscoveryBuffer,
	routeAttention,
	type AttentionAction,
	type AttentionLens,
	type AttentionPortion,
	type AttentionRoutingInput,
	type DiscoveryBufferEntry,
} from '../src/brain/attention'

const portion = (id: string, text: string): AttentionPortion => ({
	id,
	inputId: `input-${id}`,
	sourceId: `source-${id}`,
	text,
	observedAt: '2026-09-30T10:00:00.000Z',
})

const lens = (
	id: string,
	description: string,
	routingTerms: string[],
	learningStatus: AttentionLens['learningStatus'] = 'active',
): AttentionLens => ({
	id,
	revision: 1,
	description,
	routingInstructions: `Route only explicit ${id} material.`,
	metadata: { routingTerms },
	learningStatus,
})

const policy = {
	maxPortions: 8,
	maxPortionCharacters: 2000,
	maxRequestContextCharacters: 20_000,
	maxCandidateLenses: 4,
	maxDestinationsPerPortion: 3,
	maxProviderCalls: 8,
	maxUncoveredSpans: 4,
	maxDiscoveryActions: 4,
	maxRecheckActions: 4,
}

function model(
	outputs: readonly unknown[],
	onCall?: (request: Parameters<LearningModelCapability['generate']>[0]) => void,
): LearningModelCapability {
	let index = 0
	return {
		async generate(request) {
			onCall?.(request)
			const output = outputs[index]
			index += 1
			return {
				value: request.schema.parse(output),
				raw: { output, index },
				usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
			}
		},
		async decide() {
			throw new Error('attention router does not use decision capability')
		},
	}
}

function routingInput(
	portions: AttentionPortion[],
	lenses: AttentionLens[],
	overrides: Partial<AttentionRoutingInput> = {},
): AttentionRoutingInput {
	return { portions, lenses, rules: [], policy, ...overrides }
}

describe('routeAttention', () => {
	it('applies complete multi-lens developer routes without a provider call', async () => {
		const item = portion('explicit', 'A supplied item')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'preferences', []), lens('commitments', 'commitments', [])], {
				rules: [{
					id: 'explicit-route', priority: 10, match: { sourceIds: [item.sourceId] },
					includeLensIds: ['preferences', 'commitments'], excludeLensIds: [], coverage: 'complete',
				}],
			}),
			{ model: model([]), candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal },
		)
		expect(result.providerCalls).toBe(0)
		expect(result.coverage).toMatchObject([{ state: 'complete', selectedLensIds: ['preferences', 'commitments'] }])
		expect(result.selectedWork.map(({ lensId }) => lensId).sort()).toEqual(['commitments', 'preferences'])
	})

	it('routes a covered preference and retains the uncovered commitment from one canonical portion', async () => {
		const text = 'I prefer tea. I promised to send the report Friday.'
		const item = portion('mixed', text)
		const result = await routeAttention(
			routingInput([item], [
				lens('preferences', 'Personal preferences', ['prefer']),
				lens('travel', 'Travel plans', ['flight']),
			]),
			{
				model: model([
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit preference plus another subject' },
					{ relevant: false, certain: true, coversWholePortion: false, reason: 'no travel material' },
				]),
				candidateSelector: createBoundedCandidateSelector(),
				signal: new AbortController().signal,
			},
		)
		expect(result.selectedWork).toMatchObject([{ lensId: 'preferences', portions: [{ id: 'mixed', inputId: 'input-mixed' }] }])
		expect(result.coverage).toMatchObject([{
			state: 'partial', retainedScope: 'whole_portion', uncoveredSpans: [],
		}])
		expect(result.actions).toMatchObject([{
			kind: 'discover', portion: { id: 'mixed', inputId: 'input-mixed', sourceId: 'source-mixed' },
			uncoveredSpans: [],
		}])
	})

	it('does not infer complete coverage from two partial matches when a third subject remains', async () => {
		const item = portion('multi', 'I prefer tea, promised a report, and recorded an operational outage.')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', []), lens('commitments', 'Commitments', [])]),
			{
				model: model([
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit preference' },
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit promise' },
					{ covered: false, reason: 'the outage is not covered by either matched lens' },
				]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.coverage[0]).toMatchObject({ state: 'partial', selectedLensIds: ['preferences', 'commitments'], retainedScope: 'whole_portion' })
		expect(result.selectedWork.map(({ lensId }) => lensId)).toEqual(['preferences', 'commitments'])
		expect(result.actions).toMatchObject([{ kind: 'discover', reason: 'partial_coverage', portion: item }])
	})

	it('establishes complete union coverage with one bounded aggregate check', async () => {
		const item = portion('union-covered', 'I prefer tea and promised a report.')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', []), lens('commitments', 'Commitments', [])]),
			{
				model: model([
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit preference' },
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit promise' },
					{ covered: true, reason: 'the two lenses account for both stated subjects' },
				]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.providerCalls).toBe(3)
		expect(result.coverage[0]).toMatchObject({ state: 'complete', selectedLensIds: ['preferences', 'commitments'] })
		expect(result.coverage[0]?.model?.[2]).toMatchObject({ stage: 'aggregate_coverage', lensIds: ['preferences', 'commitments'] })
		expect(result.actions).toEqual([])
	})

	it('retains partial work when the aggregate coverage call exceeds the provider budget', async () => {
		const item = portion('union-budget', 'I prefer tea and promised a report.')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', []), lens('commitments', 'Commitments', [])], {
				policy: { ...policy, maxProviderCalls: 2 },
			}),
			{
				model: model([
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit preference' },
					{ relevant: true, certain: true, coversWholePortion: false, reason: 'explicit promise' },
				]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.providerCalls).toBe(2)
		expect(result.coverage[0]).toMatchObject({ state: 'partial', retainedScope: 'whole_portion' })
		expect(result.actions).toMatchObject([{ kind: 'pending', reason: 'action_budget' }])
	})

	it('rejects an irrelevant lens that claims whole-portion coverage', async () => {
		const item = portion('contradictory', 'A preference and a separate promise.')
		await expect(routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', [])]),
			{
				model: model([{ relevant: false, certain: true, coversWholePortion: true, reason: 'contradiction' }]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)).rejects.toThrow('only a certain relevant lens can cover the whole portion')
	})

	it('keeps ambiguous routing unknown and schedules a bounded recheck', async () => {
		const item = portion('ambiguous', 'This might be a preference or a temporary task.')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', []), lens('tasks', 'Tasks', [])]),
			{
				model: model([
					{ relevant: false, certain: false, coversWholePortion: false, reason: 'vague possibility' },
					{ relevant: false, certain: false, coversWholePortion: false, reason: 'vague possibility' },
				]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.coverage[0]).toMatchObject({ state: 'unknown', retainedScope: 'whole_portion' })
		expect(result.actions[0]).toMatchObject({ kind: 'recheck', reason: 'semantic_unknown' })
	})

	it('excludes paused lenses from learning without erasing their identity', async () => {
		const item = portion('paused', 'A preference update')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', [], 'paused')], {
				rules: [{ id: 'route-paused', priority: 1, match: {}, includeLensIds: ['preferences'], excludeLensIds: [], coverage: 'complete' }],
			}),
			{ model: model([]), candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal },
		)
		expect(result.selectedWork).toEqual([])
		expect(result.coverage[0]).toMatchObject({ state: 'complete', matchedPausedLensIds: ['preferences'], omittedLensIds: [] })
		expect(result.coverage[0]?.retainedScope).toBe('whole_portion')
		expect(result.actions[0]).toMatchObject({ kind: 'pending', reason: 'paused_lens', portion: { inputId: item.inputId } })
	})

	it('accounts for a semantic paused-lens match and separately retains uncovered content', async () => {
		const item = portion('paused-partial', 'I prefer tea and promised a report.')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', ['prefer'], 'paused')]),
			{
				model: model([{ relevant: true, certain: true, coversWholePortion: false, reason: 'preference plus another subject' }]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.selectedWork).toEqual([])
		expect(result.coverage[0]).toMatchObject({
			state: 'partial', selectedLensIds: ['preferences'], matchedPausedLensIds: ['preferences'],
		})
		expect(result.actions.map(({ kind, reason }) => [kind, reason])).toEqual([
			['pending', 'paused_lens'], ['discover', 'partial_coverage'],
		])
	})

	it('keeps semantically uninspected omitted lenses unknown', async () => {
		const item = portion('omitted-candidates', 'Potentially relevant content')
		const result = await routeAttention(
			routingInput([item], [lens('one', 'One', []), lens('two', 'Two', [])]),
			{
				model: model([]),
				candidateSelector: {
					select: ({ lenses }) => ({
						lensIds: [], metadataExaminedLensIds: [],
						omittedLensIds: lenses.map(({ id }) => id), provenance: { strategy: 'none' },
					}),
				},
				signal: new AbortController().signal,
			},
		)
		expect(result.providerCalls).toBe(0)
		expect(result.coverage[0]).toMatchObject({ state: 'unknown', retainedScope: 'whole_portion' })
		expect(result.actions[0]).toMatchObject({ kind: 'recheck', reason: 'candidate_truncation' })
	})

	it('uses supplied metadata to recall a relevant lens in a large registry and reports semantic truncation', async () => {
		const item = portion('large', 'The delivery depends on TeamX.')
		const lenses = Array.from({ length: 20 }, (_, index) =>
			lens(`lens-${index}`, `Lens ${index}`, index === 17 ? ['TeamX'] : [`term-${index}`]),
		)
		const selector = createLiteralMetadataCandidateSelector((value) => {
			if (typeof value !== 'object' || value === null || !('routingTerms' in value) || !Array.isArray(value.routingTerms)) throw new Error('invalid metadata')
			return { routingTerms: value.routingTerms.map(String) }
		})
		const result = await routeAttention(
			routingInput([item], lenses, { policy: { ...policy, maxCandidateLenses: 3 } }),
			{
				model: model([
					{ relevant: true, certain: true, coversWholePortion: true, reason: 'explicit dependency' },
					{ relevant: false, certain: true, coversWholePortion: false, reason: 'unrelated registry lens' },
					{ relevant: false, certain: true, coversWholePortion: false, reason: 'unrelated registry lens' },
				]),
				candidateSelector: selector, signal: new AbortController().signal,
			},
		)
		expect(result.selectedWork[0]?.lensId).toBe('lens-17')
		expect(result.coverage[0]).toMatchObject({
			state: 'partial', semanticExaminedLensIds: ['lens-17', 'lens-0', 'lens-1'],
			metadataExaminedLensIds: lenses.map(({ id }) => id),
		})
		expect(result.actions[0]).toMatchObject({ kind: 'recheck', reason: 'candidate_truncation' })
	})

	it('exposes input and provider budgets without consuming omitted work', async () => {
		const first = portion('first', 'first')
		const second = portion('second', 'second')
		const result = await routeAttention(
			routingInput([first, second], [lens('one', 'One', [])], {
				policy: { ...policy, maxPortions: 1, maxProviderCalls: 1 },
			}),
			{
				model: model([{ relevant: false, certain: true, coversWholePortion: false, reason: 'unrelated' }]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.omittedPortionIds).toEqual(['second'])
		expect(result.coverage.find(({ portionId }) => portionId === 'second')).toMatchObject({ state: 'unknown' })
		expect(result.actions.find(({ portion }) => portion.id === 'second')).toMatchObject({ kind: 'pending', reason: 'input_bound' })
	})

	it('defers immutable routing context that exceeds the configured request bound', async () => {
		const item = portion('context-bound', 'A preference')
		let calls = 0
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'A long preference description', [])], {
				policy: { ...policy, maxRequestContextCharacters: 10 },
			}),
			{
				model: model([], () => { calls += 1 }),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(calls).toBe(0)
		expect(result.coverage[0]).toMatchObject({ state: 'unknown', retainedScope: 'whole_portion' })
		expect(result.actions[0]).toMatchObject({ kind: 'pending', reason: 'context_bound' })
	})

	it('uses higher-priority rules when include and exclude directives conflict', async () => {
		const item = portion('priority', 'Explicitly routed content')
		const result = await routeAttention(
			routingInput([item], [lens('preferences', 'Preferences', [])], {
				rules: [
					{ id: 'low-include', priority: 1, match: {}, includeLensIds: ['preferences'], excludeLensIds: [], coverage: 'complete' },
					{ id: 'high-exclude', priority: 2, match: {}, includeLensIds: [], excludeLensIds: ['preferences'], coverage: 'complete' },
				],
			}),
			{ model: model([]), candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal },
		)
		expect(result.providerCalls).toBe(0)
		expect(result.selectedWork).toEqual([])
		expect(result.coverage[0]).toMatchObject({ state: 'uncovered', selectedLensIds: [] })
	})

	it('preserves later portions when the provider-call budget is exhausted', async () => {
		const first = portion('provider-first', 'first')
		const second = portion('provider-second', 'second')
		const result = await routeAttention(
			routingInput([first, second], [lens('one', 'One', [])], {
				policy: { ...policy, maxProviderCalls: 1 },
			}),
			{
				model: model([{ relevant: false, certain: true, coversWholePortion: false, reason: 'unrelated' }]),
				candidateSelector: createBoundedCandidateSelector(), signal: new AbortController().signal,
			},
		)
		expect(result.providerCalls).toBe(1)
		expect(result.coverage.find(({ portionId }) => portionId === second.id)).toMatchObject({ state: 'unknown' })
		expect(result.actions.find(({ portion: value }) => value.id === second.id)).toMatchObject({ kind: 'pending', reason: 'action_budget' })
	})

	it('pins mutable routing input before an in-flight provider call completes', async () => {
		const item = portion('mutable', 'I prefer tea and promised a report.')
		const lenses = [lens('preferences', 'Preferences', []), lens('commitments', 'Commitments', [])]
		const supplied = routingInput([item], lenses)
		let release = () => {}
		const gate = new Promise<void>((resolve) => { release = resolve })
		const prompts: string[] = []
		const outputs = [
			{ relevant: true, certain: true, coversWholePortion: false, reason: 'preference' },
			{ relevant: true, certain: true, coversWholePortion: false, reason: 'promise' },
			{ covered: true, reason: 'both subjects covered' },
		]
		let calls = 0
		const running = routeAttention(supplied, {
			model: {
				async generate(request) {
					prompts.push(request.prompt)
					if (calls === 0) await gate
					const value = outputs[calls]
					calls += 1
					return { value: request.schema.parse(value), raw: value }
				},
				async decide() { throw new Error('unused') },
			},
			candidateSelector: createBoundedCandidateSelector(),
			signal: new AbortController().signal,
		})
		;(supplied.portions as AttentionPortion[])[0] = { ...item, text: 'mutated after start' }
		;(supplied.lenses as AttentionLens[])[1] = { ...lenses[1]!, description: 'mutated after start', routingInstructions: 'mutated after start' }
		;(supplied.policy as { maxProviderCalls: number }).maxProviderCalls = 1
		release()
		const result = await running
		expect(result).toMatchObject({ providerCalls: 3, coverage: [{ state: 'complete' }] })
		expect(prompts.join('\n')).toContain('I prefer tea and promised a report.')
		expect(prompts.join('\n')).toContain('Commitments')
		expect(prompts.join('\n')).not.toContain('mutated after start')
	})
})

describe('retainDiscoveryBuffer', () => {
	const action = (item: AttentionPortion): AttentionAction => ({
		kind: 'discover', portion: item, uncoveredSpans: [], reason: 'uncovered',
	})
	const entry = (
		item: AttentionPortion,
		firstRetainedAt: string,
		lastRetainedAt: string,
		expiresAt: string,
	): DiscoveryBufferEntry => ({
		portion: item, uncoveredSpans: [], reason: 'uncovered', firstRetainedAt,
		lastRetainedAt, expiresAt, retainCount: 1,
	})

	it('rejects conflicting reuse of a stable portion id', () => {
		const original = portion('same', 'original')
		const conflicting = { ...original, text: 'changed' }
		expect(() => retainDiscoveryBuffer(
			[entry(original, '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z', '2026-10-01T10:00:00.000Z')],
			[action(conflicting)],
			{ maxItems: 2, maxCharacters: 100, maxAgeMs: 86_400_000, overflowPolicy: 'reject_new' },
			'2026-09-30T11:00:00.000Z',
		)).toThrow('conflicts with retained evidence')
	})

	it('rejects conflicting reuse within one additions batch', () => {
		const original = portion('batch-same', 'original')
		const conflicting = { ...original, text: 'changed' }
		expect(() => retainDiscoveryBuffer(
			[], [action(original), action(conflicting)],
			{ maxItems: 2, maxCharacters: 100, maxAgeMs: 86_400_000, overflowPolicy: 'reject_new' },
			'2026-09-30T11:00:00.000Z',
		)).toThrow('conflicts with retained evidence')
	})

	it('anchors expiry to first retention across rechecks', () => {
		const item = portion('age', 'retained')
		const result = retainDiscoveryBuffer(
			[entry(item, '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z', '2026-10-02T10:00:00.000Z')],
			[action(item)],
			{ maxItems: 2, maxCharacters: 100, maxAgeMs: 7_200_000, overflowPolicy: 'evict_oldest' },
			'2026-09-30T11:00:00.000Z',
		)
		expect(result.retained[0]).toMatchObject({ firstRetainedAt: '2026-09-30T10:00:00.000Z', expiresAt: '2026-09-30T12:00:00.000Z', retainCount: 2 })
	})

	it('does not re-add a same-id recheck at its exact expiry', () => {
		const item = portion('exact-expiry', 'retained')
		const result = retainDiscoveryBuffer(
			[entry(item, '2026-09-30T10:00:00.000Z', '2026-09-30T10:30:00.000Z', '2026-09-30T11:00:00.000Z')],
			[action(item)],
			{ maxItems: 2, maxCharacters: 100, maxAgeMs: 3_600_000, overflowPolicy: 'evict_oldest' },
			'2026-09-30T11:00:00.000Z',
		)
		expect(result.retained).toEqual([])
		expect(result.evicted).toMatchObject([{ entry: { portion: { id: 'exact-expiry' } }, reason: 'age' }])
		expect(result.rejected).toMatchObject([{ portion: { id: 'exact-expiry' } }])
	})

	it('enforces shrunk count and character bounds with explicit reasons', () => {
		const older = portion('older', '12345')
		const newer = portion('newer', '67890')
		const result = retainDiscoveryBuffer(
			[
				entry(older, '2026-09-30T08:00:00.000Z', '2026-09-30T12:00:00+02:00', '2026-10-01T00:00:00.000Z'),
				entry(newer, '2026-09-30T09:00:00.000Z', '2026-09-30T10:30:00.000Z', '2026-10-01T00:00:00.000Z'),
			],
			[],
			{ maxItems: 1, maxCharacters: 4, maxAgeMs: 86_400_000, overflowPolicy: 'reject_new' },
			'2026-09-30T11:00:00.000Z',
		)
		expect(result.retained).toEqual([])
		expect(result.evicted.map(({ entry: value, reason }) => [value.portion.id, reason])).toEqual([
			['older', 'count'], ['newer', 'characters'],
		])
	})

	it('evicts expired entries and rejects new overflow without exceeding bounds', () => {
		const expired = portion('expired', 'old')
		const kept = portion('kept', '1234')
		const rejected = portion('rejected', '5678')
		const result = retainDiscoveryBuffer(
			[entry(expired, '2026-09-29T09:00:00.000Z', '2026-09-29T09:00:00.000Z', '2026-09-29T10:00:00.000Z'), entry(kept, '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z', '2026-10-01T10:00:00.000Z')],
			[action(rejected)],
			{ maxItems: 1, maxCharacters: 4, maxAgeMs: 86_400_000, overflowPolicy: 'reject_new' },
			'2026-09-30T11:00:00.000Z',
		)
		expect(result.retained.map(({ portion: value }) => value.id)).toEqual(['kept'])
		expect(result.evicted).toMatchObject([{ entry: { portion: { id: 'expired' } }, reason: 'age' }])
		expect(result.rejected).toMatchObject([{ portion: { id: 'rejected' } }])
	})
})
