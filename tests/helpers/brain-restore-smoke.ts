import type { LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { Brain, type BrainAskResult } from '../../src'
import type { BrainStore } from '../../src/stores'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import type { JSONValue } from '@ai-sdk/provider/internal'
import { join } from 'node:path'

interface StoreFactories {
	createBrainStore: (dbPath: string) => BrainStore
}

export interface BrainRestoreSmokeResult {
	firstAsk: BrainAskResult
	secondAsk: BrainAskResult
	firstUnderstanding: string
	secondUnderstanding: string
	injectStatus: string
	callsBeforeRestoreInitialize: number
	callsAfterRestoreInitialize: number
	callsAfterRestoreAsk: number
	restoredNeuronCount: number
}

interface ScriptedModelHandle {
	model: LanguageModel
	getCallCount: () => number
}

function createUsage() {
	return {
		inputTokens: {
			total: 32,
			noCache: 32,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: 24,
			text: 24,
			reasoning: undefined,
		},
	}
}

function createJsonResult(value: JSONValue) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(value) }],
		finishReason: { unified: 'stop' as const, raw: undefined },
		usage: createUsage(),
		warnings: [],
	}
}

function createTextResult(text: string) {
	return {
		content: [{ type: 'text' as const, text }],
		finishReason: { unified: 'stop' as const, raw: undefined },
		usage: createUsage(),
		warnings: [],
	}
}

function getPromptText(options: LanguageModelV3CallOptions): string {
	return options.prompt
		.map((message) => {
			if (message.role === 'system') return message.content
			return message.content
				.map((part) => {
					if (part.type === 'text') return part.text
					if (part.type === 'tool-call') return JSON.stringify(part.input)
					if (part.type === 'tool-result') return JSON.stringify(part.output)
					return ''
				})
				.join('\n')
		})
		.join('\n\n')
}

function getSystemText(options: LanguageModelV3CallOptions): string {
	return options.prompt
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n\n')
}

function extractSection(text: string, heading: string, endMarker?: string): string {
	const start = text.indexOf(heading)
	if (start === -1) return ''
	const contentStart = start + heading.length
	const rest = text.slice(contentStart)
	if (!endMarker) return rest.trim()
	const end = rest.indexOf(endMarker)
	return (end === -1 ? rest : rest.slice(0, end)).trim()
}

function buildUnderstanding(systemPromptPrompt: string): string {
	const currentUnderstanding = extractSection(
		systemPromptPrompt,
		'Existing understanding:\n',
		'\n\nExtracted information:',
	)
	const extracted = extractSection(systemPromptPrompt, 'Extracted information:\n')
	const pieces = new Set<string>()
	if (currentUnderstanding && currentUnderstanding !== '(none yet)') {
		pieces.add(currentUnderstanding)
	}
	if (extracted) pieces.add(extracted)
	return Array.from(pieces).join('\n')
}

function extractSpecialistIds(promptText: string): string[] {
	return Array.from(promptText.matchAll(/^- ([^:]+):/gm), (match) => match[1])
}

function extractUnderstandingFromSystem(systemText: string): string {
	return extractSection(systemText, '# Committed Understanding\n', '\n\n# Learning Status')
}

function extractSpecialistInsights(systemText: string): string[] {
	return Array.from(
		systemText.matchAll(/## [^\n]+\n([\s\S]*?)(?=\n## [^\n]+\n|$)/g),
		(match) => match[1].trim(),
	).filter(Boolean)
}

function createScriptedBrainModel(): ScriptedModelHandle {
	let callCount = 0

	const model = new MockLanguageModelV3({
		doGenerate: async (options) => {
			callCount++

			const promptText = getPromptText(options)
			const systemText = getSystemText(options)

			if (promptText.includes('You are analyzing a user-authored prompt for a living knowledge network')) {
				return createJsonResult({
					purpose: 'Track engineering decisions and remember their rationale.',
					evolutionGuidance: null,
					synthesisDirective: 'Answer concretely from stored engineering evidence.',
				})
			}

			if (systemText.startsWith('Here is some data.')) {
				return createTextResult(extractSection(promptText, 'Data:\n'))
			}

			if (systemText.startsWith('Here is information extracted about this topic')) {
				return createTextResult(buildUnderstanding(promptText))
			}

			if (systemText.includes('You select which specialist neurons are relevant to a user query.')) {
				return createJsonResult({
					ids: extractSpecialistIds(promptText),
				})
			}

			if (systemText.includes('# Committed Understanding')) {
				const understanding = extractUnderstandingFromSystem(systemText)
				return createJsonResult({
					relevant: true,
					relevance: 1,
					confidence: 0.96,
					response: understanding,
					gaps: [],
				})
			}

			if (systemText.includes('# Specialist Knowledge')) {
				const insights = extractSpecialistInsights(systemText)
				return createJsonResult({
					response: insights.join('\n\n'),
					gaps: [],
				})
			}

			return createTextResult('No additional processing required.')
		},
	})

	return {
		model: model as unknown as LanguageModel,
		getCallCount: () => callCount,
	}
}

function createBrainConfig(
	dir: string,
	model: LanguageModel,
	factories: StoreFactories,
) {
	return {
		prompt: 'Track engineering decisions and their rationale.',
		model,
		autoSetup: false,
		store: factories.createBrainStore(join(dir, 'brain.db')),
		evolution: {
			enabled: false,
			autoEvaluate: false,
		},
		internalNeurons: {
			globalUnderstanding: false,
			globalQueryUnderstanding: false,
			injectionGaps: false,
			queryGaps: false,
		},
		learning: {
			understand: {
				thresholds: {
					maxObservations: 1,
					maxTokens: 8000,
					minImportance: 0.1,
				},
			},
		},
		neurons: [
			{
				id: 'engineering-decisions',
				name: 'Engineering Decisions',
				description: 'Tracks project decisions and technical tradeoffs.',
				type: 'text' as const,
				instructions:
					'Track engineering decisions, runtime tradeoffs, and the rationale behind technical changes.',
				skipObservation: true,
				observationSchema: { type: 'string' },
				understandingSchema: { type: 'string' },
			},
		],
	}
}

export async function runBrainRestoreSmoke(
	dir: string,
	factories: StoreFactories,
): Promise<BrainRestoreSmokeResult> {
	const firstModel = createScriptedBrainModel()
	const firstBrain = await Brain.create(
		createBrainConfig(dir, firstModel.model, factories),
	)

	const injectResult = await firstBrain.inject([
		'We chose runtime-specific SQLite adapters so Adapt core stays runtime-agnostic.',
	])
	const firstAsk = await firstBrain.ask('What engineering decision was made?')
	const firstUnderstanding =
		(await firstBrain.getNeuron('engineering-decisions')?.getUnderstanding()) as string
	await firstBrain.dispose()

	const restoredModel = createScriptedBrainModel()
	const callsBeforeRestoreInitialize = restoredModel.getCallCount()
	const restoredBrain = await Brain.restore(
		factories.createBrainStore(join(dir, 'brain.db')),
	)
	// Replace gateway-string models with the scripted one across the slots
	// actually used by the second ask: brain-level query model + per-neuron
	// query model. We avoid changing *blueprint slots (which would trigger
	// observe/understand prompt regen and a needless LLM call).
	await restoredBrain.update({
		model: restoredModel.model,
		query: { model: restoredModel.model },
		learning: {
			query: { model: restoredModel.model },
		},
	})
	const callsAfterRestoreInitialize = restoredModel.getCallCount()
	const restoredNeuronCount = restoredBrain.getNeurons().length
	const secondAsk = await restoredBrain.ask('What engineering decision was made?')
	const callsAfterRestoreAsk = restoredModel.getCallCount()
	const secondUnderstanding =
		(await restoredBrain.getNeuron('engineering-decisions')?.getUnderstanding()) as string
	await restoredBrain.dispose()

	return {
		firstAsk,
		secondAsk,
		firstUnderstanding,
		secondUnderstanding,
		injectStatus: injectResult.batches[0]?.results[0]?.result.status ?? 'unknown',
		callsBeforeRestoreInitialize,
		callsAfterRestoreInitialize,
		callsAfterRestoreAsk,
		restoredNeuronCount,
	}
}
