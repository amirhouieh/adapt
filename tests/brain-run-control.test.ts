import { describe, expect, it } from 'vitest'
import { BrainRunCoordinator } from '../src/brain/run-control'
import type { PinnedEvolutionRegistry } from '../src/brain/evolution'

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function pinned(id = 'registry-one'): PinnedEvolutionRegistry {
	return {
		revision: { id, revision: 1, lenses: [], created_at: '2026-10-01T00:00:00.000Z' },
		getLens() {
			return undefined
		},
	}
}

describe('BrainRunCoordinator', () => {
	it('serializes overlapping mutations while disjoint work proceeds', async () => {
		const firstRelease = deferred()
		const events: string[] = []
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned()
			},
		})
		const first = coordinator.runMutation(['b', 'a'], async () => {
			events.push('first-start')
			await firstRelease.promise
			events.push('first-end')
		})
		const overlap = coordinator.runMutation(['c', 'b'], async () => {
			events.push('overlap')
		})
		const disjoint = coordinator.runMutation(['d'], async () => {
			events.push('disjoint')
		})
		await disjoint
		expect(events).toEqual(['first-start', 'disjoint'])
		firstRelease.resolve()
		await Promise.all([first, overlap])
		expect(events).toEqual(['first-start', 'disjoint', 'first-end', 'overlap'])
	})

	it('blocks new affected mutations, drains admitted work, and keeps unrelated lenses running', async () => {
		const activeRelease = deferred()
		const events: string[] = []
		let currentRevision = 'registry-current'
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned(currentRevision)
			},
		})
		const active = coordinator.runMutation(['lens-a'], async (registry) => {
			events.push(`active:${registry.revision.id}`)
			await activeRelease.promise
		})
		const control = coordinator.createEvolutionRunControl({
			publication: {
				async publish(registry) {
					events.push(`publish:${registry.revision.id}`)
				},
			},
		})
		await control.quiesce(['lens-a'])
		const idle = control.waitForIdle(['lens-a']).then(() => events.push('idle'))
		const blocked = coordinator.runMutation(['lens-a'], async () => {
			events.push('blocked-ran')
		})
		await coordinator.runMutation(['lens-b'], async () => {
			events.push('unrelated')
		})
		expect(events).toEqual(['active:registry-current', 'unrelated'])
		activeRelease.resolve()
		await active
		await idle
		expect(events).toEqual(['active:registry-current', 'unrelated', 'idle'])
		currentRevision = 'registry-target'
		await control.resume(['lens-a'], 'registry-target')
		await blocked
		expect(events).toEqual([
			'active:registry-current',
			'unrelated',
			'idle',
			'publish:registry-target',
			'blocked-ran',
		])
	})

	it('removes a cancelled queued mutation without blocking later work', async () => {
		const release = deferred()
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned()
			},
		})
		const active = coordinator.runMutation(['lens'], async () => release.promise)
		const abort = new AbortController()
		const cancelled = coordinator.runMutation(['lens'], async () => undefined, {
			signal: abort.signal,
		})
		const later = coordinator.runMutation(['lens'], async () => 'later')
		abort.abort(new Error('cancelled by test'))
		await expect(cancelled).rejects.toThrow('cancelled by test')
		release.resolve()
		await active
		await expect(later).resolves.toBe('later')
	})

	it('orders partially overlapping fence leases and permits a disjoint fence', async () => {
		const events: string[] = []
		let currentRevision = 'registry-one'
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned(currentRevision)
			},
		})
		const controlOne = coordinator.createEvolutionRunControl({
			publication: { async publish() {} },
		})
		const controlTwo = coordinator.createEvolutionRunControl({
			publication: { async publish() {} },
		})
		const controlThree = coordinator.createEvolutionRunControl({
			publication: { async publish() {} },
		})
		await controlOne.quiesce(['a', 'b'])
		const second = controlTwo.quiesce(['b', 'c']).then(() => events.push('second'))
		await controlThree.quiesce(['d'])
		events.push('third')
		expect(events).toEqual(['third'])
		currentRevision = 'registry-two'
		await controlOne.resume(['a', 'b'], 'registry-two')
		await second
		expect(events).toEqual(['third', 'second'])
		currentRevision = 'registry-three'
		await controlTwo.resume(['b', 'c'], 'registry-three')
		await controlThree.resume(['d'], 'registry-three')
	})

	it('keeps the fence held when publication fails and retries on the same lease', async () => {
		let publicationAttempts = 0
		const events: string[] = []
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned('registry-target')
			},
		})
		const control = coordinator.createEvolutionRunControl({
			publication: {
				async publish() {
					publicationAttempts += 1
					if (publicationAttempts === 1) throw new Error('rebind failed')
					events.push('published')
				},
			},
		})
		await control.quiesce(['lens'])
		await control.waitForIdle(['lens'])
		await expect(control.resume(['lens'], 'registry-target')).rejects.toThrow(
			'rebind failed',
		)
		const blocked = coordinator.runMutation(['lens'], async () => {
			events.push('mutation')
		})
		await Promise.resolve()
		expect(events).toEqual([])
		await control.resume(['lens'], 'registry-target')
		await blocked
		expect(events).toEqual(['published', 'mutation'])
		await control.resume(['lens'], 'registry-target')
		await expect(control.resume(['lens'], 'other-registry')).rejects.toThrow(
			'cannot publish two revisions',
		)
	})

	it('coalesces simultaneous publication and binds retries to one revision', async () => {
		const firstPublication = deferred()
		let calls = 0
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned('registry-target')
			},
		})
		const control = coordinator.createEvolutionRunControl({
			publication: {
				async publish() {
					calls += 1
					if (calls === 1) await firstPublication.promise
				},
			},
		})
		await control.quiesce(['lens'])
		const first = control.resume(['lens'], 'registry-target')
		const same = control.resume(['lens'], 'registry-target')
		await expect(control.resume(['lens'], 'registry-other')).rejects.toThrow(
			'cannot publish two revisions',
		)
		expect(calls).toBe(1)
		firstPublication.reject(new Error('first publication failed'))
		await expect(first).rejects.toThrow('first publication failed')
		await expect(same).rejects.toThrow('first publication failed')
		await control.resume(['lens'], 'registry-target')
		expect(calls).toBe(2)
	})

	it('cancels queued fence acquisition and rejects changed lease lens sets', async () => {
		let currentRevision = 'registry-one'
		const coordinator = new BrainRunCoordinator({
			async pinCurrentRegistry() {
				return pinned(currentRevision)
			},
		})
		const first = coordinator.createEvolutionRunControl({
			publication: { async publish() {} },
		})
		await first.quiesce(['lens'])
		const abort = new AbortController()
		const second = coordinator.createEvolutionRunControl({
			publication: { async publish() {} },
			signal: abort.signal,
		})
		const waiting = second.quiesce(['lens'])
		abort.abort(new Error('stop waiting'))
		await expect(waiting).rejects.toThrow('stop waiting')
		await expect(first.waitForIdle(['other'])).rejects.toThrow(
			'cannot change its lens set',
		)
		currentRevision = 'registry-two'
		await first.resume(['lens'], 'registry-two')
		await expect(
			coordinator.runMutation(['lens'], async () => 'available'),
		).resolves.toBe('available')
	})
})
