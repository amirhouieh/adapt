"use client"

import { useState, useCallback, useEffect } from "react"
import type { UseCase } from "../../lib/demo/use-cases"
import type { DataSource } from "../../lib/demo/types"
import { useBrain } from "../../lib/demo/use-brain"
import {
	DEFAULT_MODEL,
	createDemoModel,
	loadModelId,
	saveModelId,
	type DemoModelId,
} from "../../lib/demo/model"
import { ConversationFlow } from "./conversation-flow"
import { Mycelium } from "./mycelium"
import { QueryBar } from "./query-bar"
import { StatusDisplay } from "./status-display"
import { DemoBreadcrumb } from "./breadcrumb"

export function DemoOrchestrator() {
	const [live, setLive] = useState(false)
	const [activeUseCase, setActiveUseCase] = useState<UseCase | null>(null)
	const [modelId, setModelId] = useState<DemoModelId>(DEFAULT_MODEL)
	const [error, setError] = useState<string | null>(null)

	// Read the saved choices after mount (localStorage is not on the server).
	useEffect(() => {
		setModelId(loadModelId())
	}, [])
	const { state, brain, start, inject, destroy } = useBrain()
	const injectionStarted = state.injectionProgress !== null || state.events.some((event) => event.type === "brain:inject:started")

	const handleStart = useCallback(async (useCase: UseCase, prompt: string) => {
		setLive(true)
		setActiveUseCase(useCase)

		setError(null)
		const model = createDemoModel(modelId)

		try {
			await start({
				prompt,
				model,
				autoSetup: useCase.autoSetup,
			learning: useCase.learning,
				evolution: useCase.evolution,
				ingest: useCase.ingest,
			})

			// Auto-inject data in background
			const dataSources = await loadDataSources(useCase.dataPaths)
			inject(dataSources)
		} catch (err) {
			// Go back to the start screen with the error.
			destroy()
			setLive(false)
			setError(err instanceof Error ? err.message : "Something went wrong.")
		}
	}, [start, inject, destroy, modelId])

	// Cleanup on unmount
	useEffect(() => {
		return () => { destroy() }
	}, [destroy])

	if (!live) {
		return (
			<div style={{ width: "100%", height: "100dvh" }}>
				<DemoBreadcrumb />
				<ConversationFlow
					onStart={handleStart}
					modelId={modelId}
					error={error}
					onModelChange={(id) => { setModelId(id); saveModelId(id) }}
				/>
			</div>
		)
	}

	return (
		<div style={{ width: "100%", height: "100dvh", position: "relative", overflow: "hidden" }}>
			<DemoBreadcrumb useCaseName={activeUseCase?.title} />

			{/* Shader visualization — centered on desktop, bottom on mobile */}
			<div className="absolute inset-0 bottom-[50px] flex items-end justify-center md:bottom-0 md:items-center">
				<Mycelium
					neurons={state.neurons}
					events={state.events}
				/>
			</div>

			{/* Status + info button */}
			<StatusDisplay
				activity={state.activity}
				commentary={state.commentary}
				injectionProgress={state.injectionProgress}
				evolutionActivity={state.evolutionActivity}
				evolutionCommentary={state.evolutionCommentary}
				useCase={activeUseCase}
				modelId={modelId}
			/>

			{/* Query bar + evolution status — bottom center */}
			<QueryBar
				neurons={state.neurons}
				model={createDemoModel(modelId)}
				disabled={state.phase !== "ready" || !injectionStarted}
				brainRef={brain}
				suggestions={activeUseCase?.suggestions}
			/>
		</div>
	)
}


async function loadDataSources(paths: string[]): Promise<DataSource[]> {
	const sources: DataSource[] = []
	for (const path of paths) {
		const res = await fetch(path)
		const data = await res.json()
		sources.push(data)
	}
	return sources
}
