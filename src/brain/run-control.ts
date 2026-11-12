import type {
	EvolutionRunControl,
	PinnedEvolutionRegistry,
} from './evolution/contracts'

export interface BrainMutationRunOptions {
	signal?: AbortSignal
}

export interface EvolutionPublicationHook {
	/** Rebind live runtimes only; do not enter a coordinated mutation here. */
	publish(registry: PinnedEvolutionRegistry): Promise<void>
}

export interface BrainRunCoordinatorOptions {
	pinCurrentRegistry(): Promise<PinnedEvolutionRegistry>
}

type RequestKind = 'mutation' | 'fence'

interface AdmissionRequest {
	id: symbol
	kind: RequestKind
	lensIds: readonly string[]
	resolve(): void
	reject(error: unknown): void
	signal?: AbortSignal
	onAbort?: () => void
}

function normalizedLensIds(lensIds: readonly string[]): readonly string[] {
	const unique = [...new Set(lensIds)]
	for (const id of unique) {
		if (typeof id !== 'string' || id.length === 0) {
			throw new Error('lens ids must be non-empty strings')
		}
	}
	unique.sort((left, right) => left.localeCompare(right))
	return Object.freeze(unique)
}

function overlaps(
	left: readonly string[],
	right: ReadonlySet<string>,
): boolean {
	return left.some((id) => right.has(id))
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error('operation cancelled')
}

/**
 * Coordinates Brain-owned mutations with evolution activation. Mutations whose
 * logical lens sets overlap are serialized. A held evolution fence blocks new
 * overlapping mutations while unrelated lenses remain available.
 */
export class BrainRunCoordinator {
	private readonly active = new Set<string>()
	private readonly fenced = new Map<string, symbol>()
	private readonly queue: AdmissionRequest[] = []
	private readonly idleWaiters = new Map<symbol, Set<() => void>>()

	constructor(private readonly options: BrainRunCoordinatorOptions) {}

	async runMutation<TResult>(
		lensIds: readonly string[],
		operation: (registry: PinnedEvolutionRegistry) => Promise<TResult>,
		options: BrainMutationRunOptions = {},
	): Promise<TResult> {
		const ids = normalizedLensIds(lensIds)
		if (ids.length === 0)
			throw new Error('a mutation must identify at least one lens')
		await this.admit('mutation', Symbol('mutation'), ids, options.signal)
		try {
			if (options.signal?.aborted) throw abortReason(options.signal)
			const registry = await this.options.pinCurrentRegistry()
			if (options.signal?.aborted) throw abortReason(options.signal)
			return await operation(registry)
		} finally {
			for (const id of ids) this.active.delete(id)
			this.resolveIdleWaiters()
			this.schedule()
		}
	}

	createEvolutionRunControl(options: {
		publication: EvolutionPublicationHook
		signal?: AbortSignal
	}): EvolutionRunControl {
		const lease = Symbol('evolution-fence')
		let state: 'idle' | 'waiting' | 'held' | 'released' = 'idle'
		let ids: readonly string[] | undefined
		let quiescePromise: Promise<void> | undefined
		let attemptedRevision: string | undefined
		let publicationPromise: Promise<void> | undefined
		let publishedRevision: string | undefined

		const requireSameIds = (lensIds: readonly string[]): readonly string[] => {
			const normalized = normalizedLensIds(lensIds)
			if (normalized.length === 0)
				throw new Error('an evolution fence must identify at least one lens')
			if (
				ids !== undefined &&
				(ids.length !== normalized.length ||
					ids.some((id, index) => id !== normalized[index]))
			) {
				throw new Error('an evolution fence lease cannot change its lens set')
			}
			ids ??= normalized
			return normalized
		}

		return {
			quiesce: async (lensIds) => {
				const normalized = requireSameIds(lensIds)
				if (state === 'held') return
				if (state === 'released')
					throw new Error(
						'an evolution fence lease cannot be reacquired after resume',
					)
				if (quiescePromise) return quiescePromise
				state = 'waiting'
				quiescePromise = this.admit(
					'fence',
					lease,
					normalized,
					options.signal,
				).then(() => {
					state = 'held'
				})
				try {
					await quiescePromise
				} catch (error) {
					state = 'idle'
					quiescePromise = undefined
					throw error
				}
			},
			waitForIdle: async (lensIds) => {
				const normalized = requireSameIds(lensIds)
				if (state !== 'held')
					throw new Error(
						'evolution fence must be quiesced before waiting for idle',
					)
				if (options.signal?.aborted) throw abortReason(options.signal)
				if (!overlaps(normalized, this.active)) return
				await new Promise<void>((resolve, reject) => {
					const waiters = this.idleWaiters.get(lease) ?? new Set<() => void>()
					let settled = false
					const finish = () => {
						if (settled) return
						settled = true
						options.signal?.removeEventListener('abort', cancel)
						waiters.delete(finish)
						if (waiters.size === 0) this.idleWaiters.delete(lease)
						resolve()
					}
					const cancel = () => {
						if (settled) return
						settled = true
						waiters.delete(finish)
						if (waiters.size === 0) this.idleWaiters.delete(lease)
						const signal = options.signal
						reject(
							signal ? abortReason(signal) : new Error('operation cancelled'),
						)
					}
					waiters.add(finish)
					this.idleWaiters.set(lease, waiters)
					if (options.signal?.aborted) cancel()
					else options.signal?.addEventListener('abort', cancel, { once: true })
				})
			},
			resume: async (lensIds, registryRevisionId) => {
				const normalized = requireSameIds(lensIds)
				if (
					typeof registryRevisionId !== 'string' ||
					registryRevisionId.length === 0
				)
					throw new Error('registry revision id must be a non-empty string')
				if (
					attemptedRevision !== undefined &&
					attemptedRevision !== registryRevisionId
				) {
					throw new Error(
						'an evolution fence lease cannot publish two revisions',
					)
				}
				if (publishedRevision !== undefined) {
					return
				}
				if (publicationPromise) return publicationPromise
				attemptedRevision = registryRevisionId
				// Activation can fail before quiesce. There is no held fence or runtime
				// binding to release in that case.
				if (state === 'idle') {
					state = 'released'
					publishedRevision = registryRevisionId
					return
				}
				if (state !== 'held')
					throw new Error('evolution fence is not held by this lease')
				publicationPromise = (async () => {
					const registry = await this.options.pinCurrentRegistry()
					if (registry.revision.id !== registryRevisionId) {
						throw new Error(
							`authoritative registry ${registry.revision.id} does not match publication ${registryRevisionId}`,
						)
					}
					await options.publication.publish(registry)
					publishedRevision = registryRevisionId
					state = 'released'
					for (const id of normalized) {
						if (this.fenced.get(id) === lease) this.fenced.delete(id)
					}
					this.idleWaiters.delete(lease)
					this.schedule()
				})()
				try {
					await publicationPromise
				} catch (error) {
					publicationPromise = undefined
					throw error
				}
			},
		}
	}

	private admit(
		kind: RequestKind,
		id: symbol,
		lensIds: readonly string[],
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortReason(signal))
		return new Promise<void>((resolve, reject) => {
			const request: AdmissionRequest = {
				id,
				kind,
				lensIds,
				resolve,
				reject,
				...(signal ? { signal } : {}),
			}
			if (signal) {
				request.onAbort = () => {
					const index = this.queue.indexOf(request)
					if (index < 0) return
					this.queue.splice(index, 1)
					if (request.onAbort)
						signal.removeEventListener('abort', request.onAbort)
					reject(abortReason(signal))
					this.schedule()
				}
				signal.addEventListener('abort', request.onAbort, { once: true })
			}
			this.queue.push(request)
			this.schedule()
		})
	}

	private schedule(): void {
		const earlierBlocked = new Set<string>()
		let index = 0
		while (index < this.queue.length) {
			const request = this.queue[index]
			if (!request) break
			const conflictsEarlier = overlaps(request.lensIds, earlierBlocked)
			const conflictsFence = request.lensIds.some((id) => this.fenced.has(id))
			const conflictsActive =
				request.kind === 'mutation' && overlaps(request.lensIds, this.active)
			if (conflictsEarlier || conflictsFence || conflictsActive) {
				for (const id of request.lensIds) earlierBlocked.add(id)
				index += 1
				continue
			}
			this.queue.splice(index, 1)
			if (request.onAbort && request.signal)
				request.signal.removeEventListener('abort', request.onAbort)
			if (request.kind === 'mutation') {
				for (const id of request.lensIds) this.active.add(id)
			} else {
				for (const id of request.lensIds) this.fenced.set(id, request.id)
			}
			request.resolve()
		}
	}

	private resolveIdleWaiters(): void {
		for (const [lease, waiters] of this.idleWaiters) {
			const lensIds = [...this.fenced]
				.filter(([, owner]) => owner === lease)
				.map(([id]) => id)
			if (overlaps(lensIds, this.active)) continue
			for (const resolve of [...waiters]) resolve()
		}
	}
}
