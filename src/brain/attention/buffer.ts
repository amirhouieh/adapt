import type {
	AttentionAction,
	DiscoveryBufferEntry,
	DiscoveryBufferEviction,
	DiscoveryBufferPolicy,
	DiscoveryBufferResult,
} from './contracts'

function requirePositive(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`)
	}
}

function parseTime(value: string, name: string): number {
	const time = Date.parse(value)
	if (!Number.isFinite(time))
		throw new Error(`${name} must be an ISO timestamp`)
	return time
}

function characters(entry: DiscoveryBufferEntry): number {
	return entry.portion.text.length
}

function sameCanonicalPortion(
	left: DiscoveryBufferEntry['portion'],
	right: DiscoveryBufferEntry['portion'],
): boolean {
	return (
		left.id === right.id &&
		left.inputId === right.inputId &&
		left.sourceId === right.sourceId &&
		left.text === right.text &&
		left.observedAt === right.observedAt &&
		left.eventAt === right.eventAt
	)
}

export function retainDiscoveryBuffer(
	existing: readonly DiscoveryBufferEntry[],
	additions: readonly AttentionAction[],
	policy: DiscoveryBufferPolicy,
	now: string,
): DiscoveryBufferResult {
	requirePositive(policy.maxItems, 'maxItems')
	requirePositive(policy.maxCharacters, 'maxCharacters')
	requirePositive(policy.maxAgeMs, 'maxAgeMs')
	const nowMs = parseTime(now, 'now')
	const byId = new Map<string, DiscoveryBufferEntry>()
	const originalById = new Map<string, DiscoveryBufferEntry>()
	const expiredIds = new Set<string>()
	const evicted: DiscoveryBufferEviction[] = []
	for (const entry of existing) {
		if (originalById.has(entry.portion.id)) {
			throw new Error(`duplicate discovery entry ${entry.portion.id}`)
		}
		originalById.set(entry.portion.id, entry)
		const firstRetainedAt = parseTime(
			entry.firstRetainedAt,
			'entry.firstRetainedAt',
		)
		const storedExpiry = parseTime(entry.expiresAt, 'entry.expiresAt')
		const expires = Math.min(storedExpiry, firstRetainedAt + policy.maxAgeMs)
		if (expires <= nowMs) {
			evicted.push({ entry, reason: 'age' })
			expiredIds.add(entry.portion.id)
			continue
		}
		byId.set(entry.portion.id, {
			...entry,
			expiresAt: new Date(expires).toISOString(),
		})
	}
	const rejected: AttentionAction[] = []
	for (const action of additions) {
		if (action.kind !== 'discover' && action.kind !== 'recheck') continue
		const current = byId.get(action.portion.id)
		const original = originalById.get(action.portion.id)
		const canonical = original ?? current
		if (canonical && !sameCanonicalPortion(canonical.portion, action.portion)) {
			throw new Error(
				`discovery portion ${action.portion.id} conflicts with retained evidence`,
			)
		}
		if (expiredIds.has(action.portion.id)) {
			rejected.push(action)
			continue
		}
		const firstRetainedAt = current?.firstRetainedAt ?? now
		const firstRetainedMs = parseTime(firstRetainedAt, 'firstRetainedAt')
		const entry: DiscoveryBufferEntry = {
			portion: action.portion,
			uncoveredSpans: action.uncoveredSpans,
			reason: action.reason,
			firstRetainedAt,
			lastRetainedAt: now,
			expiresAt: new Date(firstRetainedMs + policy.maxAgeMs).toISOString(),
			retainCount: (current?.retainCount ?? 0) + 1,
		}
		if (
			policy.overflowPolicy === 'reject_new' &&
			current === undefined &&
			(byId.size + 1 > policy.maxItems ||
				[...byId.values()].reduce((sum, value) => sum + characters(value), 0) +
					characters(entry) >
					policy.maxCharacters)
		) {
			rejected.push(action)
			continue
		}
		byId.set(entry.portion.id, entry)
	}
	const ordered = [...byId.values()].sort(
		(left, right) =>
			parseTime(left.lastRetainedAt, 'entry.lastRetainedAt') -
				parseTime(right.lastRetainedAt, 'entry.lastRetainedAt') ||
			left.portion.id.localeCompare(right.portion.id),
	)
	while (ordered.length > policy.maxItems) {
		const entry = ordered.shift()
		if (entry) evicted.push({ entry, reason: 'count' })
	}
	let total = ordered.reduce((sum, entry) => sum + characters(entry), 0)
	while (ordered.length > 0 && total > policy.maxCharacters) {
		const entry = ordered.shift()
		if (!entry) break
		total -= characters(entry)
		evicted.push({ entry, reason: 'characters' })
	}
	return {
		retained: ordered,
		evicted,
		rejected,
		overflow: evicted.length > 0 || rejected.length > 0,
	}
}
