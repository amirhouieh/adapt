---
title: Brain
description: Creating, configuring, and querying a Brain.
---

API guide for the `Brain` class. For the role Brain plays in the system, see [Concepts — Architecture](./concepts#architecture).

## Creating a Brain

Only two things are required — `prompt` (what to learn about) and `model` (which LLM to use):

```typescript
import { Brain } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

const brain = await Brain.create({
  prompt: 'Track user coding patterns and development philosophy.',
  model: openai('gpt-4o'),
})
```

With just these two fields, the Brain will auto-decompose the prompt into neurons, store everything in memory, and enable evolution — all with sensible defaults. When you need more control, you can configure persistence, learning thresholds, and evolution behavior:

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'

const brain = await Brain.create({
  prompt: 'Track user coding patterns and development philosophy.',
  model: openai('gpt-4o'),
  // Persist state to disk (default: in-memory, lost on exit).
  // Per-neuron data is derived from this store automatically
  // (e.g. ./brain.db → sibling files for each neuron).
  store: new SQLiteBrainStore('./brain.db'),
  // Evolution is on by default — shown here for clarity
  evolution: { enabled: true },
})
```

For Bun, import `SQLiteBrainStore` from `@unbody-io/adapt/sqlite/bun` instead of `@unbody-io/adapt/sqlite`.

See [Configuration](./configuration) for the full config reference.

## Fresh vs Restored

Brain has two construction verbs that map to two distinct intents:

```typescript
// Fresh — runs LLM decomposition, persists to the store.
// Throws if the store already contains a brain.
const brain = await Brain.create({ prompt, model, store })

// Restore — loads the previously persisted brain. Throws if the store is empty.
// Pass a runtime so persisted models can be rehydrated.
const brain = await Brain.restore('./brain.db', { model: openai('gpt-4o') })
const brain = await Brain.restore(myBrainStore, { model: openai('gpt-4o') })
```

> **Pass a runtime to `Brain.restore`:** persisted models are stored as `{provider, modelId}` refs and rehydrate through the LLM plugin you supply at restore time. Pick one form:
>
> - `model: openai('gpt-4o')` — covers the 90% case (single AI SDK provider).
> - per-slot overrides — `init: { model }`, `query: { model }`, `evolution: { model }`, `learning: { ... }` — when the brain was created with multi-slot model config.
> - `llm: customPlugin` — for BYO custom runtimes (Effect, in-house clients, etc.).
>
> Skipping the runtime is only safe for in-memory restores within the same process that already cached the live model from a prior `Brain.create` call. There is no Gateway-string fallback — calls will throw a clear "register a provider" error if no usable runtime is wired up.

`Brain.create` and `Brain.restore` are the only public entry points — the constructor is private. Both methods fully initialize the brain (no separate `init()` call required).

### BYO LLM runtime

The default plugin (`createAiSdkLLM`) wraps the AI SDK and is wired up automatically when you pass `model: openai(...)` (or any other AI SDK model). For runtimes outside the AI SDK — Effect, in-house clients, anything implementing the `AdaptLLMPlugin` contract — pass `llm` instead:

```typescript
import { Brain, createAiSdkLLM } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

// Custom AI SDK plugin with explicit provider registration (lets the
// plugin resolve persisted model refs back to live models on restore).
const llm = createAiSdkLLM({ providers: { openai } })

const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  llm,
})

const restored = await Brain.restore('./brain.db', { llm })
```

#### Plugin error contract

If you're implementing your own `AdaptLLMPlugin`, there's one rule that's easy to miss and breaks repair behavior when violated: **structured-output failures must be returned, not thrown.**

When the model produces output that doesn't fit the requested schema (malformed JSON, missing fields, raw text where an object was asked for), your plugin's `call` should return:

```typescript
{
  text: rawTextFromModel,
  json: undefined,
  finishReason: 'error',
  // ...usage, toolCalls, etc.
}
```

Adapt's core then runs its repair pipeline (markdown-fence stripping, syntactic recovery via `jsonrepair`, schema validation) on the `text` and produces a usable structured value. If you throw instead, repair never gets a chance and the call fails outright.

Throws are reserved for **system errors** — transport failures, auth errors, rate limits, provider 5xx, abort signals. Those propagate out of `generate()` / `streamText()` and the caller decides what to do.

The same rule applies to `streamCall`: structured-output recovery happens after the stream finalizes via the optional `output: Promise<TJson>` on `AdaptStreamResult` (populated by core, not the plugin). Throw only when the stream itself can't start.

The default `createAiSdkLLM` follows this contract: it catches the AI SDK's `NoObjectGeneratedError` internally and surfaces `error.text` as the result — no AI-SDK-specific error types leak into Adapt's core.

For stubborn structured-output failures, Adapt also supports an opt-in `repairWithFeedback` hook on `generate()` / `streamText()` calls and as a `Brain.create()` / restore runtime default. Core runs the normal repair pipeline first; the hook only runs if the repaired JSON still fails schema validation. In streaming, the extra feedback repair happens after the stream finalizes, through `AdaptStreamResult.output`.

## Injecting Data

```typescript
// Array or single item — plain text
await brain.inject([
  'note: Users prefer dark mode',
  'commit: refactor: move to composition API',
])

// With custom ID
await brain.inject(data, { id: 'session-42' })
```

Items are batched by `ingest.batchSize` (default: 20). Routing is parallel — every neuron sees every item. Batches dismissed by *all* neurons get tracked as coverage gaps for [evolution](./evolution).

### What neurons see

Neurons learn from plain text. `inject()` takes `string` items, or `TextInput` items when you own ids and times (`{ deliveryId, text, observedAt }`). Write the text so the model can reason about it:

```typescript
// Good — self-describing, rich context
await brain.inject([
  `bookmark (saved 2025-03-01): "Local-First Software" — https://example.com/local-first
highlights: CRDTs enable...; Offline-first is...
tags: architecture, sync`,
])

// Bad — opaque, no context to reason about
await brain.inject(['https://example.com/local-first'])
```

Each neuron extracts what is relevant to its `instructions`, then updates its memory with it. The update step sees the existing memory, so repeated facts merge instead of piling up.

**Timestamps matter.** If your use case involves temporal patterns, include timestamps in the text. The neuron can reason about time if its instructions ask for it.

## Querying

```typescript
const result = await brain.ask('What patterns do you see?')

result.insight    // Synthesized answer from all neurons
result.sources    // [{ neuronId, relevance, confidence, insight }]
result.gaps       // Knowledge gaps across all neurons
```

Two query modes:

- **`direct`** (default) — All neurons are queried in parallel (one LLM call each), then a single synthesis call combines their answers. Fast and predictable.
- **`deep`** — An LLM agent drives the query interactively. It decides which neurons to consult, what to ask each one, and whether to ask follow-up questions based on what it learns. It can also consult [internal neurons](#consulting-internal-neurons) (gap tracking, cross-domain patterns) to build a more complete answer. Slower, but better for complex questions that benefit from multi-step reasoning.

```typescript
// Default — fast, parallel
const result = await brain.ask('What patterns do you see?')

// Agentic — multi-step, selective
const deep = await brain.ask('What patterns do you see?', { mode: 'deep' })

// Override model per-call
const result = await brain.ask('...', { model: openai('gpt-4o') })
```

## Streaming

All query and evaluation methods have streaming variants that return an Adapt-shaped `AdaptStreamResult` — the same surface area regardless of which LLM plugin is active.

```typescript
// Stream a brain query
const stream = await brain.askStream('What patterns do you see?')

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk) // incremental text
}

// Or iterate all events (tool calls visible in deep mode)
const stream = await brain.askStream('What patterns?', { mode: 'deep' })

for await (const part of stream.fullStream) {
  if (part.type === 'text-delta') process.stdout.write(part.text)
  if (part.type === 'tool-call') console.log(`Tool: ${part.toolCall.toolName}`)
}

// Resolved promises available after stream completes
const text = await stream.text
const usage = await stream.usage
const toolCalls = await stream.toolCalls
```

## Consulting Internal Neurons

The four internal neurons (introduced in [Concepts — Evolution](./concepts#evolution)) are queryable via `brain.consult()`. The table below is the practical "when to consult which" reference.

| Internal Neuron | Type | What it tracks | When to consult it |
|---|---|---|---|
| Global Understanding | text | Cross-domain patterns from all neuron knowledge | "What themes connect my different domains?" |
| Global Query Understanding | text | Query topics, frequency, clusters | "What are users asking about most?" |
| Injection Gaps | text | Data no neuron could process | "What data am I not capturing?" |
| Query Gaps | text | Questions no neuron could answer well | "Where are my blind spots?" |

Query them via `consult()`:

```typescript
const meta = await brain.consult('What cross-domain patterns have emerged?')

// Target a specific internal neuron
const gaps = await brain.consult('What knowledge gaps exist?', {
  neuron: '__internal_injection_gaps',
})
```

All internal neurons are enabled by default. Toggle them:

```typescript
const brain = await Brain.create({
  // ...
  internalNeurons: {
    globalUnderstanding: true,                    // enabled (default)
    globalQueryUnderstanding: false,              // disabled
    injectionGaps: { governance: { maxTokens: 4000 } }, // enabled with overrides
    queryGaps: true,
  },
})
```

## Inspecting the Brain

`inspect()` is an agentic read-only method that answers questions about the brain's structure and knowledge. An LLM agent browses neuron metadata, reads understanding summaries, and consults internal neurons to build its answer.

```typescript
// What is the brain set up to track? (works even before any data is injected)
const result = await brain.inspect('What are you learning and tracking?')
console.log(result.insight)

// Deeper questions about accumulated knowledge
const health = await brain.inspect('Which neurons have the most gaps?')
```

Unlike `ask()` (which queries neuron knowledge) or `consult()` (which queries internal self-knowledge), `inspect()` can reason across both — and works on a fresh brain by falling back to neuron configs when no understanding exists yet.

## Managing Neurons

There are two ways to manage neurons: **basic management** (you provide explicit configs) and **evolution management** (the LLM designs neurons from natural language guidance). Basic management is always available. Evolution management requires `evolution.enabled` (on by default).

**Basic management** — you specify exactly what to create or change:

```typescript
// Add with explicit config
const neuron = await brain.addNeuron({
  id: 'ui-patterns',
  type: 'text',
  name: 'UI Patterns',
  description: 'Tracks UI/UX design patterns',
  instructions: 'Track user interface patterns, component choices, and design decisions.',
})

// Adjust with natural language — incremental, preserves knowledge
await brain.adjustNeuron('ui-patterns', 'Focus more on accessibility patterns')

// Remove
await brain.removeNeuron('ui-patterns')

// Inspect
brain.getNeurons()              // all external neurons
brain.getNeuron('ui-patterns')  // specific neuron
```

**Evolution management** — the LLM designs neurons from natural language guidance. Use this when you know *what* you want but want the system to figure out the specifics (name, instructions, type, schema):

```typescript
// LLM designs the neuron from guidance
const neuron = await brain.createNeuron('Track emerging frontend frameworks')

// Merge overlapping neurons
const merged = await brain.mergeNeurons(
  ['react-neuron', 'vue-neuron'],
  'Combine into unified frontend framework tracker'
)

// Split overloaded neuron
const parts = await brain.splitNeuron(
  'broad-neuron',
  'Separate into technical patterns vs team dynamics'
)

// LLM-driven update
await brain.updateNeuron('neuron-x', 'Narrow scope to React hooks only')

// Delete via evolution
await brain.deleteNeuron('neuron-y')
```

## Pausing Neurons

Pause a neuron to stop including it in `inject()` fan-out without losing its accumulated knowledge. Paused neurons stay queryable via `ask()` and `consult()` — pause is about ingestion, not visibility.

```typescript
await brain.pauseNeuron('ui-patterns')
brain.getNeuronStatus('ui-patterns') // 'inactive'

await brain.resumeNeuron('ui-patterns')
brain.getNeuronStatus('ui-patterns') // 'active'
```

Status survives restarts via the brain store. Every transition emits a `brain:neuron:status:changed` event with `previousStatus` and `newStatus`.

## Update vs Adjust

These are different operations:

**`brain.adjustNeuron(id, directive)`** — Natural language steering. The directive is added verbatim as a rule for the neuron's extract and update stages. No LLM call; the existing memory is kept. Think "steering."

```typescript
await brain.adjustNeuron('topics', 'Be stricter about what counts as a distinct topic')
await brain.adjustNeuron('patterns', 'Also track testing patterns going forward')
```

**`brain.update(config)`** — Config replacement. Changes to mechanical fields (like models, thresholds, governance) take effect immediately across all neurons. Changes to semantic fields (like `prompt`) trigger an evolution evaluation, because changing the Brain's purpose may require restructuring its neurons.

```typescript
// Mechanical: cascades immediately to all neurons
await brain.update({
  learning: { governance: { strategy: 'decay' } },
})

// Semantic: triggers evolution evaluation
await brain.update({ prompt: 'Track design systems instead of coding patterns.' })
```

**Standalone neuron equivalents:**

```typescript
// adjust() — adds a rule, no LLM call
await neuron.adjust('Also track performance metrics')

// update() — replace config fields
await neuron.update({
  instructions: 'Track only React performance patterns.',
  governance: { strategy: 'cumulative', maxTokens: 6000 },
})
```
