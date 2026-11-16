import { useState, useCallback, useRef } from "react"
import type { LanguageModel } from "ai"
import type {
	Neuron,
	NeuronMetrics,
	NeuronHealth,
	BrainEvent,
	InjectionProgress,
	DataSource,
	DataItem,
} from "./types"
import { commentaryFromEvent, isInternalNeuron } from "./commentary"

const defaultMetrics: NeuronMetrics = {
	observations: 0,
	dismissals: 0,
	syntheses: 0,
	queries: 0,
	lastSynthesisSignificance: null,
	lastSynthesisEvolution: null,
}

const defaultHealth: NeuronHealth = {
	activation: 0.5,
	status: "active",
}

export type DemoPhase = "idle" | "initializing" | "ready" | "error"

export interface DemoState {
	phase: DemoPhase
	activity: string
	neurons: Neuron[]
	commentary: string
	evolutionCommentary: string
	evolutionActivity: string
	events: BrainEvent[]
	injectionProgress: InjectionProgress | null
}

const initialState: DemoState = {
	phase: "idle",
	activity: "",
	neurons: [],
	commentary: "",
	evolutionCommentary: "",
	evolutionActivity: "",
	events: [],
	injectionProgress: null,
}

const COMMENTARY_MIN_INTERVAL = 2500
const COMMENTARY_QUEUE_CAP = 5

interface UseBrainOptions {
	model: LanguageModel
	prompt: string
	autoSetup?: boolean
	learning?: {
		understand?: {
			thresholds?: {
				maxObservations?: number
				maxTokens?: number
				minImportance?: number
			}
		}
		governance?: {
			strategy?: "continuous" | "cumulative" | "decay"
			maxTokens?: number
		}
	}
	evolution?: {
		enabled?: boolean
		autoEvaluate?: boolean
		evaluatorSignalThreshold?: number
	}
	ingest?: {
		batchSize?: number
	}
}

export function useBrain() {
	const [state, setState] = useState<DemoState>(initialState)
	const brainRef = useRef<import("@unbody-io/adapt").Brain | null>(null)
	const eventIdCounter = useRef(0)
	const timelineRef = useRef<{ t: number; event: string; payload: Record<string, unknown> }[]>([])
	const fullLogRef = useRef<string[]>([])
	const startTimeRef = useRef(0)
	const narratedInternalSetupRef = useRef(false)
	const evoActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Commentary queues (one per category)
	const commentaryQueueRef = useRef<{ text: string; priority?: boolean }[]>([])
	const commentaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const commentaryLastDisplayRef = useRef(0)

	const evoQueueRef = useRef<{ text: string; priority?: boolean }[]>([])
	const evoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const evoLastDisplayRef = useRef(0)

	const displayCommentary = useCallback((text: string) => {
		commentaryLastDisplayRef.current = Date.now()
		setState((prev) => ({ ...prev, commentary: text }))
	}, [])

	const displayEvoCommentary = useCallback((text: string) => {
		evoLastDisplayRef.current = Date.now()
		setState((prev) => ({ ...prev, evolutionCommentary: text }))
	}, [])

	const drainCommentaryQueue = useCallback(() => {
		commentaryTimerRef.current = null
		const queue = commentaryQueueRef.current
		if (queue.length === 0) return
		const item = queue.shift()!
		displayCommentary(item.text)
		if (queue.length > 0) {
			commentaryTimerRef.current = setTimeout(drainCommentaryQueue, COMMENTARY_MIN_INTERVAL)
		}
	}, [displayCommentary])

	const drainEvoQueue = useCallback(() => {
		evoTimerRef.current = null
		const queue = evoQueueRef.current
		if (queue.length === 0) return
		const item = queue.shift()!
		displayEvoCommentary(item.text)
		if (queue.length > 0) {
			evoTimerRef.current = setTimeout(drainEvoQueue, COMMENTARY_MIN_INTERVAL)
		}
	}, [displayEvoCommentary])

	const enqueueCommentary = useCallback((text: string, priority?: boolean, category: "progress" | "evolution" = "progress") => {
		if (category === "evolution") {
			const queue = evoQueueRef.current
			queue.push({ text, priority })
			if (queue.length > COMMENTARY_QUEUE_CAP) {
				const kept: typeof queue = []
				for (const item of queue) {
					if (item.priority || kept.length < 3) kept.push(item)
				}
				evoQueueRef.current = kept.slice(-COMMENTARY_QUEUE_CAP)
			}
			const elapsed = Date.now() - evoLastDisplayRef.current
			if (!evoTimerRef.current && elapsed >= COMMENTARY_MIN_INTERVAL) {
				drainEvoQueue()
			} else if (!evoTimerRef.current) {
				evoTimerRef.current = setTimeout(drainEvoQueue, COMMENTARY_MIN_INTERVAL - elapsed)
			}
			return
		}

		const queue = commentaryQueueRef.current
		queue.push({ text, priority })

		// Overflow protection: drop oldest non-priority items
		if (queue.length > COMMENTARY_QUEUE_CAP) {
			const kept: typeof queue = []
			for (const item of queue) {
				if (item.priority || kept.length < 3) kept.push(item)
			}
			// Keep last 3 + all priority items
			commentaryQueueRef.current = kept.slice(-COMMENTARY_QUEUE_CAP)
		}

		const elapsed = Date.now() - commentaryLastDisplayRef.current
		if (!commentaryTimerRef.current && elapsed >= COMMENTARY_MIN_INTERVAL) {
			drainCommentaryQueue()
		} else if (!commentaryTimerRef.current) {
			commentaryTimerRef.current = setTimeout(drainCommentaryQueue, COMMENTARY_MIN_INTERVAL - elapsed)
		}
	}, [drainCommentaryQueue, drainEvoQueue])

	const setCommentaryImmediate = useCallback((text: string) => {
		if (commentaryTimerRef.current) {
			clearTimeout(commentaryTimerRef.current)
			commentaryTimerRef.current = null
		}
		commentaryQueueRef.current = []
		displayCommentary(text)
	}, [displayCommentary])

	const addEvent = useCallback((type: string, payload: Record<string, unknown>) => {
		setState((prev) => ({
			...prev,
			events: [
				...prev.events,
				{
					id: String(++eventIdCounter.current),
					type,
					payload,
					timestamp: new Date().toISOString(),
				},
			],
		}))
	}, [])

	const patchNeuron = useCallback((neuronId: string, patch: Partial<Neuron>) => {
		setState((prev) => ({
			...prev,
			neurons: prev.neurons.map((n) =>
				n.id === neuronId ? { ...n, ...patch } : n,
			),
		}))
	}, [])

	const incrementMetric = useCallback((neuronId: string, key: keyof NeuronMetrics) => {
		setState((prev) => ({
			...prev,
			neurons: prev.neurons.map((n) => {
				if (n.id !== neuronId) return n
				return {
					...n,
					metrics: {
						...n.metrics,
						[key]: (n.metrics[key] as number) + 1,
					},
				}
			}),
		}))
	}, [])

	const start = useCallback(async (options: UseBrainOptions) => {
		const { Brain, MemoryBrainStore } = await import("@unbody-io/adapt")

		startTimeRef.current = Date.now()
		timelineRef.current = []
		narratedInternalSetupRef.current = false
		setState({ ...initialState, phase: "initializing", activity: "Creating brain..." })

		const flags = { get narratedInternalSetup() { return narratedInternalSetupRef.current }, set narratedInternalSetup(v: boolean) { narratedInternalSetupRef.current = v } }

		// Events of interest (drive React state, activity labels, commentary).
		const eventTypes = new Set([
			"brain:init:started",
			"brain:init:completed",
			"brain:init:config:generated",
			"brain:neuron:added",
			"brain:neuron:removed",
			"neuron:init:started",
			"neuron:observe:started",
			"neuron:observe:thinking",
			"neuron:observed",
			"neuron:observe:dismissed",
			"neuron:synthesize:started",
			"neuron:synthesized",
			"neuron:health:updated",
			"neuron:query:started",
			"neuron:query:completed",
			"brain:inject:started",
			"brain:inject:completed",
			"brain:inject:batch:started",
			"brain:inject:batch:completed",
			"brain:signal:received",
			"evolution:started",
			"evolution:change",
			"evolution:completed",
			"evolution:failed",
		])

		// Single handler attached BEFORE init via Brain.create's `onEvent` hook, so
		// init events (brain:init:*, neuron:init:*) are observed. `brainRef.current`
		// is still null while init runs — the helpers below tolerate a null brain and
		// degrade gracefully (payload-only labels); the final syncNeurons after
		// create() fills in the neuron list.
		const handleBrainEvent = (event: { type: string; payload: object }) => {
			const eventType = event.type
			const payload = event.payload as Record<string, unknown>

			// Log ALL brain events to timeline
			timelineRef.current.push({ t: Date.now() - startTimeRef.current, event: eventType, payload })

			if (!eventTypes.has(eventType)) return
			const brain = brainRef.current

			addEvent(eventType, payload)

			// Activity label
			const activity = activityFromEvent(eventType, payload, brain)
			if (activity) {
				if (activity.category === "evolution") {
					if (evoActivityTimerRef.current) {
						clearTimeout(evoActivityTimerRef.current)
						evoActivityTimerRef.current = null
					}
					setState((prev) => ({ ...prev, evolutionActivity: activity.text }))
					// Signal received is transient — auto-clear unless evaluation starts
					if (eventType === "brain:signal:received") {
						evoActivityTimerRef.current = setTimeout(() => {
							evoActivityTimerRef.current = null
							setState((prev) => ({ ...prev, evolutionActivity: "" }))
						}, 3000)
					}
				} else {
					setState((prev) => ({ ...prev, activity: activity.text }))
				}
			}

			// Commentary
			const comment = commentaryFromEvent(eventType, payload, brain, flags)
			if (comment) {
				enqueueCommentary(comment.text, comment.priority, comment.category)
			}

			// Full log
			const t = ((Date.now() - startTimeRef.current) / 1000).toFixed(1)
			const lines = [
				`[${t}s] ${eventType}`,
				`  payload: ${JSON.stringify(payload, null, 2).replace(/\n/g, "\n  ")}`,
			]
			if (activity) lines.push(`  → activity [${activity.category}]: "${activity.text}"`)
			if (comment) lines.push(`  → commentary [${comment.category}]: "${comment.text}"`)
			fullLogRef.current.push(lines.join("\n"))

			// Per-neuron tracking
			const neuronId = payload.neuronId as string | undefined
			if (neuronId) {
				const internal = isInternalNeuron(neuronId)

				switch (eventType) {
					case "neuron:observe:started":
						if (!internal) {
							patchNeuron(neuronId, { activity: "observing" })
						}
						break
					case "neuron:observe:thinking":
						if (!internal) {
							patchNeuron(neuronId, { activity: "thinking" })
						}
						break
					case "neuron:observed":
						incrementMetric(neuronId, "observations")
						if (!internal) {
							patchNeuron(neuronId, { activity: "idle" })
						}
						break
					case "neuron:observe:dismissed":
						incrementMetric(neuronId, "dismissals")
						break
					case "neuron:synthesize:started":
						if (!internal) {
							patchNeuron(neuronId, { activity: "synthesizing" })
						}
						break
					case "neuron:synthesized":
						incrementMetric(neuronId, "syntheses")
						if (!internal) {
							patchNeuron(neuronId, { activity: "idle" })
						}
						break
					case "neuron:query:started":
						incrementMetric(neuronId, "queries")
						if (!internal) {
							patchNeuron(neuronId, { activity: "querying" })
						}
						break
					case "neuron:query:completed":
						if (!internal) {
							patchNeuron(neuronId, { activity: "idle" })
						}
						break
					case "neuron:health:updated":
						if (!internal) {
							patchNeuron(neuronId, {
								health: {
									activation: (payload.activation as number) ?? 0.5,
									status: (payload.status as string) ?? "active",
								},
							})
						}
						break
				}
			}

			// Reset activity on top-level completion events
			if (
				eventType === "brain:init:completed" ||
				eventType === "brain:inject:completed"
			) {
				setState((prev) => ({ ...prev, activity: "Ready" }))
			}

			// Evolution action tracking
			if (eventType === "evolution:completed" || eventType === "evolution:failed") {
				setState((prev) => ({ ...prev, activity: "Ready", evolutionActivity: "" }))
			}

			// Structural changes → sync neuron list.
			if (brain) {
				// Post-init: reconcile the full list from the live brain.
				if (
					eventType === "brain:init:completed" ||
					eventType === "brain:neuron:added" ||
					eventType === "brain:neuron:removed" ||
					eventType === "evolution:change"
				) {
					syncNeurons(brain)
				}
			} else if (eventType === "brain:neuron:added") {
				// During init the brain instance isn't returned yet, so syncNeurons
				// can't run. Add the neuron incrementally from the event payload so
				// they appear one-by-one during birth; the post-create syncNeurons
				// then reconciles type/description.
				addNeuronFromEvent(payload)
			}

			// Injection batch progress
			if (eventType === "brain:inject:started") {
				setState((prev) => ({
					...prev,
					injectionProgress: prev.injectionProgress
						? {
							...prev.injectionProgress,
							batchCount: payload.batchCount as number,
						}
						: prev.injectionProgress,
				}))
			}
			if (eventType === "brain:inject:batch:completed") {
				setState((prev) => ({
					...prev,
					injectionProgress: prev.injectionProgress
						? {
							...prev.injectionProgress,
							batchIndex: (payload.batchIndex as number) + 1,
						}
						: prev.injectionProgress,
				}))
			}
		}

		const brain = await retryAsync(() =>
			Brain.create({
				prompt: options.prompt,
				autoSetup: options.autoSetup ?? true,
				model: options.model,
				store: new MemoryBrainStore(),
				ingest: options.ingest,
				learning: {
					understand: options.learning?.understand,
					governance: options.learning?.governance,
				},
				evolution: options.evolution ? {
					enabled: options.evolution.enabled,
					autoEvaluate: options.evolution.autoEvaluate,
					evaluatorSignalThreshold: options.evolution.evaluatorSignalThreshold,
				} : undefined,
				onEvent: handleBrainEvent,
			}), 3)

		brainRef.current = brain

		syncNeurons(brain)
		setState((prev) => ({ ...prev, phase: "ready", activity: "Brain ready" }))
	}, [addEvent, patchNeuron, incrementMetric, enqueueCommentary])

	// Incrementally append a neuron from a brain:neuron:added payload. Used during
	// init (before the brain instance is available); syncNeurons reconciles later.
	const addNeuronFromEvent = (payload: Record<string, unknown>) => {
		const id = payload.neuronId as string | undefined
		const name = payload.name as string | undefined
		if (!id || !name || name.startsWith("__internal")) return
		setState((prev) => {
			if (prev.neurons.some((n) => n.id === id)) return prev
			return {
				...prev,
				neurons: [
					...prev.neurons,
					{
						id,
						name,
						description: (payload.instructions as string) ?? "",
						understandingSize: 0,
						activity: "idle",
						metrics: { ...defaultMetrics },
						health: { ...defaultHealth },
					},
				],
			}
		})
	}

	const syncNeurons = (brain: import("@unbody-io/adapt").Brain) => {
		const newNeurons: Neuron[] = []
		for (const neuron of brain.getNeurons()) {
			if (neuron.name.startsWith("__internal")) continue
			newNeurons.push({
				id: neuron.id,
				name: neuron.name,
				description: neuron.description,
				understandingSize: 0,
				activity: "idle",
				metrics: { ...defaultMetrics },
				health: { ...defaultHealth },
			})
		}
		setState((prev) => {
			// Preserve existing metrics for neurons that already exist
			const merged = newNeurons.map((newN) => {
				const existing = prev.neurons.find((n) => n.id === newN.id)
				if (existing) {
					return { ...newN, activity: existing.activity, metrics: existing.metrics, health: existing.health }
				}
				return newN
			})
			return { ...prev, neurons: merged }
		})
	}

	const inject = useCallback(async (dataSources: DataSource[]) => {
		const brain = brainRef.current
		if (!brain) return

		const labels = dataSources.map((s) => s.label).join(", ")
		setCommentaryImmediate(
			`The mind is ready. ${dataSources.length} source${dataSources.length > 1 ? "s" : ""} about to flow in: ${labels}.`,
		)

		for (let i = 0; i < dataSources.length; i++) {
			const source = dataSources[i]
			setState((prev) => ({
				...prev,
				injectionProgress: {
					sourceIndex: i,
					sourceCount: dataSources.length,
					sourceLabel: source.label,
					sourceSummary: source.summary || source.description,
					itemCount: source.items.length,
					batchIndex: 0,
					batchCount: 0,
				},
			}))

			if (i > 0) {
				setCommentaryImmediate(
					`Moving on to source ${i + 1} of ${dataSources.length}: "${source.label}".`,
				)
			}

			const items = source.items.map(itemToText)
			await retryAsync(() => brain.inject(items), 3)

			// Pause between sources so UI can breathe
			if (i < dataSources.length - 1) {
				await new Promise((r) => setTimeout(r, 1500))
			}
		}

		setCommentaryImmediate("All sources absorbed. Ready to answer questions.")

		setState((prev) => ({
			...prev,
			activity: "Ready",
			injectionProgress: null,
			evolutionActivity: "",
			evolutionCommentary: "",
		}))
	}, [setCommentaryImmediate])

	const destroy = useCallback(() => {
		if (commentaryTimerRef.current) {
			clearTimeout(commentaryTimerRef.current)
			commentaryTimerRef.current = null
		}
		if (evoTimerRef.current) {
			clearTimeout(evoTimerRef.current)
			evoTimerRef.current = null
		}
		if (evoActivityTimerRef.current) {
			clearTimeout(evoActivityTimerRef.current)
			evoActivityTimerRef.current = null
		}
		commentaryQueueRef.current = []
		evoQueueRef.current = []
		brainRef.current = null
		setState(initialState)
	}, [])

	const downloadLog = useCallback(() => {
		const content = fullLogRef.current.join("\n\n")
		const blob = new Blob([content], { type: "text/plain" })
		const url = URL.createObjectURL(blob)
		const a = document.createElement("a")
		a.href = url
		a.download = `brain-demo-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
		a.click()
		URL.revokeObjectURL(url)
	}, [])

	return {
		state,
		brain: brainRef,
		start,
		inject,
		destroy,
		downloadLog,
	}
}

interface ActivityResult {
	text: string
	category: "progress" | "evolution"
}

function activityFromEvent(
	type: string,
	payload: Record<string, unknown>,
	brain: import("@unbody-io/adapt").Brain | null,
): ActivityResult | null {
	switch (type) {
		case "brain:init:started": return { text: "Analyzing prompt...", category: "progress" }
		case "brain:init:config:generated": {
			const count = (payload.configs as unknown[])?.length ?? 0
			return { text: `Designing ${count} neurons...`, category: "progress" }
		}
		case "brain:neuron:added": return { text: `Created "${payload.name}"`, category: "progress" }
		case "neuron:init:started": {
			const neuronId = payload.neuronId as string
			if (isInternalNeuron(neuronId)) return null
			const neuron = brain?.getNeuron(neuronId)
			return { text: `Setting up "${neuron?.name ?? neuronId}"...`, category: "progress" }
		}
		case "brain:init:completed": return { text: "Brain ready", category: "progress" }
		case "brain:inject:started": return { text: `Injecting ${payload.itemCount} items...`, category: "progress" }
		case "brain:inject:batch:started": return { text: "Processing batch...", category: "progress" }
		case "brain:inject:completed": return { text: "Injection complete", category: "progress" }
		case "neuron:observe:started": return null
		case "neuron:observe:thinking": return null
		case "neuron:observed": return null
		case "neuron:observe:dismissed": return null
		case "neuron:synthesize:started": return null
		case "neuron:synthesized": return null
		case "neuron:query:started": return null
		case "neuron:query:completed": return null
		case "brain:signal:received": {
			const source = payload.source as string
			if (!source.startsWith("user:")) return null
			return { text: "Signal received", category: "evolution" }
		}
		case "evolution:started": return { text: "Reflecting...", category: "evolution" }
		case "evolution:change": return { text: `Evolving: ${payload.action}`, category: "evolution" }
		case "evolution:completed": {
			const count = (payload.changes as unknown[])?.length ?? 0
			return { text: count > 0 ? `Evolution: ${count} change(s)` : "Evolution: no changes", category: "evolution" }
		}
		case "evolution:failed": return { text: "Evolution error", category: "evolution" }
		default: return null
	}
}

/** The brain learns from plain text: the label, then one line per field. */
function itemToText(item: DataItem): string {
	const fields = Object.entries(item.data).map(([key, value]) =>
		typeof value === "string" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`,
	)
	return [item.label, ...fields].join("\n")
}

async function retryAsync<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err
			console.warn(`[useBrain] Attempt ${attempt + 1}/${maxRetries} failed:`, err instanceof Error ? err.message : err)
		}
	}
	throw lastError
}
