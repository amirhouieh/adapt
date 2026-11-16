/**
 * Use case configs — mirrors playground's BrainConfig type structure
 */

export interface UseCase {
	id: string
	title: string
	description: string
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
	appBatchSize?: number
	/** Estimated duration label, e.g. "~3 min" */
	duration?: string
	dataPaths: string[]
	/** Suggested queries shown in the search bar */
	suggestions?: {
		ask: string[]
		signal: string[]
	}
}

export const USE_CASES: UseCase[] = [
	{
		id: "daily-standups",
		title: "Daily Standups",
		description: "Watch a Brain learn from standup meeting transcripts — discovering team dynamics, projects, and patterns.",
		prompt: "You are learning from daily standup transcripts of a software team. You start knowing nothing — everything must be discovered from the data.\n\nPrioritize specialization over generalization. Create dedicated specialists for each distinct thing you discover — individual team members, projects, dynamics, cultural signals — rather than lumping things together. If two things could be separate specialists, they should be.\n\nLet understanding build incrementally. Follow the data.",
		autoSetup: true,
		ingest: { batchSize: 3 },
		appBatchSize: 10,
		duration: "~3 min",
		learning: {
			understand: {
				thresholds: {
					maxObservations: 5,
					minImportance: 0.1,
				},
			},
		},
		evolution: {
			enabled: true,
			autoEvaluate: true,
			evaluatorSignalThreshold: 5,
		},
		dataPaths: [
			"/demo/data/daily-standups/2026-02-25.json",
			"/demo/data/daily-standups/2026-03-04.json",
			"/demo/data/daily-standups/2026-03-10.json",
		],
		suggestions: {
			ask: [
				"What projects is the team working on?",
				"Who is responsible for what?",
				"What are the main blockers?",
			],
			signal: [
				"Pay more attention to team dynamics",
				"Focus on engineering principles discussed",
			],
		},
	},
	{
		id: "product-feedback",
		title: "Product Feedback",
		description: "Watch a Brain learn from multi-channel feedback — tweets, support tickets, and app reviews.",
		prompt: "You are learning from product feedback across multiple channels. You start knowing nothing — let the data guide you.",
		autoSetup: true,
		ingest: { batchSize: 3 },
		duration: "~1 min",
		learning: {
			understand: {
				thresholds: {
					maxObservations: 2,
					minImportance: 0.1,
				},
			},
		},
		evolution: {
			enabled: true,
			autoEvaluate: false,
			evaluatorSignalThreshold: 5,
		},
		dataPaths: [
			"/demo/data/product-feedback/tweets.json",
			"/demo/data/product-feedback/support-tickets.json",
			"/demo/data/product-feedback/app-reviews.json",
		],
		suggestions: {
			ask: [
				"What are users most frustrated about?",
				"What do enterprise customers need?",
			],
			signal: [
				"Prioritize tracking sentiment trends",
				"Start separating feature requests from bug reports",
			],
		},
	},
	{
		id: "space-exploration",
		title: "Space Exploration",
		description: "Watch a Brain learn from Wikipedia articles about space missions, astronauts, and agencies.",
		prompt: "You are learning from Wikipedia articles about space exploration. You start knowing nothing — everything must be discovered from the data.\n\nPrioritize specialization over generalization. Create dedicated specialists for each distinct thing you discover — missions, people, agencies, technologies, eras — rather than lumping things together. If two things could be separate specialists, they should be.\n\nLet understanding build incrementally. Follow the data.",
		autoSetup: true,
		ingest: { batchSize: 3 },
		duration: "~2 min",
		learning: {
			understand: {
				thresholds: {
					maxObservations: 4,
					minImportance: 0.1,
				},
			},
		},
		evolution: {
			enabled: true,
			autoEvaluate: true,
			evaluatorSignalThreshold: 5,
		},
		dataPaths: [
			"/demo/data/space-exploration/missions.json",
			"/demo/data/space-exploration/pioneers.json",
		],
		suggestions: {
			ask: [
				"Who was the first person on the Moon?",
				"What happened during Apollo 13?",
			],
			signal: [
				"Track connections between missions and people",
				"Focus on how technology evolved over decades",
			],
		},
	},
	{
		id: "coding-agents",
		title: "Coding Agents",
		description: "Watch a Brain learn how a developer collaborates with Claude Code and Codex across repos and sessions.",
		prompt: "You are watching and learning from my interactions with coding agents across different repos and sessions.\n\nNotice how I use each agent. Claude Code is usually where I think through concepts, architecture, specs, and tradeoffs. Codex is usually where I execute: editing code, running tests, debugging, and verifying the work.\n\nTrack the projects, agents, sessions, decisions, handoffs, and recurring patterns in how I work.",
		autoSetup: true,
		ingest: { batchSize: 3 },
		appBatchSize: 8,
		duration: "~2 min",
		learning: {
			understand: {
				thresholds: {
					maxObservations: 4,
					minImportance: 0.1,
				},
			},
		},
		evolution: {
			enabled: true,
			autoEvaluate: true,
			evaluatorSignalThreshold: 5,
		},
		dataPaths: [
			"/demo/data/coding-agents/claude-code-sessions.json",
			"/demo/data/coding-agents/codex-sessions.json",
			"/demo/data/coding-agents/handoffs.json",
		],
		suggestions: {
			ask: [
				"Which projects did I work on with each coding agent?",
				"Where did Claude Code define specs that Codex later implemented?",
				"What collaboration patterns are recurring across sessions?",
			],
			signal: [
				"Separate conceptual planning from implementation execution",
				"Track handoff quality between Claude Code and Codex",
			],
		},
	},
]
