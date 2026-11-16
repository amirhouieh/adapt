"use client"

import { useState, useEffect, useRef, type ReactNode } from "react"
import { Settings2 } from "lucide-react"
import type { UseCase } from "../../lib/demo/use-cases"
import type { InjectionProgress } from "../../lib/demo/types"
import { DEFAULT_MODEL } from "../../lib/demo/model"
import { TextReveal } from "./text-reveal"
import { Button } from "@/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog"
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs"

const mono = '"SF Mono", "Fira Code", "Cascadia Code", monospace'

interface Props {
	activity: string
	commentary: string
	injectionProgress: InjectionProgress | null
	evolutionActivity: string
	evolutionCommentary: string
	useCase: UseCase | null
	modelId: string
}

export function StatusDisplay({
	activity,
	commentary,
	injectionProgress,
	evolutionActivity,
	evolutionCommentary,
	useCase,
	modelId,
}: Props) {
	const lines = commentary ? commentary.split("\n\n").filter(Boolean) : []
	const latestComment = lines.length > 0 ? lines[lines.length - 1] : null
	const [commentKey, setCommentKey] = useState(0)
	const prevCommentRef = useRef<string | null>(null)
	const [detailsOpen, setDetailsOpen] = useState(false)

	const [evoCommentKey, setEvoCommentKey] = useState(0)
	const prevEvoCommentRef = useRef<string | null>(null)

	useEffect(() => {
		if (latestComment && latestComment !== prevCommentRef.current) {
			prevCommentRef.current = latestComment
			setCommentKey((k) => k + 1)
		}
	}, [latestComment])

	useEffect(() => {
		if (evolutionCommentary && evolutionCommentary !== prevEvoCommentRef.current) {
			prevEvoCommentRef.current = evolutionCommentary
			setEvoCommentKey((k) => k + 1)
		}
	}, [evolutionCommentary])

	useEffect(() => {
		setDetailsOpen(false)
	}, [useCase?.id])

	const progress = injectionProgress?.batchCount
		? injectionProgress.batchIndex / injectionProgress.batchCount
		: 0

	const showActivitySpinner = activity !== "" && activity !== "Ready" && activity !== "Brain ready" && activity !== "Injection complete"
	const showEvoSpinner = evolutionActivity !== ""

	return (
		<>
			{/* Desktop-only: fixed top-right */}
			{useCase && (
				<>
					<Button
						type="button"
						size="sm"
						onClick={() => setDetailsOpen(true)}
						aria-label={`Open ${useCase.title} details`}
						className="hidden md:inline-flex fixed top-4 right-4 z-50 gap-1.5"
					>
						<Settings2 size={14} strokeWidth={1.8} />
						Parameters
					</Button>
					<UseCaseDetailsDialog
						open={detailsOpen}
						onOpenChange={setDetailsOpen}
						useCase={useCase}
						modelId={modelId}
					/>
				</>
			)}

			<div className="fixed left-4 z-50 pointer-events-none flex flex-col gap-5 top-[4.5rem] max-w-[min(420px,calc(100%-2rem))]">
				{/* Mobile-only: inline above status */}
				{useCase && (
					<Button
						type="button"
						size="sm"
						onClick={() => setDetailsOpen(true)}
						aria-label={`Open ${useCase.title} details`}
						className="md:hidden pointer-events-auto self-start gap-1.5"
					>
						<Settings2 size={14} strokeWidth={1.8} />
						Parameters
					</Button>
				)}
				{injectionProgress && (
					<div style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.4rem",
					}}>
						<div style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							fontFamily: mono,
							fontSize: "0.72rem",
							color: "#6b6b78",
							lineHeight: 1.6,
						}}>
							<span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
								<Spinner />
								Injecting {injectionProgress.sourceLabel}
							</span>
							{injectionProgress.batchCount > 0 && (
								<span style={{ color: "#9b9ba8", fontSize: "0.65rem" }}>
									{injectionProgress.batchIndex}/{injectionProgress.batchCount}
								</span>
							)}
						</div>
						<div style={{
							padding: "0.85rem 0.75rem",
							background: "rgba(26, 26, 31, 0.03)",
							border: "1px solid rgba(26, 26, 31, 0.08)",
							borderRadius: 6,
							overflow: "hidden",
						}}>
							<span style={{
								display: "block",
								fontSize: "0.6rem",
								fontFamily: mono,
								color: "#9b9ba8",
								textTransform: "uppercase",
								letterSpacing: "0.08em",
								marginBottom: "0.4rem",
							}}>
								Summary
							</span>
							<p style={{
								margin: 0,
								fontSize: "0.7rem",
								fontFamily: mono,
								color: "#9b9ba8",
								lineHeight: 1.6,
							}}>
								{injectionProgress.sourceSummary}
							</p>
							<div style={{
								margin: "0.85rem -0.75rem -0.85rem",
								height: 2,
								background: "rgba(155, 155, 168, 0.15)",
								borderRadius: "0 0 6px 6px",
								overflow: "hidden",
							}}>
								<div style={{
									width: `${progress * 100}%`,
									height: "100%",
									background: "rgba(26, 26, 31, 0.4)",
									transition: "width 0.6s ease",
								}} />
							</div>
						</div>
					</div>
				)}

				{!injectionProgress && activity && (
					<div style={{
						fontSize: "0.7rem",
						fontFamily: mono,
						color: "#9b9ba8",
						letterSpacing: "0.04em",
						display: "inline-flex",
						alignItems: "center",
						gap: "0.5rem",
					}}>
						{showActivitySpinner && <Spinner />}
						{activity}
					</div>
				)}

				{latestComment && (
					<div className="rounded-lg backdrop-blur-sm bg-white/10 p-3 md:backdrop-blur-none md:bg-transparent md:p-0 md:rounded-none" style={{
						fontSize: "0.95rem",
						fontFamily: '"Georgia", "Times New Roman", serif',
						color: "#6b6b78",
						fontStyle: "italic",
						lineHeight: 1.7,
					}}>
						<TextReveal
							text={latestComment}
							chunkType="sentence"
							staggerDelay={0.04}
							duration={0.4}
							blurAmount="6px"
							animationKey={commentKey}
						/>
					</div>
				)}

				{(evolutionActivity || evolutionCommentary) && (
					<div style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.6rem",
						paddingTop: "0.75rem",
						borderTop: "1px solid rgba(155, 155, 168, 0.1)",
					}}>
						{evolutionActivity && (
							<div style={{
								fontSize: "0.7rem",
								fontFamily: mono,
								color: "#9b9ba8",
								letterSpacing: "0.04em",
								display: "inline-flex",
								alignItems: "center",
								gap: "0.5rem",
							}}>
								{showEvoSpinner && <Spinner />}
								{evolutionActivity}
							</div>
						)}
						{evolutionCommentary && (
							<div style={{
								fontSize: "0.88rem",
								fontFamily: '"Georgia", "Times New Roman", serif',
								color: "#6b6b78",
								fontStyle: "italic",
								lineHeight: 1.7,
							}}>
								<TextReveal
									text={evolutionCommentary}
									chunkType="sentence"
									staggerDelay={0.04}
									duration={0.4}
									blurAmount="6px"
									animationKey={evoCommentKey}
								/>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	)
}

function Spinner() {
	return (
		<>
			<style>{`@keyframes status-spin { to { transform: rotate(360deg); } }`}</style>
			<span
				style={{
					width: 10,
					height: 10,
					borderRadius: "50%",
					border: "1.5px solid rgba(26, 26, 31, 0.15)",
					borderTopColor: "rgba(26, 26, 31, 0.55)",
					display: "inline-block",
					animation: "status-spin 0.8s linear infinite",
					flexShrink: 0,
				}}
			/>
		</>
	)
}

function UseCaseDetailsDialog({
	open,
	onOpenChange,
	useCase,
	modelId,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	useCase: UseCase
	modelId: string
}) {
	const code = buildUseCaseCode(useCase, modelId)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-[calc(100%-2rem)] p-0 sm:max-w-5xl"
				style={{
					maxHeight: "84vh",
					overflow: "hidden",
					background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(244,244,247,0.98) 100%)",
					border: "1px solid rgba(26, 26, 31, 0.08)",
					boxShadow: "0 24px 80px rgba(26, 26, 31, 0.14), 0 6px 24px rgba(26, 26, 31, 0.08)",
				}}
			>
				<div style={{
					padding: "1.35rem 1.35rem 1rem",
					borderBottom: "1px solid rgba(26, 26, 31, 0.08)",
					background: "radial-gradient(circle at top left, rgba(155, 155, 168, 0.12), transparent 32%), linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(242,242,246,0.8) 100%)",
				}}>
					<DialogHeader className="pr-8">
						<div style={{
							display: "flex",
							flexDirection: "column",
							gap: "0.75rem",
						}}>
							<SubtleLabel>Demo Use Case</SubtleLabel>
							<DialogTitle style={{
								fontFamily: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
								fontSize: "1.5rem",
								lineHeight: 1.1,
								fontWeight: 500,
								letterSpacing: "-0.02em",
							}}>
								{useCase.title}
							</DialogTitle>
						</div>
						<DialogDescription>{useCase.description}</DialogDescription>
						<div style={{
							display: "flex",
							flexWrap: "wrap",
							gap: "0.5rem",
							paddingTop: "0.2rem",
						}}>
							<MetaPill label="Duration" value={useCase.duration ?? "custom"} />
							<MetaPill label="Sources" value={String(useCase.dataPaths.length)} />
							<MetaPill label="Model" value={compactModelName(modelId)} />
							{useCase.evolution?.enabled && (
								<MetaPill label="Evolution" value={useCase.evolution.autoEvaluate ? "auto" : "manual"} />
							)}
						</div>
					</DialogHeader>
				</div>

				<Tabs defaultValue="config" className="gap-0">
					<div style={{
						padding: "1rem 1.35rem 0.95rem",
						borderBottom: "1px solid rgba(26, 26, 31, 0.08)",
						background: "rgba(255,255,255,0.45)",
					}}>
						<TabsList className="h-11 rounded-full border border-black/8 bg-black/[0.03] p-1.5">
							<TabsTrigger
								value="config"
								className="rounded-full px-4 text-[0.74rem] font-medium tracking-[0.08em] uppercase data-[state=active]:bg-white data-[state=active]:shadow-[0_10px_24px_rgba(26,26,31,0.08)]"
							>
								Config
							</TabsTrigger>
							<TabsTrigger
								value="code"
								className="rounded-full px-4 text-[0.74rem] font-medium tracking-[0.08em] uppercase data-[state=active]:bg-white data-[state=active]:shadow-[0_10px_24px_rgba(26,26,31,0.08)]"
							>
								Code
							</TabsTrigger>
						</TabsList>
					</div>

					<TabsContent value="config">
						<div style={{
							padding: "1.35rem",
							maxHeight: "60vh",
							overflowY: "auto",
							display: "flex",
							flexDirection: "column",
							gap: "1.1rem",
						}}>
							<SectionCard title="Prompt">
								<CodeBlock code={useCase.prompt} wrap />
							</SectionCard>

							<SectionCard title="Models">
								<ValueGrid
									items={[
										["Model", modelId],
									]}
								/>
							</SectionCard>

							<SectionCard title="Runtime">
								<ValueGrid
									items={[
										["Auto setup", String(useCase.autoSetup ?? true)],
										["Ingest batch size", formatScalar(useCase.ingest?.batchSize)],
										["App batch size", formatScalar(useCase.appBatchSize)],
										["Duration", useCase.duration ?? "not specified"],
									]}
								/>
							</SectionCard>

							<SectionCard title="Learning">
								<CodeBlock code={formatJson(useCase.learning ?? {})} />
							</SectionCard>

							<SectionCard title="Evolution">
								<CodeBlock code={formatJson(useCase.evolution ?? {})} />
							</SectionCard>

							<SectionCard title="Data Sources">
								<ListBlock items={useCase.dataPaths} emptyLabel="No data sources" />
							</SectionCard>

							<SectionCard title="Suggestions">
								<div style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
									gap: "0.8rem",
								}}>
									<div>
										<SubtleLabel>Ask</SubtleLabel>
										<ListBlock items={useCase.suggestions?.ask ?? []} emptyLabel="No ask suggestions" />
									</div>
									<div>
										<SubtleLabel>Signal</SubtleLabel>
										<ListBlock items={useCase.suggestions?.signal ?? []} emptyLabel="No signal suggestions" />
									</div>
								</div>
							</SectionCard>
						</div>
					</TabsContent>

					<TabsContent value="code">
						<div style={{
							padding: "1.35rem",
							maxHeight: "60vh",
							overflowY: "auto",
						}}>
							<div style={{
								display: "flex",
								flexDirection: "column",
								gap: "0.8rem",
							}}>
								<div style={{
									display: "flex",
									alignItems: "baseline",
									justifyContent: "space-between",
									gap: "1rem",
								}}>
									<div style={{
										fontSize: "0.72rem",
										fontFamily: mono,
										color: "#7b7b86",
										textTransform: "uppercase",
										letterSpacing: "0.08em",
									}}>
										Initialization + Injection Flow
									</div>
									<div style={{
										fontSize: "0.7rem",
										fontFamily: mono,
										color: "#9b9ba8",
									}}>
										Derived from the active use case
									</div>
								</div>
								<CodeBlock code={code} />
							</div>
						</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	)
}

function SectionCard({
	title,
	children,
}: {
	title: string
	children: ReactNode
}) {
	return (
		<section style={{
			display: "flex",
			flexDirection: "column",
			gap: "0.75rem",
			padding: "1rem",
			borderRadius: 18,
			background: "linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(243,243,247,0.86) 100%)",
			border: "1px solid rgba(26, 26, 31, 0.07)",
			boxShadow: "0 10px 30px rgba(26, 26, 31, 0.04)",
		}}>
			<SubtleLabel>{title}</SubtleLabel>
			{children}
		</section>
	)
}

function SubtleLabel({ children }: { children: ReactNode }) {
	return (
		<div style={{
			fontSize: "0.62rem",
			fontFamily: mono,
			color: "#7b7b86",
			textTransform: "uppercase",
			letterSpacing: "0.08em",
		}}>
			{children}
		</div>
	)
}

function ValueGrid({ items }: { items: [string, string][] }) {
	return (
		<div style={{
			display: "grid",
			gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
			gap: "0.8rem",
		}}>
			{items.map(([label, value]) => (
				<div
					key={label}
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "0.28rem",
						padding: "0.8rem 0.85rem",
						borderRadius: 14,
						background: "rgba(255,255,255,0.72)",
						border: "1px solid rgba(26, 26, 31, 0.06)",
					}}
				>
					<span style={{
						fontSize: "0.65rem",
						fontFamily: mono,
						color: "#9b9ba8",
						textTransform: "uppercase",
						letterSpacing: "0.06em",
					}}>
						{label}
					</span>
					<span style={{
						fontSize: "0.8rem",
						fontFamily: mono,
						color: "#1a1a1f",
						lineHeight: 1.5,
					}}>
						{value}
					</span>
				</div>
			))}
		</div>
	)
}

function ListBlock({
	items,
	emptyLabel,
}: {
	items: string[]
	emptyLabel: string
}) {
	if (items.length === 0) {
		return (
			<div style={{
				fontSize: "0.78rem",
				fontFamily: mono,
				color: "#9b9ba8",
				lineHeight: 1.6,
			}}>
				{emptyLabel}
			</div>
		)
	}

	return (
		<div style={{
			display: "flex",
			flexDirection: "column",
			gap: "0.45rem",
		}}>
			{items.map((item) => (
				<div
					key={item}
					style={{
						fontSize: "0.78rem",
						fontFamily: mono,
						color: "#5a5a66",
						lineHeight: 1.6,
						padding: "0.7rem 0.8rem",
						borderRadius: 12,
						background: "rgba(255,255,255,0.62)",
						border: "1px solid rgba(26, 26, 31, 0.06)",
					}}
				>
					{item}
				</div>
			))}
		</div>
	)
}

function CodeBlock({
	code,
	wrap = false,
}: {
	code: string
	wrap?: boolean
}) {
	return (
		<pre style={{
			margin: 0,
			padding: "1rem 1.05rem",
			borderRadius: 16,
			background: "linear-gradient(180deg, #17171c 0%, #1f1f27 100%)",
			border: "1px solid rgba(255, 255, 255, 0.06)",
			fontSize: "0.72rem",
			fontFamily: mono,
			color: "#e6e6ec",
			lineHeight: 1.65,
			whiteSpace: wrap ? "pre-wrap" : "pre",
			wordBreak: wrap ? "break-word" : "normal",
			overflowX: "auto",
			boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 34px rgba(26,26,31,0.14)",
		}}>
			<code>{code}</code>
		</pre>
	)
}

function MetaPill({ label, value }: { label: string; value: string }) {
	return (
		<div style={{
			display: "inline-flex",
			alignItems: "center",
			gap: "0.45rem",
			padding: "0.45rem 0.65rem",
			borderRadius: 999,
			background: "rgba(255,255,255,0.72)",
			border: "1px solid rgba(26, 26, 31, 0.08)",
			boxShadow: "0 6px 18px rgba(26, 26, 31, 0.04)",
		}}>
			<span style={{
				fontSize: "0.58rem",
				fontFamily: mono,
				color: "#9b9ba8",
				textTransform: "uppercase",
				letterSpacing: "0.08em",
			}}>
				{label}
			</span>
			<span style={{
				fontSize: "0.72rem",
				fontFamily: mono,
				color: "#4a4a56",
			}}>
				{value}
			</span>
		</div>
	)
}


function compactModelName(id: string): string {
	return id.includes("/") ? id.split("/").pop() ?? id : id
}

function formatScalar(value: string | number | boolean | undefined): string {
	if (value == null) return "not specified"
	return String(value)
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

function buildUseCaseCode(useCase: UseCase, modelId: string): string {

	const lines = [
		modelId === DEFAULT_MODEL
			? 'import { Brain, MemoryBrainStore } from "adapt-memory"'
			: 'import { Brain, MemoryBrainStore, localModel } from "adapt-memory"',
		"",
		"const brain = await Brain.create({",
		`  prompt: ${JSON.stringify(useCase.prompt)},`,
		`  autoSetup: ${JSON.stringify(useCase.autoSetup ?? true)},`,
		...(modelId === DEFAULT_MODEL ? [] : [`  model: localModel(${JSON.stringify(modelId)}),`]),
		"  store: new MemoryBrainStore(),",
		`  ingest: ${formatJson(useCase.ingest ?? {})},`,
		"  learning: {",
		...(useCase.learning ? indentLines(formatJson(useCase.learning), 4, true) : ["    // add thresholds or governance here"]),
		"  },",
		...(useCase.evolution
			? [
				"  evolution: {",
				`    enabled: ${JSON.stringify(useCase.evolution.enabled)},`,
				`    autoEvaluate: ${JSON.stringify(useCase.evolution.autoEvaluate)},`,
				`    evaluatorSignalThreshold: ${JSON.stringify(useCase.evolution.evaluatorSignalThreshold)},`,
				"  },",
			]
			: []),
		"})",
		"",
		`const dataPaths = ${formatJson(useCase.dataPaths)}`,
		"",
		"const dataSources = await Promise.all(",
		"  dataPaths.map(async (path) => {",
		"    const res = await fetch(path)",
		"    return res.json()",
		"  })",
		")",
		"",
		"for (const source of dataSources) {",
		"  // The brain learns from plain text.",
		"  const items = source.items.map((item) =>",
		"    [item.label, ...Object.entries(item.data).map(([k, v]) => `${k}: ${v}`)].join(\"\\n\")",
		"  )",
		"",
		"  await brain.inject(items)",
		"}",
	]

	return lines.join("\n")
}

function indentLines(json: string, spaces: number, stripBraces = false): string[] {
	const lines = json.split("\n")
	const innerLines = stripBraces ? lines.slice(1, -1) : lines
	return innerLines.map((line) => `${" ".repeat(spaces)}${line}`)
}
