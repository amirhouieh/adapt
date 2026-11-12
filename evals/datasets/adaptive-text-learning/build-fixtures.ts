import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

type Urgency = 'normal' | 'urgent'

interface Lens {
	readonly purpose: string
	readonly developerInstructions: readonly string[]
	readonly instructionPrecedence: readonly string[]
	readonly incomingTextRole: 'data-only'
}

interface TextInput {
	readonly deliveryId: string
	readonly eventId?: string
	readonly text: string
	readonly observedAt: string
	readonly urgency?: Urgency
}

interface EventSpec {
	readonly key: string
	readonly text?: string
	readonly eventId?: string
	readonly urgency?: Urgency
	readonly retryOf?: string
}

interface ExpectationSpec {
	readonly id: string
	readonly dimension:
		| 'current-state'
		| 'scope'
		| 'uncertainty'
		| 'retention'
		| 'identity'
		| 'pattern'
		| 'novelty'
		| 'generalization'
	readonly critical: boolean
	readonly expected: readonly string[]
	readonly unacceptable: readonly string[]
}

interface PhaseSpec {
	readonly checkpoint: number
	readonly events: readonly EventSpec[]
	readonly expectations: readonly ExpectationSpec[]
}

interface BackgroundSpec {
	readonly catalogueId: string
}

interface BackgroundThread {
	readonly id: string
	readonly kind: 'learning' | 'noise'
	readonly eventIdentity: 'same' | 'distinct'
	readonly subject: string
	readonly states: readonly string[]
	readonly evidence: readonly string[]
}

interface BackgroundCatalogue {
	readonly schemaVersion: 1
	readonly streams: Readonly<Record<string, readonly BackgroundThread[]>>
}

interface StreamSpec {
	readonly id: string
	readonly title: string
	readonly visibility: 'development' | 'sealed-heldout'
	readonly startAt: string
	readonly stepMinutes: number
	readonly inputsPerPhase: number
	readonly lens: Lens
	readonly phases: readonly PhaseSpec[]
	readonly background: BackgroundSpec
}

type ProcedureId =
	| 'direct'
	| 'compare-rewrite'
	| 'pattern-rewrite'
	| 'compare-pattern-rewrite'

type ModuleKind = 'writer' | 'compare' | 'pattern' | 'combined' | 'selector'

interface SelectionSpec {
	readonly currentProcedure: ProcedureId
	readonly allowed: readonly {
		readonly id: ProcedureId
		readonly expectedEffect: string
	}[]
	readonly learnedChanges: readonly string[]
	readonly pending: readonly TextInput[]
	readonly feedback: readonly string[]
	readonly metrics: Readonly<Record<string, number>>
}

interface ModuleCaseSpec {
	readonly id: string
	readonly kind: ModuleKind
	readonly procedure?: ProcedureId
	readonly lens?: Lens
	readonly memory: { readonly text: string; readonly revision: number }
	readonly inputs: readonly TextInput[]
	readonly selection?: SelectionSpec
	readonly reviewer: {
		readonly objective: string
		readonly critical: boolean
		readonly expected: readonly string[]
		readonly unacceptable: readonly string[]
	}
}

interface AuthoringSource {
	readonly schemaVersion: 1
	readonly synthetic: true
	readonly streams: readonly StreamSpec[]
	readonly backgroundCatalogue: BackgroundCatalogue
	readonly moduleLens: Lens
	readonly moduleCases: readonly ModuleCaseSpec[]
}

interface BuiltStream {
	readonly schemaVersion: 1
	readonly synthetic: true
	readonly visibility: StreamSpec['visibility']
	readonly id: string
	readonly title: string
	readonly lens: Lens
	readonly checkpoints: readonly number[]
	readonly inputs: readonly TextInput[]
}

function parseSource(path: string): AuthoringSource {
	return JSON.parse(readFileSync(path, 'utf8')) as AuthoringSource
}

function isoAt(startAt: string, stepMinutes: number, index: number): string {
	return new Date(
		new Date(startAt).getTime() + stepMinutes * index * 60_000,
	).toISOString()
}

function render(
	template: string,
	values: Readonly<Record<string, string>>,
): string {
	let result = template
	for (const [key, value] of Object.entries(values)) {
		result = result.split(`{${key}}`).join(value)
	}
	return result
}

function buildBackground(
	stream: StreamSpec,
	threads: readonly BackgroundThread[],
	ordinal: number,
	observedAt: string,
): TextInput {
	const thread = threads[ordinal % threads.length]
	if (thread === undefined) {
		throw new Error(`Missing background thread for ${stream.id}`)
	}
	const cycle = Math.floor(ordinal / threads.length)
	const phase = Math.floor(cycle / 2)
	const detail =
		cycle % 2 === 0 ? thread.states[phase] : thread.evidence[phase]
	if (detail === undefined) {
		throw new Error(`Missing background phase ${phase} for ${stream.id}:${thread.id}`)
	}
	const text = render(`${thread.subject}: ${detail}`, {
		date: observedAt.slice(0, 10),
		ordinal: String(ordinal + 1),
	})
	const eventSuffix =
		thread.eventIdentity === 'same' ? 'state' : String(cycle + 1).padStart(2, '0')
	return {
		deliveryId: `${stream.id}:thread:${thread.id}:${String(ordinal + 1).padStart(3, '0')}`,
		eventId: `${stream.id}:thread-event:${thread.id}:${eventSuffix}`,
		text,
		observedAt,
		urgency: 'normal',
	}
}

function buildStream(
	stream: StreamSpec,
	backgroundCatalogue: BackgroundCatalogue,
): BuiltStream {
	const expectedInputCount = stream.inputsPerPhase * stream.phases.length
	const inputs: TextInput[] = []
	const byKey = new Map<string, TextInput>()
	let backgroundOrdinal = 0
	const threads = backgroundCatalogue.streams[stream.background.catalogueId]
	if (threads === undefined || threads.length === 0) {
		throw new Error(`Missing background catalogue ${stream.background.catalogueId}`)
	}

	for (const [phaseIndex, phase] of stream.phases.entries()) {
		if (phase.events.length > stream.inputsPerPhase) {
			throw new Error(`Too many authored events in ${stream.id} phase ${phaseIndex}`)
		}
		for (let phaseOffset = 0; phaseOffset < stream.inputsPerPhase; phaseOffset += 1) {
			const index = phaseIndex * stream.inputsPerPhase + phaseOffset
			const observedAt = isoAt(stream.startAt, stream.stepMinutes, index)
			const supplied = phase.events[phaseOffset]
			if (supplied === undefined) {
				inputs.push(
					buildBackground(stream, threads, backgroundOrdinal, observedAt),
				)
				backgroundOrdinal += 1
				continue
			}
			if (supplied.retryOf !== undefined) {
				const original = byKey.get(supplied.retryOf)
				if (original === undefined) {
					throw new Error(
						`Retry ${supplied.key} precedes ${supplied.retryOf} in ${stream.id}`,
					)
				}
				inputs.push(original)
				byKey.set(supplied.key, original)
				continue
			}
			if (supplied.text === undefined) {
				throw new Error(`Missing text for ${stream.id}:${supplied.key}`)
			}
			const input: TextInput = {
				deliveryId: `${stream.id}:${supplied.key}`,
				eventId: supplied.eventId,
				text: render(supplied.text, {
					date: observedAt.slice(0, 10),
					time: observedAt.slice(11, 16),
				}),
				observedAt,
				urgency: supplied.urgency ?? 'normal',
			}
			inputs.push(input)
			byKey.set(supplied.key, input)
		}
	}

	if (inputs.length !== expectedInputCount) {
		throw new Error(`Expected ${expectedInputCount} inputs for ${stream.id}`)
	}

	return {
		schemaVersion: 1,
		synthetic: true,
		visibility: stream.visibility,
		id: stream.id,
		title: stream.title,
		lens: stream.lens,
		checkpoints: stream.phases.map(({ checkpoint }) => checkpoint),
		inputs,
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function digest(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main(): void {
	const [
		sourceArgument,
		outputArgument,
		manifestArgument,
		manifestBaseArgument,
	] = process.argv.slice(2)
	if (
		sourceArgument === undefined ||
		outputArgument === undefined ||
		manifestArgument === undefined ||
		manifestBaseArgument === undefined
	) {
		throw new Error(
			'Usage: tsx build-fixtures.ts <authoring-source> <output-directory> <manifest-path> <manifest-base-directory>',
		)
	}

	const sourcePath = resolve(sourceArgument)
	const outputDirectory = resolve(outputArgument)
	const manifestPath = resolve(manifestArgument)
	const manifestBase = resolve(manifestBaseArgument)
	const source = parseSource(sourcePath)
	const written: {
		path: string
		role: string
		visibility: string
		inputCount?: number
		caseCount?: number
	}[] = []

	for (const stream of source.streams) {
		const built = buildStream(stream, source.backgroundCatalogue)
		const streamPath = resolve(outputDirectory, `stream-${stream.id}.json`)
		writeJson(streamPath, built)
		written.push({
			path: streamPath,
			role: 'input-stream',
			visibility: stream.visibility,
			inputCount: built.inputs.length,
		})

		const reviewerPath = resolve(
			outputDirectory,
			`reviewer-key-${stream.id}.json`,
		)
		writeJson(reviewerPath, {
			schemaVersion: 1,
			synthetic: true,
			streamId: stream.id,
			modelInput: false,
			checkpoints: stream.phases.map((phase) => ({
				afterInput: phase.checkpoint,
				expectations: phase.expectations,
			})),
		})
		written.push({
			path: reviewerPath,
			role: 'reviewer-key',
			visibility: stream.visibility,
		})
	}

	const modulePath = resolve(outputDirectory, 'module-cases.json')
	writeJson(modulePath, {
		schemaVersion: 1,
		synthetic: true,
		cases: source.moduleCases.map(({ reviewer: _reviewer, ...fixture }) => ({
			...fixture,
			lens: fixture.lens ?? source.moduleLens,
		})),
	})
	written.push({
		path: modulePath,
		role: 'module-inputs',
		visibility: 'development',
		caseCount: source.moduleCases.length,
	})

	const moduleReviewerPath = resolve(outputDirectory, 'reviewer-key-module-cases.json')
	writeJson(moduleReviewerPath, {
		schemaVersion: 1,
		synthetic: true,
		modelInput: false,
		cases: source.moduleCases.map(({ id, reviewer }) => ({ id, ...reviewer })),
	})
	written.push({
		path: moduleReviewerPath,
		role: 'reviewer-key',
		visibility: 'development',
		caseCount: source.moduleCases.length,
	})

	writeJson(manifestPath, {
		schemaVersion: 1,
		synthetic: true,
		authoringSource: {
			path: relative(manifestBase, sourcePath),
			sha256: digest(sourcePath),
		},
		files: written.map((entry) => ({
			...entry,
			path: relative(manifestBase, entry.path),
			sha256: digest(entry.path),
		})),
		notes: [
			'Reviewer-key files are never model input.',
			'Sealed held-out files remain unopened by prompt and implementation authors until root freezes prompts, source, catalogue, and frozen-rich assignments.',
			'Fixture validity is mechanical evidence only and does not accept model semantics.',
		],
	})

	process.stdout.write(
		`${JSON.stringify({ manifest: manifestPath, files: written.length })}\n`,
	)
}

main()
