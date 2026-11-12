import type { EvolutionLensDefinition } from '../src/brain/evolution/contracts'
import {
	createLegacyV006BrainSource,
	createLegacyV006NeuronSource,
	executeLegacyV006BrainMigration,
	executeLegacyV006NeuronMigration,
	inspectLegacyV006Migration,
	type LegacyMigrationInspectInput,
	type LegacyMigrationRuntimeCompatibility,
} from '../src/brain/migration'
import type { BrainStore, NeuronStore } from '../src/stores'

interface TestApi {
	describe(name: string, fn: () => void): void
	it(name: string, fn: () => Promise<void> | void): void
	expect: any
}

export interface MigrationScenario {
	sourceBrain: BrainStore
	targetBrain: BrainStore
	reopenTargetBrain(): BrainStore
	sourceNeuron: NeuronStore
	targetNeuron: NeuronStore
	reopenTargetNeuron(): NeuronStore
	cleanup(): void
}

const fixture = {
	createdAt: '2026-10-01T10:00:00.000Z',
	updatedAt: '2026-10-01T10:01:00.000Z',
	journalId: 'adapt.v2.migration.test',
	migrationId: 'migration-test',
	sourceId: 'legacy-source',
	targetId: 'v2-target',
	registryId: 'registry-migrated',
	textLensId: 'text-lens',
	internalLensId: 'internal-lens',
	textPhysicalId: 'physical-text',
	internalPhysicalId: 'internal-lens',
	textUnderstanding: 'Durable learned text.',
	textObservation: 'Derived text observation.',
	internalUnderstanding: 'Internal learned text.',
	internalObservation: 'Derived internal observation.',
	dismissedPendingText: 'Unresolved pending batch.',
	dismissedRetriedText: 'Unresolved retried batch.',
}

function state(id: string, value: unknown) {
	return { id, value, updated_at: fixture.createdAt }
}

async function seedLegacyNeuron(
	store: NeuronStore,
	kind: 'text' | 'internal',
): Promise<void> {
	const internal = kind === 'internal'
	await store.state.add(state('instructions', `Track ${kind} knowledge.`))
	await store.state.add(state('models', {
		default: { plugin: 'local-test', provider: 'fixture', id: 'model-1' },
		query: { plugin: 'local-test', provider: 'fixture', id: 'model-1' },
	}))
	await store.state.add(state('observation_schema', { type: 'string' }))
	await store.state.add(state('understanding_schema', { type: 'string' }))
	await store.observations.add({
		id: `${kind}-observation`,
		data: internal ? fixture.internalObservation : fixture.textObservation,
		metadata_importance: 0.8,
		metadata_tokens: 5,
		metadata_status: internal ? 'pending' : 'processed',
		metadata_created_at: fixture.createdAt,
	})
	await store.understanding.add({
		id: 'current',
		data: internal ? fixture.internalUnderstanding : fixture.textUnderstanding,
		metadata_confidence: 1,
		metadata_created_at: fixture.createdAt,
		metadata_updated_at: fixture.updatedAt,
	})
	await store.evolution.add({
		id: `${kind}-evolution`,
		summary: `Learned ${kind} state.`,
		significance: 'notable',
		created_at: fixture.updatedAt,
	})
}

async function seedLegacyBrain(store: BrainStore): Promise<void> {
	await store.state.add(state('prompt', 'Track project knowledge.'))
	await store.state.add(state('models', {
		default: { plugin: 'local-test', provider: 'fixture', id: 'model-1' },
		query: { plugin: 'local-test', provider: 'fixture', id: 'model-1' },
	}))
	await store.neurons.add({ id: fixture.textLensId, type: 'text', status: 'active' })
	await store.internalNeurons.add({ id: fixture.internalLensId, type: 'text', status: 'active' })
	await seedLegacyNeuron(store.getNeuronStore(fixture.textLensId), 'text')
	await seedLegacyNeuron(store.getNeuronStore(fixture.internalLensId), 'internal')
	await store.evolution.add({
		id: 'brain-evolution',
		decisions: [{ action: 'create', lens: fixture.textLensId }],
		source: 'manual',
		created_at: fixture.createdAt,
	})
	await store.dismissedBatches.add({
		id: 'dismissed-pending',
		data: [fixture.dismissedPendingText],
		gaps: ['pending gap'],
		timestamp: fixture.createdAt,
		retryCount: 0,
		status: 'pending',
	})
	await store.dismissedBatches.add({
		id: 'dismissed-retried',
		data: [fixture.dismissedRetriedText],
		gaps: ['retried gap'],
		timestamp: fixture.updatedAt,
		retryCount: 1,
		status: 'retried',
	})
}

function compatibility(overrides: Partial<LegacyMigrationRuntimeCompatibility> = {}): LegacyMigrationRuntimeCompatibility {
	return {
		validateModelReference({ reference }) {
			if (!reference || typeof reference !== 'object') return 'model reference is invalid'
			return (reference as { plugin?: unknown }).plugin === 'local-test'
				? undefined
				: 'model runtime is unavailable'
		},
		validateSchema({ schema }) {
			return schema && typeof schema === 'object' ? undefined : 'schema is unavailable'
		},
		buildLens({ record, state: records }): EvolutionLensDefinition {
			const instructions = records.find(({ id }) => id === 'instructions')?.value
			return {
				id: record.id,
				name: record.id,
				description: `Migrated ${record.type} lens.`,
				type: record.type as 'text',
				memory_schema: { id: `adapt.memory.${record.type}`, version: '1' },
				recipe: { id: `adapt.learning.${record.type}`, version: '1' },
				recipe_composition: [],
				dependencies: [],
				settings: {},
				developer_constraints: {
					instructions: [String(instructions)],
					local_only: true,
					provider_permissions: ['local-test'],
				},
			}
		},
		hasRecipe: () => true,
		...overrides,
	}
}

function inspectInput(
	source: LegacyMigrationInspectInput['source'],
	compatibilityPort = compatibility(),
): LegacyMigrationInspectInput {
	return {
		source,
		compatibility: compatibilityPort,
		bounds: {
			maxLenses: 4,
			maxBrainRecords: 20,
			maxBrainChars: 50_000,
			maxRecordsPerLens: 20,
			maxSnapshotChars: 50_000,
			maxDismissedBatches: 4,
		},
		ids: {
			migrationId: fixture.migrationId,
			journalStateId: fixture.journalId,
			targetRegistryRevisionId: fixture.registryId,
			targetRegistryRevision: 1,
			targetPhysicalStoreIds: {
				[fixture.textLensId]: fixture.textPhysicalId,
				[fixture.internalLensId]: fixture.internalPhysicalId,
			},
		},
		revisions: { initialMemoryRevision: 1, initialConfigRevision: 1 },
		clock: { now: () => fixture.createdAt },
	}
}

export function registerMigrationV006Contract(
	api: TestApi,
	adapterName: string,
	createScenario: () => MigrationScenario,
): void {
	const { describe, expect, it } = api
	describe(`${adapterName} v0.0.6 migration`, () => {
		it('recovers partial Brain migration and preserves learned and unfinished state', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyBrain(scenario.sourceBrain)
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId,
					storeKind: adapterName.includes('Memory') ? 'memory' : adapterName.includes('bun') ? 'sqlite-bun' : 'sqlite-node',
					declaredVersion: '0.0.6',
					assertExclusive() {},
					store: scenario.sourceBrain,
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				expect(inspected.status).toBe('ready')
				if (inspected.status !== 'ready') return
				const textTarget = inspected.plan.targets.find(({ lensId }) => lensId === fixture.textLensId)
				const internalTarget = inspected.plan.targets.find(({ lensId }) => lensId === fixture.internalLensId)
				expect(textTarget?.snapshot.understanding[0]?.metadata_confidence_provenance).toBe('legacy-default')
				expect(internalTarget?.snapshot.understanding[0]?.data).toBe(fixture.internalUnderstanding)
				expect(inspected.plan.brain?.dismissedBatches.map(({ status }) => status)).toEqual(['pending', 'retried'])

				let interrupted = false
				const failed = await executeLegacyV006BrainMigration({
					source,
					plan: inspected.plan,
					targetId: fixture.targetId,
					target: scenario.targetBrain,
					assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
					options: {
						onStage(stage) {
							if (!interrupted && stage === 'after-target-write') {
								interrupted = true
								throw new Error('injected migration interruption')
							}
						},
					},
				})
				expect(failed.status).toBe('failure')
				expect(await scenario.targetBrain.registryHeads.get('current')).toBeUndefined()
				const journal = await scenario.targetBrain.state.get(fixture.journalId)
				expect(JSON.stringify(journal?.value)).not.toContain(fixture.textUnderstanding)
				expect(await scenario.sourceBrain.getNeuronStore(fixture.textLensId).understanding.get('current')).toBeDefined()

				await scenario.targetBrain.dispose()
				const reopened = scenario.reopenTargetBrain()
				const recovered = await executeLegacyV006BrainMigration({
					source,
					plan: inspected.plan,
					targetId: fixture.targetId,
					target: reopened,
					assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})
				expect(recovered).toMatchObject({ status: 'completed', deduplicated: false, registryRevisionId: fixture.registryId })
				expect((await reopened.registryHeads.get('current'))?.revision_id).toBe(fixture.registryId)
				expect((await reopened.getNeuronStore(fixture.textPhysicalId).understanding.get('current'))?.data).toBe(fixture.textUnderstanding)
				expect(await reopened.dismissedBatches.count()).toBe(2)
				expect(await executeLegacyV006BrainMigration({
					source,
					plan: inspected.plan,
					targetId: fixture.targetId,
					target: reopened,
					assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})).toMatchObject({ status: 'completed', deduplicated: true })
				await reopened.dispose()
			} finally {
				await scenario.sourceBrain.dispose()
				scenario.cleanup()
			}
		})

		it('refuses a legacy Brain with a list lens', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyBrain(scenario.sourceBrain)
				await scenario.sourceBrain.neurons.add({ id: 'list-lens', type: 'list', status: 'active' })
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: scenario.sourceBrain,
				})
				const result = await inspectLegacyV006Migration(inspectInput(source))
				expect(result.status).toBe('incompatible')
				if (result.status === 'incompatible') {
					expect(result.issues).toContainEqual(expect.objectContaining({
						code: 'unsupported-lens-type', lensId: 'list-lens',
					}))
				}
				expect(await scenario.targetBrain.state.count()).toBe(0)
			} finally {
				await scenario.sourceBrain.dispose()
				await scenario.targetBrain.dispose()
				scenario.cleanup()
			}
		})

		it('reports incompatible schema, runtime, recipe, and dismissed status before writing', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyBrain(scenario.sourceBrain)
				await scenario.sourceBrain.dismissedBatches.add({
					id: 'dismissed-unknown', data: [], gaps: [], timestamp: fixture.createdAt,
					retryCount: 0, status: 'unknown',
				})
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: scenario.sourceBrain,
				})
				const result = await inspectLegacyV006Migration(inspectInput(source, compatibility({
					validateModelReference: () => 'missing runtime',
					validateSchema: () => 'unsupported schema',
					hasRecipe: () => false,
				})))
				expect(result.status).toBe('incompatible')
				if (result.status === 'incompatible') {
					expect(new Set(result.issues.map(({ code }) => code))).toEqual(new Set([
						'unavailable-model-runtime', 'incompatible-schema', 'unavailable-recipe',
						'unknown-dismissed-status',
					]))
				}
				expect(await scenario.targetBrain.state.count()).toBe(0)
			} finally {
				await scenario.sourceBrain.dispose()
				await scenario.targetBrain.dispose()
				scenario.cleanup()
			}
		})

		it('rejects source drift and occupied targets without clearing them', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyBrain(scenario.sourceBrain)
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: scenario.sourceBrain,
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				if (inspected.status !== 'ready') throw new Error('fixture inspection failed')
				await scenario.sourceBrain.state.add(state('drift', true))
				const drift = await executeLegacyV006BrainMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: scenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})
				expect(drift.status).toBe('failure')
				expect(await scenario.targetBrain.state.count()).toBe(0)

				const stableSource = createLegacyV006BrainSource({
					sourceId: `${fixture.sourceId}-stable`, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: scenario.sourceBrain,
				})
				const stableInput = inspectInput(stableSource)
				stableInput.ids.migrationId = `${fixture.migrationId}-stable`
				const stable = await inspectLegacyV006Migration(stableInput)
				if (stable.status !== 'ready') throw new Error('stable fixture inspection failed')
				await scenario.targetBrain.state.add(state('occupied', 'preserve me'))
				const occupied = await executeLegacyV006BrainMigration({
					source: stableSource, plan: stable.plan, targetId: fixture.targetId,
					target: scenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})
				expect(occupied.status).toBe('failure')
				expect((await scenario.targetBrain.state.get('occupied'))?.value).toBe('preserve me')
			} finally {
				await scenario.sourceBrain.dispose()
				await scenario.targetBrain.dispose()
				scenario.cleanup()
			}
		})

		it('recovers standalone neuron migration from its metadata-only journal', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyNeuron(scenario.sourceNeuron, 'text')
				const source = createLegacyV006NeuronSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: scenario.sourceNeuron,
					lensId: fixture.textLensId, lensType: 'text',
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				if (inspected.status !== 'ready') throw new Error('fixture inspection failed')
				let fail = true
				expect((await executeLegacyV006NeuronMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: scenario.targetNeuron, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
					options: { onStage(stage) { if (fail && stage === 'after-journal') { fail = false; throw new Error('standalone interruption') } } },
				})).status).toBe('failure')
				expect(await scenario.targetNeuron.understanding.count()).toBe(0)
				const journal = await scenario.targetNeuron.state.get(fixture.journalId)
				expect(JSON.stringify(journal?.value)).not.toContain(fixture.textUnderstanding)

				await scenario.targetNeuron.dispose()
				const reopened = scenario.reopenTargetNeuron()
				expect(await executeLegacyV006NeuronMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: reopened, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})).toMatchObject({ status: 'completed', deduplicated: false })
				expect((await reopened.understanding.get('current'))?.metadata_confidence_provenance).toBe('legacy-default')
				expect(await executeLegacyV006NeuronMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: reopened, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})).toMatchObject({ status: 'completed', deduplicated: true })
				await reopened.dispose()
			} finally {
				await scenario.sourceNeuron.dispose()
				scenario.cleanup()
			}
		})

		it('keeps completed migration receipts valid after later learned-state changes', async () => {
			const scenario = createScenario()
			try {
				await seedLegacyBrain(scenario.sourceBrain)
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId,
					storeKind: adapterName.includes('Memory') ? 'memory' : adapterName.includes('bun') ? 'sqlite-bun' : 'sqlite-node',
					declaredVersion: '0.0.6', assertExclusive() {}, store: scenario.sourceBrain,
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				if (inspected.status !== 'ready') throw new Error('fixture inspection failed')
				expect(await executeLegacyV006BrainMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: scenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})).toMatchObject({ status: 'completed', deduplicated: false })
				const learnedStore = scenario.targetBrain.getNeuronStore(fixture.textPhysicalId)
				await learnedStore.understanding.add({
					id: 'learned-after-migration', data: 'Newer learned state.',
					metadata_confidence: null,
					metadata_confidence_provenance: 'unknown',
					metadata_created_at: fixture.updatedAt,
					metadata_updated_at: fixture.updatedAt,
				})
				expect(await executeLegacyV006BrainMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: scenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
				})).toMatchObject({ status: 'completed', deduplicated: true })
				expect((await learnedStore.understanding.get('learned-after-migration'))?.data)
					.toBe('Newer learned state.')
			} finally {
				await scenario.sourceBrain.dispose()
				await scenario.targetBrain.dispose()
				scenario.cleanup()
			}
		})

		it('detects verifier mutation and target Brain writes before publication', async () => {
			const verifierScenario = createScenario()
			try {
				await seedLegacyBrain(verifierScenario.sourceBrain)
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: verifierScenario.sourceBrain,
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				if (inspected.status !== 'ready') throw new Error('fixture inspection failed')
				let mutated = false
				const result = await executeLegacyV006BrainMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: verifierScenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
					options: {
						verifier: {
							async verifyTarget({ target }) {
								if (mutated) return
								mutated = true
								await verifierScenario.targetBrain
									.getNeuronStore(target.physicalStoreId)
									.understanding.add({
										id: 'verifier-mutation', data: 'Mutation must block publish.',
										metadata_confidence: null,
										metadata_created_at: fixture.updatedAt,
										metadata_updated_at: fixture.updatedAt,
									})
							},
						},
					},
				})
				expect(result.status).toBe('failure')
				expect(await verifierScenario.targetBrain.registryHeads.get('current')).toBeUndefined()
			} finally {
				await verifierScenario.sourceBrain.dispose()
				await verifierScenario.targetBrain.dispose()
				verifierScenario.cleanup()
			}

			const publicationScenario = createScenario()
			try {
				await seedLegacyBrain(publicationScenario.sourceBrain)
				const source = createLegacyV006BrainSource({
					sourceId: fixture.sourceId, storeKind: 'memory', declaredVersion: '0.0.6',
					assertExclusive() {}, store: publicationScenario.sourceBrain,
				})
				const inspected = await inspectLegacyV006Migration(inspectInput(source))
				if (inspected.status !== 'ready') throw new Error('fixture inspection failed')
				const result = await executeLegacyV006BrainMigration({
					source, plan: inspected.plan, targetId: fixture.targetId,
					target: publicationScenario.targetBrain, assertTargetExclusive() {},
					clock: { now: () => fixture.updatedAt },
					options: {
						async onStage(stageName) {
							if (stageName === 'before-publish') {
								await publicationScenario.targetBrain.state.add(state('concurrent-write', true))
							}
						},
					},
				})
				expect(result.status).toBe('failure')
				expect((await publicationScenario.targetBrain.state.get('concurrent-write'))?.value).toBe(true)
				expect(await publicationScenario.targetBrain.registryHeads.get('current')).toBeUndefined()
			} finally {
				await publicationScenario.sourceBrain.dispose()
				await publicationScenario.targetBrain.dispose()
				publicationScenario.cleanup()
			}
		})
	})
}
