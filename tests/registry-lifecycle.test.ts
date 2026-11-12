import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeEvolutionRegistry, pinEvolutionRegistry } from '../src/brain/evolution'
import {
	ensureBrainRegistry,
	physicalStoreForLens,
	recoverBrainRegistry,
} from '../src/brain/registry-lifecycle'
import { BrainRunCoordinator } from '../src/brain/run-control'
import { MemoryBrainStore } from '../src/stores'
import { SQLiteBrainStore } from '../src/stores/sqlite/node/brain'
import type {
	BrainEvolutionActivationRecord,
	BrainRegistryLensRecord,
	BrainRegistryRevisionRecord,
	BrainStore,
} from '../src/stores'

const time = {
	created: '2026-10-01T00:00:00.000Z',
	updated: '2026-10-01T00:00:01.000Z',
}

function lens(id: string, physicalStoreId = id): BrainRegistryLensRecord {
	return {
		id,
		physical_store_id: physicalStoreId,
		type: 'text',
		config: { recipe: { id: 'narrative', version: '1' } },
		dependencies: [],
	}
}

async function seedLegacy(store: BrainStore): Promise<void> {
	await store.neurons.add({ id: 'lens-one', type: 'text', status: 'active' })
	await store.getNeuronStore('lens-one').understanding.add({
		id: 'memory-one',
		data: 'learned memory',
		metadata_confidence: null,
		metadata_confidence_provenance: 'unknown',
		metadata_created_at: time.created,
		metadata_updated_at: time.created,
	})
}

async function ensureFixture(store: BrainStore) {
	let idCalls = 0
	let builderCalls = 0
	const registry = await ensureBrainRegistry({
		store,
		initialRevision: 0,
		clock: { now: () => time.created },
		ids: {
			nextRegistryRevisionId() {
				idCalls += 1
				return 'registry-legacy'
			},
		},
		legacyLensBuilder: {
			async build({ record, store: neuronStore }) {
				builderCalls += 1
				expect(await neuronStore.understanding.get('memory-one')).toBeDefined()
				return lens(record.id)
			},
		},
	})
	return { registry, idCalls: () => idCalls, builderCalls: () => builderCalls }
}

function activation(
	base: BrainRegistryRevisionRecord,
	target: BrainRegistryRevisionRecord,
	transformation = false,
): BrainEvolutionActivationRecord {
	return {
		id: 'activation-one',
		proposal_id: 'proposal-one',
		action: 'update',
		intent_digest: 'intent-one',
		mode: 'evolution',
		base_registry_revision_id: base.id,
		target_registry: target,
		source_pins: [],
		affected_lens_ids: ['lens-one'],
		staging_policy: {
			max_targets: 1,
			max_snapshot_records: 10,
			max_snapshot_chars: 1_000,
		},
		...(transformation
			? { transformation_ref: { id: 'transform-one', version: '1' } }
			: {}),
		status: 'activated',
		created_at: time.created,
		updated_at: time.updated,
	}
}

describe('Brain registry lifecycle', () => {
	it('creates an idempotent legacy registry without moving learned memory', async () => {
		const store = new MemoryBrainStore()
		await seedLegacy(store)
		const first = await ensureFixture(store)
		expect(first.registry.revision.id).toBe('registry-legacy')
		expect(first.registry.getLens('lens-one')).toEqual(lens('lens-one'))
		expect(
			await physicalStoreForLens(store, first.registry, 'lens-one').understanding.get(
				'memory-one',
			),
		).toMatchObject({ data: 'learned memory' })
		const second = await ensureFixture(store)
		expect(second.registry.revision).toEqual(first.registry.revision)
		expect(second.idCalls()).toBe(0)
		expect(second.builderCalls()).toBe(0)
		await store.dispose()
	})

	it('persists the legacy registry and physical binding across SQLite reopen', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'adapt-registry-lifecycle-'))
		const path = join(directory, 'brain.db')
		let store = new SQLiteBrainStore(path)
		try {
			await seedLegacy(store)
			await ensureFixture(store)
			await store.dispose()
			store = new SQLiteBrainStore(path)
			const registry = await pinEvolutionRegistry(store)
			expect(registry.getLens('lens-one')?.physical_store_id).toBe('lens-one')
			expect(
				await physicalStoreForLens(store, registry, 'lens-one').understanding.get(
					'memory-one',
				),
			).toMatchObject({ data: 'learned memory' })
		} finally {
			await store.dispose()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it('rejects a legacy builder that changes the existing physical identity', async () => {
		const store = new MemoryBrainStore()
		await seedLegacy(store)
		await expect(
			ensureBrainRegistry({
				store,
				initialRevision: 0,
				clock: { now: () => time.created },
				ids: { nextRegistryRevisionId: () => 'registry-legacy' },
				legacyLensBuilder: {
					async build({ record }) {
						return lens(record.id, 'replacement-store')
					},
				},
			}),
		).rejects.toThrow('changed identity, physical store, or type')
		expect(await store.registryHeads.get('current')).toBeUndefined()
		await store.dispose()
	})

	it('keeps an activated registry fenced until its publication hook recovers', async () => {
		const store = new MemoryBrainStore()
		const base: BrainRegistryRevisionRecord = {
			id: 'registry-base',
			revision: 0,
			lenses: [lens('lens-one', 'store-one')],
			created_at: time.created,
		}
		const target: BrainRegistryRevisionRecord = {
			id: 'registry-target',
			revision: 1,
			parent_id: base.id,
			activation_id: 'activation-one',
			lenses: [lens('lens-one', 'store-two')],
			created_at: time.updated,
		}
		await initializeEvolutionRegistry(store, {
			head_revision_id: base.id,
			revision: base.revision,
			lenses: base.lenses,
			created_at: base.created_at,
		})
		await store.runAtomic((atomic) => {
			atomic.registryRevisions.add(target)
			atomic.registryHeads.update('current', {
				revision_id: target.id,
				revision: target.revision,
				updated_at: time.updated,
			})
			atomic.evolutionActivations.add(activation(base, target))
		})

		let publications = 0
		const coordinator = new BrainRunCoordinator({
			pinCurrentRegistry: () => pinEvolutionRegistry(store),
		})
		const control = coordinator.createEvolutionRunControl({
			publication: {
				async publish() {
					publications += 1
					if (publications === 1) throw new Error('runtime rebind failed')
				},
			},
		})
		const recover = () =>
			recoverBrainRegistry({
				store,
				strategy: () => 'complete',
				createRunControl: () => control,
				resolveTransformationValidator: () => undefined,
			})
		await expect(recover()).resolves.toMatchObject({
			status: 'recovery-required',
			activationId: 'activation-one',
			reason: 'runtime rebind failed',
		})
		const blocked = coordinator.runMutation(['lens-one'], async () => 'released')
		await Promise.resolve()
		expect(await store.evolutionActivations.get('activation-one')).toMatchObject({
			status: 'activated',
		})
		await expect(recover()).resolves.toMatchObject({
			status: 'ready',
			activations: [{ activationId: 'activation-one', status: 'completed' }],
		})
		await expect(blocked).resolves.toBe('released')
		expect(publications).toBe(2)
		await store.dispose()
	})

	it('reports an unavailable transformation validator without mutating recovery state', async () => {
		const store = new MemoryBrainStore()
		const base: BrainRegistryRevisionRecord = {
			id: 'registry-base',
			revision: 0,
			lenses: [lens('lens-one')],
			created_at: time.created,
		}
		const target: BrainRegistryRevisionRecord = {
			id: 'registry-target',
			revision: 1,
			parent_id: base.id,
			activation_id: 'activation-one',
			lenses: [lens('lens-one')],
			created_at: time.updated,
		}
		await initializeEvolutionRegistry(store, {
			head_revision_id: base.id,
			revision: base.revision,
			lenses: base.lenses,
			created_at: base.created_at,
		})
		await store.runAtomic((atomic) => {
			atomic.registryRevisions.add(target)
			atomic.registryHeads.update('current', {
				revision_id: target.id,
				revision: target.revision,
				updated_at: time.updated,
			})
			atomic.evolutionActivations.add(activation(base, target, true))
		})
		const result = await recoverBrainRegistry({
			store,
			strategy: () => 'complete',
			createRunControl() {
				throw new Error('run control must not be created without its validator')
			},
			resolveTransformationValidator: () => undefined,
		})
		expect(result).toMatchObject({
			status: 'recovery-required',
			activationId: 'activation-one',
			reason: 'transformation validator transform-one@1 is unavailable',
		})
		expect(await store.evolutionActivations.get('activation-one')).toMatchObject({
			status: 'activated',
		})
		await store.dispose()
	})

	it('keeps pre-CAS abandonment recoverable until publication succeeds', async () => {
		const store = new MemoryBrainStore()
		const base: BrainRegistryRevisionRecord = {
			id: 'registry-base',
			revision: 0,
			lenses: [lens('lens-one')],
			created_at: time.created,
		}
		const target: BrainRegistryRevisionRecord = {
			id: 'registry-target',
			revision: 1,
			parent_id: base.id,
			activation_id: 'activation-one',
			lenses: [lens('lens-one', 'store-two')],
			created_at: time.updated,
		}
		await initializeEvolutionRegistry(store, {
			head_revision_id: base.id,
			revision: base.revision,
			lenses: base.lenses,
			created_at: base.created_at,
		})
		await store.evolutionActivations.add({
			...activation(base, target),
			status: 'abandoning',
		})
		let publications = 0
		const coordinator = new BrainRunCoordinator({
			pinCurrentRegistry: () => pinEvolutionRegistry(store),
		})
		const control = coordinator.createEvolutionRunControl({
			publication: {
				async publish() {
					publications += 1
					if (publications === 1) throw new Error('base rebind failed')
				},
			},
		})
		await control.quiesce(['lens-one'])
		await control.waitForIdle(['lens-one'])
		const recover = () =>
			recoverBrainRegistry({
				store,
				strategy: () => 'abandon',
				createRunControl: () => control,
				resolveTransformationValidator: () => undefined,
			})
		await expect(recover()).resolves.toMatchObject({
			status: 'recovery-required',
			reason: 'base rebind failed',
		})
		expect(await store.evolutionActivations.get('activation-one')).toMatchObject({
			status: 'abandoning',
		})
		const blocked = coordinator.runMutation(['lens-one'], async () => 'released')
		await expect(recover()).resolves.toMatchObject({
			status: 'ready',
			activations: [{ activationId: 'activation-one', status: 'abandoned' }],
		})
		await expect(blocked).resolves.toBe('released')
		expect(await store.evolutionActivations.get('activation-one')).toMatchObject({
			status: 'abandoned',
		})
		await store.dispose()
	})
})
