import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ManifestEntry {
	readonly path: string
	readonly role: string
	readonly visibility: string
	readonly sha256: string
	readonly inputCount?: number
	readonly caseCount?: number
}

interface Manifest {
	readonly schemaVersion: number
	readonly synthetic: boolean
	readonly authoringSource: { readonly path: string; readonly sha256: string }
	readonly files: readonly ManifestEntry[]
}

interface TextInput {
	readonly deliveryId: string
	readonly eventId?: string
	readonly text: string
	readonly observedAt: string
	readonly urgency?: string
}

interface StreamFixture {
	readonly schemaVersion: number
	readonly synthetic: boolean
	readonly visibility: string
	readonly id: string
	readonly checkpoints: readonly number[]
	readonly lens: {
		readonly purpose: string
		readonly developerInstructions: readonly string[]
		readonly instructionPrecedence: readonly string[]
		readonly incomingTextRole: string
	}
	readonly inputs: readonly TextInput[]
}

interface AuthoringSourceInventory {
	readonly streams: readonly {
		readonly id: string
		readonly background: { readonly catalogueId: string }
	}[]
	readonly backgroundCatalogue: {
		readonly streams: Readonly<
			Record<
				string,
				readonly {
					readonly id: string
					readonly kind: 'learning' | 'noise'
					readonly states: readonly string[]
					readonly evidence: readonly string[]
				}[]
			>
		>
	}
}

interface ReviewerKey {
	readonly schemaVersion: number
	readonly synthetic: boolean
	readonly modelInput: boolean
	readonly streamId?: string
	readonly checkpoints?: readonly {
		readonly afterInput: number
		readonly expectations: readonly {
			readonly id: string
			readonly critical: boolean
			readonly expected: readonly string[]
			readonly unacceptable: readonly string[]
		}[]
	}[]
	readonly cases?: readonly unknown[]
}

const repositoryRoot = resolve(import.meta.dirname, '..')
const manifestPath = resolve(
	repositoryRoot,
	'evals/config/adaptive-text-learning/fixture-manifest.json',
)

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixtureManifest(): Manifest {
	return readJson<Manifest>(manifestPath)
}

function entries(role: string): readonly ManifestEntry[] {
	return fixtureManifest().files.filter((entry) => entry.role === role)
}

function fixturePath(path: string): string {
	return resolve(repositoryRoot, path)
}

describe('adaptive text learning frozen fixtures', () => {
	it('freezes four explicitly synthetic 180-input streams and six checkpoints', () => {
		const streams = entries('input-stream')
		expect(streams).toHaveLength(4)
		expect(
			streams.filter(({ visibility }) => visibility === 'development'),
		).toHaveLength(3)
		expect(
			streams.filter(({ visibility }) => visibility === 'sealed-heldout'),
		).toHaveLength(1)

		for (const entry of streams) {
			const stream = readJson<StreamFixture>(fixturePath(entry.path))
			expect(stream.schemaVersion).toBe(1)
			expect(stream.synthetic).toBe(true)
			expect(stream.inputs).toHaveLength(entry.inputCount)
			expect(entry.inputCount).toBe(180)
			expect(stream.checkpoints).toEqual([30, 60, 90, 120, 150, 180])
			expect(stream.lens.purpose.length).toBeGreaterThan(0)
			expect(stream.lens.developerInstructions.length).toBeGreaterThan(0)
			expect(stream.lens.incomingTextRole).toBe('data-only')
		}
	})

	it('builds each stream from nine evolving threads and only two noise threads', () => {
		const manifest = fixtureManifest()
		const source = readJson<AuthoringSourceInventory>(
			fixturePath(manifest.authoringSource.path),
		)

		for (const streamSpec of source.streams) {
			const catalogue =
				source.backgroundCatalogue.streams[streamSpec.background.catalogueId]
			expect(catalogue).toHaveLength(11)
			expect(catalogue?.filter(({ kind }) => kind === 'learning')).toHaveLength(9)
			expect(catalogue?.filter(({ kind }) => kind === 'noise')).toHaveLength(2)
			for (const thread of catalogue ?? []) {
				expect(thread.states).toHaveLength(6)
				expect(thread.evidence).toHaveLength(6)
			}

			const streamEntry = entries('input-stream').find((entry) => {
				const stream = readJson<StreamFixture>(fixturePath(entry.path))
				return stream.id === streamSpec.id
			})
			expect(streamEntry).toBeDefined()
			const stream = readJson<StreamFixture>(
				fixturePath(streamEntry?.path ?? ''),
			)
			const backgroundInputs = stream.inputs.filter(({ deliveryId }) =>
				deliveryId.includes(':thread:'),
			)
			expect(backgroundInputs).toHaveLength(132)
			const noiseThreadIds = new Set(
				(catalogue ?? [])
					.filter(({ kind }) => kind === 'noise')
					.map(({ id }) => id),
			)
			const noiseInputs = backgroundInputs.filter(({ deliveryId }) =>
				[...noiseThreadIds].some((id) =>
					deliveryId.includes(`:thread:${id}:`),
				),
			)
			expect(noiseInputs).toHaveLength(24)
		}
	})

	it('keeps input identity complete, chronological, and explicit about exact retries', () => {
		for (const entry of entries('input-stream')) {
			const stream = readJson<StreamFixture>(fixturePath(entry.path))
			const byDelivery = new Map<string, TextInput[]>()
			let previousTime = Number.NEGATIVE_INFINITY

			for (const input of stream.inputs) {
				expect(input.deliveryId.length).toBeGreaterThan(0)
				expect(input.text.length).toBeGreaterThan(0)
				expect(['normal', 'urgent']).toContain(input.urgency)
				const observedAt = Date.parse(input.observedAt)
				expect(Number.isFinite(observedAt)).toBe(true)
				expect(observedAt).toBeGreaterThanOrEqual(previousTime)
				previousTime = observedAt
				const records = byDelivery.get(input.deliveryId) ?? []
				records.push(input)
				byDelivery.set(input.deliveryId, records)
			}

			const retries = [...byDelivery.values()].filter(
				(records) => records.length > 1,
			)
			expect(retries.length).toBeGreaterThan(0)
			for (const records of retries) {
				expect(records).toHaveLength(2)
				expect(records[1]).toEqual(records[0])
			}
		}
	})

	it('includes correction lineage distinct from delivery retry identity', () => {
		for (const entry of entries('input-stream')) {
			const stream = readJson<StreamFixture>(fixturePath(entry.path))
			const byEvent = new Map<string, Set<string>>()
			for (const input of stream.inputs) {
				if (input.eventId === undefined) continue
				const deliveries = byEvent.get(input.eventId) ?? new Set<string>()
				deliveries.add(input.deliveryId)
				byEvent.set(input.eventId, deliveries)
			}
			expect(
				[...byEvent.values()].some((deliveryIds) => deliveryIds.size > 1),
			).toBe(true)
		}
	})

	it('separates reviewer-only expectations at every checkpoint', () => {
		const streamEntries = entries('input-stream')
		const reviewerEntries = entries('reviewer-key')
		expect(reviewerEntries).toHaveLength(5)

		for (const streamEntry of streamEntries) {
			const stream = readJson<StreamFixture>(fixturePath(streamEntry.path))
			const reviewerEntry = reviewerEntries.find((entry) => {
				const reviewer = readJson<ReviewerKey>(fixturePath(entry.path))
				return reviewer.streamId === stream.id
			})
			expect(reviewerEntry).toBeDefined()
			const reviewer = readJson<ReviewerKey>(
				fixturePath(reviewerEntry?.path ?? ''),
			)
			expect(reviewer.modelInput).toBe(false)
			expect(reviewer.checkpoints).toHaveLength(6)
			expect(reviewer.checkpoints?.map(({ afterInput }) => afterInput)).toEqual(
				stream.checkpoints,
			)
			for (const checkpoint of reviewer.checkpoints ?? []) {
				expect(checkpoint.expectations.length).toBeGreaterThanOrEqual(3)
				expect(
					checkpoint.expectations.some(({ critical }) => critical),
				).toBe(true)
				for (const expectation of checkpoint.expectations) {
					expect(expectation.expected.length).toBeGreaterThan(0)
					expect(expectation.unacceptable.length).toBeGreaterThan(0)
				}
			}
		}
	})

	it('covers every operation and all four executable procedures in module cases', () => {
		const [moduleEntry] = entries('module-inputs')
		expect(moduleEntry).toBeDefined()
		const fixture = readJson<{
			cases: readonly {
				kind: string
				procedure?: string
				selection?: { allowed: readonly { id: string }[] }
			}[]
		}>(fixturePath(moduleEntry?.path ?? ''))
		expect(fixture.cases).toHaveLength(moduleEntry?.caseCount)
		expect(fixture.cases.length).toBeGreaterThanOrEqual(12)
		expect(fixture.cases.length).toBeLessThanOrEqual(20)
		expect(new Set(fixture.cases.map(({ kind }) => kind))).toEqual(
			new Set(['writer', 'compare', 'pattern', 'combined', 'selector']),
		)
		const procedureIds = new Set(
			fixture.cases.flatMap((suppliedCase) => [
				...(suppliedCase.procedure === undefined
					? []
					: [suppliedCase.procedure]),
				...(suppliedCase.selection?.allowed.map(({ id }) => id) ?? []),
			]),
		)
		expect(procedureIds).toEqual(
			new Set([
				'direct',
				'compare-rewrite',
				'pattern-rewrite',
				'compare-pattern-rewrite',
			]),
		)
	})

	it('matches every frozen content hash in the fixture manifest', () => {
		const manifest = fixtureManifest()
		expect(manifest.schemaVersion).toBe(1)
		expect(manifest.synthetic).toBe(true)
		expect(sha256(fixturePath(manifest.authoringSource.path))).toBe(
			manifest.authoringSource.sha256,
		)
		for (const entry of manifest.files) {
			expect(sha256(fixturePath(entry.path))).toBe(entry.sha256)
		}
	})
})
