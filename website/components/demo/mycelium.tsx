import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react"
import type { Neuron, BrainEvent } from "../../lib/demo/types"
import { BlobManager, MAX_BLOBS } from "./mycelium/blob-manager"
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./mycelium/shader"

export interface MyceliumHandle {
	getBlobScreenPos: (neuronId: string) => { x: number; y: number; radius: number } | null
}

interface Props {
	neurons: Neuron[]
	events: BrainEvent[]
	onSelectNeuron?: (neuronId: string | null) => void
	selectedNeuronId?: string | null
}

function createShader(
	gl: WebGLRenderingContext,
	type: number,
	source: string,
): WebGLShader | null {
	const shader = gl.createShader(type)
	if (!shader) return null
	gl.shaderSource(shader, source)
	gl.compileShader(shader)
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.error("Shader compile error:", gl.getShaderInfoLog(shader))
		gl.deleteShader(shader)
		return null
	}
	return shader
}

function createProgram(
	gl: WebGLRenderingContext,
	vs: WebGLShader,
	fs: WebGLShader,
): WebGLProgram | null {
	const program = gl.createProgram()
	if (!program) return null
	gl.attachShader(program, vs)
	gl.attachShader(program, fs)
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		console.error("Program link error:", gl.getProgramInfoLog(program))
		gl.deleteProgram(program)
		return null
	}
	return program
}

const ACTIVITY_LABELS: Record<string, string> = {
	observing: "observing",
	thinking: "thinking",
	synthesizing: "synthesizing",
	querying: "querying",
	idle: "",
}

export const Mycelium = forwardRef<MyceliumHandle, Props>(function Mycelium({ neurons, events, onSelectNeuron, selectedNeuronId }, ref) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const managerRef = useRef(new BlobManager())

	useImperativeHandle(ref, () => ({
		getBlobScreenPos: (neuronId: string) => {
			const canvas = canvasRef.current
			if (!canvas) return null
			const pos = managerRef.current.getBlobScreenPos(neuronId, canvas.width, canvas.height)
			if (!pos) return null
			const rect = canvas.getBoundingClientRect()
			const scaleX = rect.width / canvas.width
			const scaleY = rect.height / canvas.height
			return {
				x: rect.left + pos.x * scaleX,
				y: rect.top + pos.y * scaleY,
				radius: pos.radius * Math.min(scaleX, scaleY),
			}
		},
	}), [])
	const glRef = useRef<{
		offscreen: HTMLCanvasElement
		gl: WebGLRenderingContext
		program: WebGLProgram
		locs: {
			resolution: WebGLUniformLocation | null
			time: WebGLUniformLocation | null
			blobCount: WebGLUniformLocation | null
			injection: WebGLUniformLocation | null
			blobs: (WebGLUniformLocation | null)[]
			blobData: (WebGLUniformLocation | null)[]
		}
	} | null>(null)
	const rafRef = useRef(0)
	const startTimeRef = useRef(performance.now() / 1000)
	const prevTimeRef = useRef(performance.now() / 1000)
	const prevNeuronsRef = useRef<string[]>([])
	const processedEventsRef = useRef(new Set<string>())

	// ─── Sync neurons with blob manager ────────────────────────────

	useEffect(() => {
		const manager = managerRef.current
		const currentIds = neurons.map((l) => l.id)
		const prevIds = prevNeuronsRef.current

		for (const neuron of neurons) {
			if (!prevIds.includes(neuron.id)) {
				manager.addNeuron(neuron.id, neuron.name)
			}
		}

		for (const prevId of prevIds) {
			if (!currentIds.includes(prevId)) {
				manager.removeNeuron(prevId)
			}
		}

		for (const neuron of neurons) {
			manager.updateUnderstandingSize(neuron.id, neuron.understandingSize)
			manager.updateActivity(neuron.id, neuron.activity)
			const blob = manager.blobs.find((b) => b.neuronId === neuron.id)
			if (blob) {
				if (!blob.name) blob.name = neuron.name
				// Sync metrics from state to blob for label rendering
				blob.observationCount = neuron.metrics.observations
				blob.synthesisCount = neuron.metrics.syntheses
			}
		}

		prevNeuronsRef.current = currentIds
	}, [neurons])

	// ─── Process events → blob reactions ────────────────────────────

	useEffect(() => {
		const manager = managerRef.current
		const processed = processedEventsRef.current

		for (const event of events) {
			if (processed.has(event.id)) continue
			processed.add(event.id)

			const payload = event.payload as Record<string, unknown>
			const neuronId = payload.neuronId as string | undefined

			switch (event.type) {
				case "brain:init:started":
					manager.onInitStarted()
					break
				case "brain:init:config:generated": {
					const configs = payload.configs as unknown[]
					if (Array.isArray(configs)) {
						manager.onConfigGenerated(configs.length)
					}
					break
				}
				case "brain:init:completed":
					manager.dissolveNucleus()
					break
				case "inject:started":
					manager.onInjection()
					break
				case "neuron:observed":
					if (neuronId) manager.onObserved(neuronId)
					break
				case "neuron:observe:dismissed":
					if (neuronId) manager.onDismissed(neuronId)
					break
				case "neuron:synthesized":
					if (neuronId) {
						const sig = (payload.significance as number) ?? 0.5
						const gaps = payload.gaps as string[] | undefined
						manager.onSynthesized(neuronId, sig, gaps)
					}
					break
				case "neuron:health:updated":
					if (neuronId) {
						manager.updateHealth(
							neuronId,
							(payload.activation as number) ?? 0.5,
							(payload.status as string) ?? "active",
						)
					}
					break
				case "evolution:change": {
					const mergedIds = payload.mergedIds as string[] | undefined
					if (payload.action === "merge" && mergedIds && neuronId) {
						manager.onMerge(mergedIds.filter((id) => id !== neuronId), neuronId)
					}
					break
				}
			}
		}

		if (processed.size > 500) {
			const arr = Array.from(processed)
			for (let i = 0; i < arr.length - 200; i++) {
				processed.delete(arr[i])
			}
		}
	}, [events])

	// ─── Click handling ────────────────────────────────────────────

	const handleCanvasClick = useCallback(
		(e: React.MouseEvent<HTMLCanvasElement>) => {
			if (!onSelectNeuron) return
			const canvas = canvasRef.current
			if (!canvas) return
			const rect = canvas.getBoundingClientRect()
			// Convert CSS click coords to canvas pixel coords
			const scaleX = canvas.width / rect.width
			const scaleY = canvas.height / rect.height
			const x = (e.clientX - rect.left) * scaleX
			const y = (e.clientY - rect.top) * scaleY
			const hit = managerRef.current.hitTest(x, y, canvas.width, canvas.height)
			onSelectNeuron(hit)
		},
		[onSelectNeuron],
	)

	// ─── Setup offscreen WebGL ──────────────────────────────────────

	const initGL = useCallback((w: number, h: number) => {
		const offscreen = document.createElement("canvas")
		offscreen.width = w
		offscreen.height = h

		const gl = offscreen.getContext("webgl", { preserveDrawingBuffer: true })
		if (!gl) return null

		const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
		const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
		if (!vs || !fs) return null

		const program = createProgram(gl, vs, fs)
		if (!program) return null

		const buffer = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)

		const posLoc = gl.getAttribLocation(program, "a_position")
		gl.enableVertexAttribArray(posLoc)
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

		const blobs: (WebGLUniformLocation | null)[] = []
		const blobData: (WebGLUniformLocation | null)[] = []
		for (let i = 0; i < MAX_BLOBS; i++) {
			blobs.push(gl.getUniformLocation(program, `u_blobs[${i}]`))
			blobData.push(gl.getUniformLocation(program, `u_blobData[${i}]`))
		}

		gl.useProgram(program)

		return {
			offscreen, gl, program,
			locs: {
				resolution: gl.getUniformLocation(program, "u_resolution"),
				time: gl.getUniformLocation(program, "u_time"),
				blobCount: gl.getUniformLocation(program, "u_blobCount"),
				injection: gl.getUniformLocation(program, "u_injection"),
				blobs, blobData,
			},
		}
	}, [])

	// ─── Render loop ────────────────────────────────────────────────

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return

		const w = Math.min(800, window.innerWidth)
		const h = Math.min(600, window.innerHeight)
		canvas.width = w
		canvas.height = h

		const ctx2d = canvas.getContext("2d")
		if (!ctx2d) return

		const glCtx = initGL(w, h)
		if (!glCtx) return
		glRef.current = glCtx
		const { offscreen, gl, locs } = glCtx
		const glW = offscreen.width
		const glH = offscreen.height

		const render = () => {
			rafRef.current = requestAnimationFrame(render)

			const now = performance.now() / 1000
			const t = now - startTimeRef.current
			const dt = now - prevTimeRef.current
			prevTimeRef.current = now

			managerRef.current.update(dt)

			gl.viewport(0, 0, glW, glH)
			gl.clearColor(1.0, 1.0, 1.0, 1.0)
			gl.clear(gl.COLOR_BUFFER_BIT)

			gl.uniform2f(locs.resolution!, glW, glH)
			gl.uniform1f(locs.time!, t)
			gl.uniform1i(locs.blobCount!, managerRef.current.count)
			gl.uniform1f(locs.injection!, managerRef.current.injectionPulse)

			const positions = managerRef.current.packPositions()
			const data = managerRef.current.packData()

			for (let i = 0; i < managerRef.current.count; i++) {
				const loc = locs.blobs[i]
				if (loc) gl.uniform4f(loc, positions[i * 4], positions[i * 4 + 1], positions[i * 4 + 2], positions[i * 4 + 3])
				const dLoc = locs.blobData[i]
				if (dLoc) gl.uniform4f(dLoc, data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3])
			}

			gl.drawArrays(gl.TRIANGLES, 0, 6)

			// Copy to visible 2D canvas
			ctx2d.drawImage(offscreen, 0, 0)

			// ─── Labels ────────────────────────────────────────────
			const manager = managerRef.current
			for (let i = 0; i < manager.count; i++) {
				const blob = manager.blobs[i]
				if (!blob.name || blob.life < 0.3) continue
				const px = (blob.x * 0.5 + 0.5) * w
				const py = (1.0 - (blob.y * 0.5 + 0.5)) * h
				const blobRadiusPx = blob.radius * blob._radiusScale * Math.min(w, h) * 0.5
				const labelY = py + blobRadiusPx + 8
				const alpha = Math.min(blob.life, 1.0)
				const isActive = blob.activity !== "idle"

				// Name — brighter when active
				ctx2d.font = `500 11px "SF Mono", "Fira Code", "Cascadia Code", monospace`
				ctx2d.textAlign = "center"
				ctx2d.textBaseline = "top"
				const nameAlpha = isActive ? alpha * 0.95 : alpha * 0.75
				ctx2d.fillStyle = `rgba(50, 50, 60, ${nameAlpha})`
				ctx2d.fillText(blob.name, px, labelY)

				// Metrics line: counters + activity status
				const activityLabel = ACTIVITY_LABELS[blob.activity] || ""
				const metricsText = activityLabel
					? `${blob.observationCount} obs · ${activityLabel}`
					: blob.observationCount > 0
						? `${blob.observationCount} obs · ${blob.synthesisCount} syn`
						: ""

				if (metricsText) {
					ctx2d.font = `9px "SF Mono", "Fira Code", "Cascadia Code", monospace`
					ctx2d.fillStyle = isActive
						? `rgba(70, 70, 80, ${alpha * 0.85})`
						: `rgba(120, 120, 135, ${alpha * 0.45})`
					ctx2d.fillText(metricsText, px, labelY + 14)
				}
			}
		}

		rafRef.current = requestAnimationFrame(render)

		return () => {
			cancelAnimationFrame(rafRef.current)
		}
	}, [initGL])

	return (
		<canvas
			ref={canvasRef}
			className="mycelium"
			style={{ width: "100%", maxWidth: 800, height: "auto", maxHeight: "100%", mixBlendMode: "multiply", cursor: onSelectNeuron ? "pointer" : "default" }}
			onClick={handleCanvasClick}
		/>
	)
})
