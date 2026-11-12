import type {
	AttentionCandidateSelection,
	AttentionCandidateSelector,
} from './contracts'

function positiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`)
	}
}

/** Conservatively preserves caller order and reports every semantically omitted lens. */
export function createBoundedCandidateSelector(): AttentionCandidateSelector {
	return {
		select({ lenses, limit }): AttentionCandidateSelection {
			positiveInteger(limit, 'candidate limit')
			const selected = lenses.slice(0, limit)
			return {
				lensIds: selected.map(({ id }) => id),
				metadataExaminedLensIds: [],
				omittedLensIds: lenses.slice(limit).map(({ id }) => id),
				provenance: {
					strategy: 'supplied_order',
					registrySize: lenses.length,
					selectedCount: selected.length,
				},
			}
		},
	}
}

export interface LiteralMetadataLens extends Record<string, unknown> {
	readonly routingTerms: readonly string[]
}

/** A local deterministic selector for caller-supplied literal routing terms. */
export function createLiteralMetadataCandidateSelector(
	parseMetadata: (value: unknown) => LiteralMetadataLens,
): AttentionCandidateSelector {
	return {
		select({ portion, lenses, limit }): AttentionCandidateSelection {
			positiveInteger(limit, 'candidate limit')
			const text = portion.text.normalize('NFKC').toLocaleLowerCase('en-US')
			const ranked = lenses
				.map((lens, index) => {
					const metadata = parseMetadata(lens.metadata)
					const score = metadata.routingTerms.reduce(
						(total, term) =>
							total +
							(text.includes(term.normalize('NFKC').toLocaleLowerCase('en-US'))
								? 1
								: 0),
						0,
					)
					return { lens, index, score }
				})
				.sort(
					(left, right) =>
						right.score - left.score ||
						left.index - right.index ||
						left.lens.id.localeCompare(right.lens.id),
				)
			const selected = ranked.slice(0, limit)
			return {
				lensIds: selected.map(({ lens }) => lens.id),
				metadataExaminedLensIds: lenses.map(({ id }) => id),
				omittedLensIds: ranked.slice(limit).map(({ lens }) => lens.id),
				provenance: {
					strategy: 'literal_metadata_terms',
					registrySize: lenses.length,
					scores: selected.map(({ lens, score }) => ({
						lensId: lens.id,
						score,
					})),
				},
			}
		},
	}
}
