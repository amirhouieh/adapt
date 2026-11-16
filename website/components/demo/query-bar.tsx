import { useState, useRef, useEffect, useCallback, type CSSProperties, type RefObject } from "react"
import Markdown from "react-markdown"
import type { LanguageModel } from "ai"
import type { Brain, Neuron as AdaptNeuron } from "adapt-memory"
import type { Neuron } from "../../lib/demo/types"
import { classifyIntent } from "../../lib/demo/model"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Check } from "lucide-react"

interface Source {
	id: string
	relevance?: number
	insight: string
}

interface NeuronResult {
	neuronId: string
	name: string
	text: string
	done: boolean
	error?: string
}

interface QueryResult {
	intent?: "ask" | "signal"
	status?: string
	insight?: string
	sources?: Source[]
	gaps?: string[]
	neuronResults?: NeuronResult[]
	error?: string
}

interface Suggestions {
	ask: string[]
	signal: string[]
}

interface Props {
	neurons: Neuron[]
	model: LanguageModel
	disabled: boolean
	brainRef: RefObject<Brain | null>
	onActiveChange?: (active: boolean) => void
	suggestions?: Suggestions
}

const s = {
	backdropBase: {
		position: "fixed",
		inset: 0,
		zIndex: 59,
		background: "rgba(255, 255, 255, 0.4)",
		backdropFilter: "blur(16px)",
		WebkitBackdropFilter: "blur(16px)",
		transition: "opacity 0.25s ease",
		pointerEvents: "none",
	} as CSSProperties,

	wrapper: {
		position: "fixed",
		bottom: "3.5rem",
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 60,
		width: "min(600px, calc(100% - 2rem))",
		display: "flex",
		flexDirection: "column",
		gap: "0.5rem",
	} as CSSProperties,

	card: {
		background: "rgba(255, 255, 255, 0.15)",
		backdropFilter: "blur(32px)",
		WebkitBackdropFilter: "blur(32px)",
		borderRadius: 14,
		boxShadow: "0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)",
		padding: "0.85rem 1.3rem",
		display: "flex",
		flexDirection: "column",
		gap: "0.5rem",
	} as CSSProperties,

	inputRow: {
		display: "flex",
		alignItems: "flex-end",
		gap: "0.6rem",
	} as CSSProperties,

	input: {
		flex: 1,
		minHeight: "1.9rem",
		maxHeight: 180,
		background: "none",
		border: "none",
		outline: "none",
		fontSize: "0.95rem",
		fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
		color: "#1a1a1f",
		padding: "0.45rem 0",
		letterSpacing: "-0.01em",
		lineHeight: 1.5,
		resize: "none",
		overflowY: "auto",
		fieldSizing: "content",
	} as CSSProperties,


	resultsAnchor: {
		position: "fixed",
		top: 0,
		left: "50%",
		transform: "translateX(-50%)",
		width: "min(620px, calc(100% - 2rem))",
		zIndex: 60,
		height: "100dvh",
		overflowY: "auto",
		scrollbarWidth: "none",
		padding: "1.5rem 0 7rem",
		boxSizing: "border-box",
		display: "flex",
		flexDirection: "column",
	} as CSSProperties,

	resultText: {
		fontSize: "0.92rem",
		color: "#6b6b78",
		fontFamily: '"Georgia", "Times New Roman", serif',
		lineHeight: 1.8,
	} as CSSProperties,

	label: {
		fontSize: "0.58rem",
		fontWeight: 500,
		textTransform: "uppercase",
		letterSpacing: "0.06em",
		color: "#9b9ba8",
		marginBottom: "0.25rem",
	} as CSSProperties,

	inlineStatus: {
		fontSize: "0.68rem",
		fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
		color: "#9b9ba8",
		padding: "0.25rem 0",
	} as CSSProperties,
}

function SourceCards({ sources }: { sources: Source[] }) {
	const [expandedId, setExpandedId] = useState<string | null>(null)

	return (
		<div style={{ marginTop: "0.75rem" }}>
			<div style={s.label}>sources ({sources.length})</div>
			<div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.3rem" }}>
				{sources.map((src) => {
					const isOpen = expandedId === src.id
					return (
						<div key={src.id}>
							<button
								type="button"
								onClick={() => setExpandedId(isOpen ? null : src.id)}
								style={{
									background: isOpen ? "rgba(26, 26, 31, 0.06)" : "rgba(26, 26, 31, 0.03)",
									border: "1px solid rgba(155, 155, 168, 0.15)",
									borderRadius: 6,
									padding: "0.3rem 0.55rem",
									cursor: "pointer",
									fontSize: "0.68rem",
									fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
									color: "#6b6b78",
									transition: "background 0.15s",
								}}
							>
								{src.id}
								{src.relevance != null && (
									<span style={{ opacity: 0.4, marginLeft: "0.35rem" }}>
										{Math.round(src.relevance * 100)}%
									</span>
								)}
							</button>
							{isOpen && (
								<div
									style={{
										marginTop: "0.3rem",
										padding: "0.5rem 0.6rem",
										background: "rgba(26, 26, 31, 0.03)",
										borderRadius: 8,
										border: "1px solid rgba(155, 155, 168, 0.1)",
										fontSize: "0.78rem",
										fontFamily: '"Georgia", "Times New Roman", serif',
										color: "#6b6b78",
										lineHeight: 1.7,
									}}
									className="query-markdown"
								>
									<Markdown>{src.insight}</Markdown>
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}

function SuggestionGroup({ label, items, onPick }: { label: string; items: string[]; onPick: (q: string) => void }) {
	const isSignal = label === "signal"
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
			<span style={{
				fontSize: "0.54rem",
				fontWeight: 500,
				textTransform: "uppercase",
				letterSpacing: "0.08em",
				color: "#9b9ba8",
				fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
				paddingLeft: "0.15rem",
			}}>
				{label}
			</span>
			{items.map((item) => (
				<button
					key={item}
					type="button"
					style={{
						background: isSignal ? "rgba(45, 122, 79, 0.04)" : "rgba(26, 26, 31, 0.03)",
						border: `1px solid ${isSignal ? "rgba(45, 122, 79, 0.15)" : "rgba(155, 155, 168, 0.15)"}`,
						borderRadius: 99,
						padding: "0.3rem 0.7rem",
						cursor: "pointer",
						fontSize: "0.68rem",
						fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
						color: isSignal ? "rgba(45, 122, 79, 0.6)" : "#9b9ba8",
						transition: "color 0.15s, border-color 0.15s",
						textAlign: "left",
						alignSelf: "flex-start",
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.color = isSignal ? "rgb(45, 122, 79)" : "#1a1a1f"
						e.currentTarget.style.borderColor = isSignal ? "rgba(45, 122, 79, 0.35)" : "rgba(155, 155, 168, 0.3)"
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.color = isSignal ? "rgba(45, 122, 79, 0.6)" : "#9b9ba8"
						e.currentTarget.style.borderColor = isSignal ? "rgba(45, 122, 79, 0.15)" : "rgba(155, 155, 168, 0.15)"
					}}
					onMouseDown={(e) => {
						e.preventDefault()
						onPick(item)
					}}
				>
					{item}
				</button>
			))}
		</div>
	)
}

export function QueryBar({ neurons, model, disabled, brainRef, onActiveChange, suggestions }: Props) {
	const [query, setQuery] = useState("")
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
	const [deepSearch, setDeepSearch] = useState(false)
	const [focused, setFocused] = useState(false)
	const [loading, setLoading] = useState(false)
	const [result, setResult] = useState<QueryResult | null>(null)
	const [menuOpen, setMenuOpen] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const abortRef = useRef<AbortController | null>(null)
	const pendingSubmitRef = useRef<string | null>(null)

	const searchOpen = result?.intent === "ask"

	const closeSearch = useCallback(() => {
		setResult(null)
		setMenuOpen(false)
		setFocused(false)
		setQuery("")
		setLoading(false)
		abortRef.current?.abort()
		onActiveChange?.(false)
	}, [onActiveChange])

	useEffect(() => {
		if (searchOpen) onActiveChange?.(true)
	}, [searchOpen, onActiveChange])

	useEffect(() => {
		if (!searchOpen) return
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSearch() }
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [searchOpen, closeSearch])

	useEffect(() => {
		if (!disabled) return
		setFocused(false)
		setMenuOpen(false)
	}, [disabled])

	useEffect(() => {
		const textarea = inputRef.current
		if (!textarea) return
		textarea.style.height = "0px"
		textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
	}, [query, disabled])

	const toggleNeuron = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	const submit = async () => {
		const q = query.trim()
		if (!q || loading || disabled) return

		const brain = brainRef.current
		if (!brain) return

		abortRef.current?.abort()
		const abort = new AbortController()
		abortRef.current = abort

		setLoading(true)
		setResult({ status: "Classifying..." })

		try {
			const intent = await classifyIntent(model, q, neurons.map((n) => n.name))
			if (abort.signal.aborted) return

			if (intent === "signal") {
				brain.signal({ source: "user:query-bar", description: q })
				setQuery("")
				setResult(null)
				setFocused(false)
				return
			}

			// Ask: open overlay
			setResult({ intent: "ask", status: "Thinking..." })
			const mode = deepSearch ? "deep" : "direct"

			if (selectedIds.size > 0) {
				const selectedNeurons = Array.from(selectedIds)
					.map((id) => brain.getNeuron(id))
					.filter((n): n is AdaptNeuron => n != null)

				setResult((prev) => ({
					...prev,
					status: undefined,
					neuronResults: selectedNeurons.map((n) => ({
						neuronId: n.id,
						name: neurons.find((x) => x.id === n.id)?.name ?? n.id,
						text: "",
						done: false,
					})),
				}))

				await Promise.all(
					selectedNeurons.map(async (neuron) => {
						try {
							const stream = await neuron.queryStream(q)
							for await (const chunk of stream.textStream) {
								if (abort.signal.aborted) return
								setResult((prev) => ({
									...prev,
									neuronResults: prev?.neuronResults?.map((r) =>
										r.neuronId === neuron.id ? { ...r, text: r.text + chunk } : r
									),
								}))
							}
							setResult((prev) => ({
								...prev,
								neuronResults: prev?.neuronResults?.map((r) =>
									r.neuronId === neuron.id ? { ...r, done: true } : r
								),
							}))
						} catch (err) {
							if (abort.signal.aborted) return
							setResult((prev) => ({
								...prev,
								neuronResults: prev?.neuronResults?.map((r) =>
									r.neuronId === neuron.id
										? { ...r, done: true, error: err instanceof Error ? err.message : "Failed" }
										: r
								),
							}))
						}
					})
				)
			} else {
				const streamResult = await brain.askStream(q, { mode })

				let accumulated = ""
				for await (const chunk of streamResult.textStream) {
					if (abort.signal.aborted) break
					accumulated += chunk
					setResult((prev) => ({ ...prev, insight: accumulated, status: undefined }))
				}

				setResult((prev) => ({
					...prev,
					insight: accumulated,
					sources: [],
					status: undefined,
				}))
			}
		} catch (err) {
			if (!abort.signal.aborted) {
				setResult({ intent: "ask", error: err instanceof Error ? err.message : "Unknown error" })
			}
		} finally {
			setLoading(false)
		}
	}

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault()
			submit()
		}
	}

	// Auto-submit when a suggestion is picked
	useEffect(() => {
		if (pendingSubmitRef.current && query === pendingSubmitRef.current) {
			pendingSubmitRef.current = null
			submit()
		}
	}, [query])

	const showSuggestions = focused && !query && !loading && !searchOpen && suggestions && (suggestions.ask.length > 0 || suggestions.signal.length > 0)

	return (
		<>
			{/* Backdrop: full blur for search results, lighter blur for focused/suggestions */}
			<div
				style={{
					...s.backdropBase,
					opacity: searchOpen || showSuggestions ? 1 : 0,
					pointerEvents: searchOpen || showSuggestions ? "auto" : "none",
					background: searchOpen ? "rgba(255, 255, 255, 0.4)" : "rgba(255, 255, 255, 0.25)",
					backdropFilter: searchOpen ? "blur(16px)" : "blur(10px)",
					WebkitBackdropFilter: searchOpen ? "blur(16px)" : "blur(10px)",
				}}
				onClick={() => {
					if (searchOpen) closeSearch()
					else { setFocused(false); inputRef.current?.blur() }
				}}
			/>

			{searchOpen && result && (
				<div style={s.resultsAnchor}>
					<button
						type="button"
						onClick={closeSearch}
						style={{
							position: "sticky",
							top: 0,
							alignSelf: "flex-end",
							background: "rgba(26, 26, 31, 0.06)",
							border: "1px solid rgba(155, 155, 168, 0.15)",
							borderRadius: 8,
							padding: "0.3rem 0.7rem",
							cursor: "pointer",
							fontSize: "0.7rem",
							fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
							color: "#6b6b78",
							marginBottom: "1rem",
							zIndex: 1,
						}}
					>
						Close
					</button>
					{result.status && (
						<div style={{ ...s.resultText, color: "#9b9ba8", marginBottom: "0.5rem" }}>
							{result.status}
						</div>
					)}

					{result.insight && (
						<div>
							<div style={s.resultText} className="query-markdown">
								<Markdown>{result.insight}</Markdown>
							</div>
							{result.sources && result.sources.length > 0 && (
								<SourceCards sources={result.sources} />
							)}
							{result.gaps && result.gaps.length > 0 && (
								<div style={{ ...s.resultText, marginTop: "0.5rem", fontSize: "0.72rem", opacity: 0.4 }}>
									gaps: {result.gaps.join(", ")}
								</div>
							)}
						</div>
					)}

					{result.neuronResults && result.neuronResults.length > 0 && (
						<div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
							{result.neuronResults.map((r) => (
								<div
									key={r.neuronId}
									style={{ borderLeft: "2px solid rgba(155, 155, 168, 0.2)", paddingLeft: "0.75rem" }}
								>
									<div style={{ ...s.label, marginBottom: "0.35rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
										<span>{r.name}</span>
										{!r.done && <span style={{ opacity: 0.5, fontSize: "0.5rem" }}>streaming...</span>}
									</div>
									{r.error ? (
										<div style={{ ...s.resultText, color: "#d94848", fontSize: "0.82rem" }}>{r.error}</div>
									) : (
										<div style={s.resultText} className="query-markdown">
											<Markdown>{r.text}</Markdown>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{result.error && (
						<div style={{ ...s.resultText, color: "#d94848" }}>{result.error}</div>
					)}
				</div>
			)}

			<div style={s.wrapper}>
				{showSuggestions && (
					<div style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.75rem",
						padding: "0 0.2rem 0.25rem",
					}}>
						{suggestions.ask.length > 0 && (
							<SuggestionGroup
								label="ask"
								items={suggestions.ask}
								onPick={(q) => { setQuery(q); pendingSubmitRef.current = q }}
							/>
						)}
						{suggestions.signal.length > 0 && (
							<SuggestionGroup
								label="signal"
								items={suggestions.signal}
								onPick={(q) => { setQuery(q); pendingSubmitRef.current = q }}
							/>
						)}
					</div>
				)}

				<div
					style={{ ...s.card, position: "relative" }}
					onBlur={(e) => {
						const related = e.relatedTarget as HTMLElement | null
						// Don't blur if focus moved to a portal (popover content)
						if (related && !e.currentTarget.contains(related) && !related.closest?.("[data-slot=popover-content]")) {
							setFocused(false)
							setMenuOpen(false)
						}
					}}
				>
					<div style={s.inputRow}>
						<textarea
							ref={inputRef}
							value={query}
							placeholder={disabled ? "waiting for injection to start..." : "ask the brain something..."}
							style={s.input}
							disabled={disabled}
							onFocus={() => setFocused(true)}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onKeyDown}
						/>
						{focused && (
							<div className="flex items-center gap-1.5 shrink-0">
								<div className="flex items-center gap-1.5">
									<span className="text-xs text-muted-foreground">fast</span>
									<Switch
										checked={deepSearch}
										onCheckedChange={setDeepSearch}
									/>
									<span className="text-xs text-muted-foreground">deep</span>
								</div>
								{neurons.length > 0 && (
									<Popover open={menuOpen} onOpenChange={setMenuOpen}>
										<PopoverTrigger
											render={<Button variant="outline" size="sm" />}
										>
											{selectedIds.size > 0 ? `${selectedIds.size} neurons` : "neurons"}
										</PopoverTrigger>
										<PopoverContent side="top" sideOffset={8} className="w-56 p-1">
											{neurons.map((n) => {
												const on = selectedIds.has(n.id)
												return (
													<button
														key={n.id}
														type="button"
														className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-muted transition-colors text-left"
														onClick={() => toggleNeuron(n.id)}
													>
														<span className="flex size-4 items-center justify-center">
															{on && <Check className="size-3.5" />}
														</span>
														<span>{n.name}</span>
													</button>
												)
											})}
										</PopoverContent>
									</Popover>
								)}
								<Button
									size="sm"
									disabled={loading}
									onClick={submit}
									className="shrink-0"
								>
									↵
								</Button>
							</div>
						)}
					</div>

					{result && !result.intent && result.status && (
						<div style={s.inlineStatus}>{result.status}</div>
					)}

				</div>

			</div>
		</>
	)
}
