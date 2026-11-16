export interface NeuronMetrics {
	observations: number
	dismissals: number
	syntheses: number
	queries: number
	lastSynthesisSignificance: string | null
	lastSynthesisEvolution: string | null
}

export interface NeuronHealth {
	activation: number
	status: string
}

export interface Neuron {
	id: string
	name: string
	description: string
	understandingSize: number
	activity: "idle" | "observing" | "thinking" | "synthesizing" | "querying"
	metrics: NeuronMetrics
	health: NeuronHealth
}

export interface BrainEvent {
	id: string
	type: string
	payload: Record<string, unknown>
	timestamp: string
}

export interface InjectionProgress {
	sourceIndex: number
	sourceCount: number
	sourceLabel: string
	sourceSummary: string
	itemCount: number
	batchIndex: number
	batchCount: number
}

export interface DataSource {
	id: string
	source: string
	label: string
	description: string
	summary?: string
	items: DataItem[]
}

export interface DataItem {
	id: string
	label: string
	data: Record<string, unknown>
}
