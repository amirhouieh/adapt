"use client"

import { DEMO_MODELS, type DemoModelId } from "../../lib/demo/model"

const mono = '"SF Mono", "Fira Code", "Cascadia Code", monospace'

interface Props {
	modelId: DemoModelId
	onModelChange: (id: DemoModelId) => void
}

export function DemoSettings({ modelId, onModelChange }: Props) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", fontFamily: mono, fontSize: "0.72rem", color: "#6b6b78" }}>
			<div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
				<label htmlFor="demo-model">Model</label>
				<select
					id="demo-model"
					value={modelId}
					onChange={(e) => onModelChange(e.target.value as DemoModelId)}
					style={{ border: "1px solid #e0e0e3", borderRadius: 8, padding: "0.3rem 0.5rem", background: "#fff", fontFamily: mono, fontSize: "0.72rem" }}
				>
					{DEMO_MODELS.map((m) => (
						<option key={m.id} value={m.id}>{m.label}</option>
					))}
				</select>
			</div>
		</div>
	)
}
