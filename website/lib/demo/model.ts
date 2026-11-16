import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, type LanguageModel } from "ai"


export const DEMO_MODELS = [
	{ id: "liquid/lfm-3-1.7b", label: "LFM 3 (1.7B)" },
	{ id: "qwen/qwen3.5-9b", label: "Qwen 3.5 (9B)" },
] as const

export type DemoModelId = (typeof DEMO_MODELS)[number]["id"]
export const DEFAULT_MODEL: DemoModelId = DEMO_MODELS[0].id

const MODEL_STORAGE = "adapt-demo-model"

export function loadModelId(): DemoModelId {
	try {
		const id = localStorage.getItem(MODEL_STORAGE)
		return DEMO_MODELS.find((m) => m.id === id)?.id ?? DEFAULT_MODEL
	} catch {
		return DEFAULT_MODEL
	}
}

export function saveModelId(id: DemoModelId) {
	try {
		localStorage.setItem(MODEL_STORAGE, id)
	} catch {}
}

export function createDemoModel(modelId: string): LanguageModel {
	const provider = createOpenAICompatible({
		name: "demo",
		baseURL: `${window.location.origin}/api/llm-proxy`,
		supportsStructuredOutputs: true,
	})
	return provider(modelId)
}

/** Is the visitor asking a question, or telling the brain what to focus on? */
export async function classifyIntent(
	model: LanguageModel,
	query: string,
	neuronNames: string[],
): Promise<"ask" | "signal"> {
	try {
		const { text } = await generateText({
			model,
			temperature: 0,
			maxOutputTokens: 5,
			system:
				"A brain has these areas of focus: " +
				(neuronNames.join(", ") || "none") +
				". Is the user's message a QUESTION about what the brain knows, or an INSTRUCTION about what the brain should pay attention to? Answer with one word: ASK or SIGNAL.",
			prompt: query,
		})
		return text.trim().toUpperCase().startsWith("SIGNAL") ? "signal" : "ask"
	} catch {
		return "ask"
	}
}
