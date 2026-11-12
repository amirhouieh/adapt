---
title: Configuration
description: Full BrainConfig reference, model cascade, providers, and memory strategies.
---

Reference for `BrainConfig` and the model cascade. For per-operation LLM call counts, see [Cost & Performance](./cost).

## BrainConfig

```typescript
interface BrainConfig {
  prompt: string                            // What to track and learn
  model: LanguageModel                      // Default model for all operations
  blueprintModel?: LanguageModel            // Neuron config generation (falls back to model)
  llm?: AdaptLLMPlugin                      // BYO LLM runtime (default: AI SDK plugin)
  autoSetup?: boolean                       // LLM decomposition on init (default: true)
  neurons?: GeneratedNeuronConfig[]         // Explicit neuron definitions
  store?: BrainStore                        // Brain persistence (default: MemoryBrainStore)
  onEvent?: UnifiedHandler<BrainEvent>      // Pre-init event subscription (catches init events)

  init?: { model?: LanguageModel }          // Decomposition model
  query?: { model?: LanguageModel }         // ask() synthesis model
  ingest?: { batchSize?: number }           // Items per batch (default: 20)

  learning?: {
    // Per-neuron stores are derived from `store` automatically via
    // BrainStore.getNeuronStore(neuronId). No factory required.
    model?: LanguageModel                   // Learning model (extract + update + strategy)
    blueprintModel?: LanguageModel          // Neuron config generation model
    query?: { model?: LanguageModel }       // Per-neuron query model
    governance?: {
      strategy?: 'continuous' | 'cumulative' | 'decay'  // default: 'cumulative'
      maxTokens?: number                    // default: 8000
    }
    understand?: {
      thresholds?: {                        // Read by Brain for health signals and evolution
        maxObservations?: number            // default: 10
        maxTokens?: number                  // default: 8000
        minImportance?: number              // default: 0.5
      }
    }
  }

  evolution?: {
    enabled?: boolean                       // default: true
    model?: LanguageModel                   // Evolution evaluation model
    evaluatorSignalThreshold?: number       // Signals before auto-eval (default: 5)
    autoEvaluate?: boolean                  // Auto-trigger on threshold (default: true)
    coverageGap?: {
      relevanceThreshold?: number           // Below this = "not relevant" (default: 0.3)
      gapCountThreshold?: number            // Gaps before signaling (default: 5)
      windowSize?: number                   // Rolling window (default: 20)
    }
  }

  internalNeurons?: {
    globalUnderstanding?: boolean | Partial<LearningConfig>
    globalQueryUnderstanding?: boolean | Partial<LearningConfig>
    injectionGaps?: boolean | Partial<LearningConfig>
    queryGaps?: boolean | Partial<LearningConfig>
  }

  dismissedBatchBuffer?: {
    maxSize?: number                        // default: 100
  }
}
```

## Model Cascade

Different operations have different cost/quality trade-offs. Learning runs on every inject and scales linearly with neurons. Decomposition, evolution and `ask()` synthesis run less often. The model cascade lets you assign different models to different operations, with each level falling back to its parent if not explicitly set:

```text
brain.model (default for everything)
├── brain.blueprintModel (neuron config generation, falls back to model)
├── brain.init.model (decomposition, falls back to blueprintModel)
├── brain.query.model (ask synthesis, falls back to model)
├── brain.evolution.model (evolution evaluation, falls back to model)
└── learning.* (applied to all neurons):
    ├── learning.model → extract + update (and memory strategy)
    ├── learning.blueprintModel → neuron config generation
    └── learning.query.model → per-neuron query
```

**Cost-optimized setup** — fast model for high-volume learning, smart model for structure and answers:

```typescript
import { openai } from '@ai-sdk/openai'

const fast = openai('gpt-4o-mini')
const smart = openai('gpt-4o')

const brain = await Brain.create({
  prompt: '...',
  model: fast,                      // Default: cheap model
  blueprintModel: smart,            // Neuron config generation: smart model
  init: { model: smart },           // Decomposition: smart model
  query: { model: smart },          // ask() synthesis: smart model
})

// Per-neuron settings go through update():
await brain.update({
  learning: {
    model: fast,                    // Extract + update: cheap model (high volume)
    query: { model: smart },        // Per-neuron query: smart model
  },
})
```

> **Note:** today `learning.model`, `learning.query` and `learning.governance` reach neurons through `brain.update({ learning })`. At `Brain.create`, neurons use `model` and the default memory strategy.

For a per-operation breakdown of how many LLM calls each method makes — and where to spend a smarter model vs a cheaper one — see [Cost & Performance](./cost).

## Using Different Providers

```typescript
import { openai } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

// Direct providers
await Brain.create({ model: openai('gpt-4o'), ... })
await Brain.create({ model: anthropic('claude-sonnet-4-20250514'), ... })
await Brain.create({ model: google('gemini-2.0-flash'), ... })

// OpenRouter (multi-provider gateway)
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
await Brain.create({ model: openrouter('google/gemini-2.0-flash-001'), ... })
```

Any `LanguageModel` from any `@ai-sdk/*` provider works. See [Vercel AI SDK providers](https://sdk.vercel.ai/providers) for the full list.

### Custom LLM Runtimes

If you need a runtime outside the AI SDK — Effect, an in-house client, or anything implementing the `AdaptLLMPlugin` contract — pass `llm` in `BrainConfig` (or to `Brain.restore` / `TextNeuron.create`):

```typescript
import { Brain, createAiSdkLLM } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

// Pre-register providers so the plugin can rehydrate persisted model refs.
const llm = createAiSdkLLM({ providers: { openai } })

const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  llm,
})
```

The default plugin (`createAiSdkLLM`) is wired up automatically when you pass any AI SDK model in `model` — you only need to set `llm` explicitly if you want a non-default plugin or to opt into AI Gateway via `createAiSdkLLM({ gateway: true })`. See [Brain — BYO LLM runtime](./brain#byo-llm-runtime).

## Model Requirements

Adapt requires models that support **structured output** and **tool calling**. Not all operations need both — here's the breakdown:

| Operation | Structured Output | Tool Calling |
|---|---|---|
| Learning (extract + update) | No (plain text) | No |
| Direct query (`ask`) | Yes | No |
| Agentic query (`ask` deep mode) | No | **Yes** (cognitive tools + done tool) |
| Brain synthesis (direct) | Yes | No |
| Brain synthesis (deep) | No | **Yes** (specialist query tools) |
| Evaluator | No | **Yes** (inspect, query, review tools) |
| Brain inspect | No | **Yes** (introspection tools) |
| Evolution handlers | Yes | No |
| Memory strategy compression | No | No (plain text) |

If your model doesn't support tool calling, **TextNeuron in direct mode** still works end-to-end. Deep mode, evolution, and inspect require tool-calling models.

> **Practical tip:** Use a tool-calling model (GPT-4o, Claude Sonnet, Gemini Flash) as the default `model`. If you want a cheaper/local model for learning, set it on `learning.model` only — learning is plain text and needs neither structured output nor tool calling.

## Memory Strategies

`learning.governance` (via `brain.update({ learning })`) sets the memory strategy for Brain's neurons. Neurons Brain creates start with `cumulative`, 8000 tokens. The strategy runs after each update, before the memory is saved:

- **`continuous`** — Memory grows. No compression. Use for low-volume topics where you want full detail.

- **`cumulative`** (Brain default) — Over `maxTokens`, one model call summarizes the memory into a seed. The seed starts the next cycle.

- **`decay`** — At 80% of `maxTokens`, one model call compresses older parts (Current State / Recent Developments / Historical Context) and keeps recent detail.

`maxTokens` defaults to 8000 for Brain neurons. Tokens are estimated as characters / 4, and `maxTokens` is capped by the learning setup's memory size (8192 tokens by default).

| Use case | Strategy | Why |
|---|---|---|
| High-volume stream (logs, events) | `decay` | Keep recent detail, compress history |
| Low-volume, high-value (design decisions) | `continuous` | Keep everything |
| Long-running tracker (feature requests) | `cumulative` | Periodic consolidation, bounded size |
| Session-scoped (single conversation) | `continuous` | Session ends soon, no need to compress |

## Health Thresholds

`learning.understand.thresholds` (`maxObservations`, `maxTokens`, `minImportance`) no longer control learning — a neuron learns on every batch. Brain still reads them for neuron health signals and the evolution prompt.
