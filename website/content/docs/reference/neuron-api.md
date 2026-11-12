---
title: Neuron API Reference
description: API for TextNeuron.
---

API for `TextNeuron` (extends `BaseNeuron`).

## Lifecycle

| Method | Returns | Description |
|---|---|---|
| `TextNeuron.create(config, parentModels?)` | `Promise<TextNeuron>` | Construct a fresh TextNeuron and persist its config. Throws if the store already contains a neuron. |
| `TextNeuron.restore(pathOrStore, runtime?)` | `Promise<TextNeuron>` | Restore a previously persisted TextNeuron. Path-string sugar uses Node SQLite via dynamic import. Throws if the store is empty. |
| `dispose()` | `Promise<void>` | Close the neuron's own store. |
| `isInitialized()` | `boolean` | True once `init` has completed. |

Constructors are private — the static `create` / `restore` methods are the only public entry points. Both fully initialize the neuron; there is no separate `init()` step on the public surface. Neither makes an LLM call: `create` persists the config, `restore` reads it back from the store.

**`restore()` runtime options:**

```typescript
{
  id?: string                  // Pin the neuron id (useful when the store holds multiple)
  model?: LanguageModel        // Live AI SDK model — covers the common case
  llm?: AdaptLLMPlugin         // Custom plugin — for BYO runtimes
  onEvent?: UnifiedHandler     // Subscribed before restore init runs — catches neuron:init:* events
}
```

All fields are optional. See [Brain — Fresh vs Restored](../brain#fresh-vs-restored) for the canonical write-up — the same semantics apply to neuron `restore`.

## Learning

| Method | Returns | Description |
|---|---|---|
| `learn(batch)` | `Promise<LearnOutput>` | Two stages: extract what is relevant, then update the memory. Plain text. |

`batch` is `readonly LearnInput[]`, where `LearnInput = string | TextInput` (`{ deliveryId, text, observedAt, eventId?, urgency? }`). `observedAt` must be in the exact form `Date.toISOString()` gives.

### LearnOutput

Discriminated union — check `status` to determine the outcome:

| Status | Fields | Meaning |
|---|---|---|
| `synthesized` | `newUnderstanding, significance, evolution` | Memory changed (`significance` is always `'routine'` today) |
| `observe:dismissed` | `output[], gaps[]` | Extract found nothing relevant |
| `synthesize:dismissed` | `output` | Relevant, but the memory did not change |

## Querying

| Method | Returns | Description |
|---|---|---|
| `query(question, options?)` | `Promise<QueryResult>` | Query neuron knowledge |
| `queryStream(question, options?)` | `Promise<AdaptStreamResult>` | Streaming variant |

### QueryResult

```typescript
{
  relevant: boolean
  relevance: number      // 0–1
  confidence: number     // 0–1
  insight: string
  gaps: string
  usage: TokenUsage
}
```

## Memory

| Method | Returns | Description |
|---|---|---|
| `getUnderstanding()` | `Promise<string>` | Current memory (`''` before anything is learned) |
| `setUnderstanding(text)` | `Promise<void>` | Set a starting memory. Only on an empty neuron; after that, only learning changes it. |
| `getSummary()` | `Promise<string>` | Prose summary |
| `hasKnowledge()` | `Promise<boolean>` | Has any memory |

## Memory strategy

| Method | Returns | Description |
|---|---|---|
| `getGovernance()` | `{ strategy, maxTokens }` | Current strategy. Change it with `update({ governance })`. |

See [Neurons — Memory strategies](../neurons#memory-strategies).

## Introspection

| Method | Returns | Description |
|---|---|---|
| `getHealth()` | `NeuronHealth` | Activation, status, signal thresholds |
| `getMetrics()` | `NeuronMetrics` | `{ ingestion: { dismissalRate, ... }, query: { relevanceScores, confidenceScores, gaps } }` |
| `getMetadata()` | `NeuronMetadata` | Combined metadata |
| `getEvolution()` | `Promise<EvolutionRecord[]>` | Change history |
| `getUnderstandThresholds()` | `{ maxObservations?, maxTokens?, minImportance? }` | Thresholds Brain reads for health signals and evolution |

## Config

| Method | Returns | Description |
|---|---|---|
| `update(updates)` | `Promise<{ changedFields }>` | Replace config fields (`instructions`, `governance`, ...) |
| `adjust(directive)` | `Promise<AdjustResult>` | Incremental LLM-driven adjustment |

### AdjustResult

```typescript
{
  changedFields: string[]
  adjustedConfig: boolean
  adjustedUnderstanding: boolean
}
```

## Identity

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Neuron ID |
| `type` | `string` | `'text'` |
| `name` | `string` | Display name |
| `description` | `string` | What this neuron tracks |
| `instructions` | `string` | What the neuron tracks. Used verbatim in both stages. |
| `origin` | `NeuronOrigin` | `'prompt'`, `'developer'`, or `'emergent'` |

## Config Fields

Accepted by `TextNeuron.create()` (and by Brain explicit-neuron configs). Required: `model`, `instructions`, `store`.

| Field | Type | Description |
|---|---|---|
| `model` | `LanguageModel` | Default model for learning and queries. |
| `instructions` | `string` | What the neuron tracks. Used verbatim in the extract and update prompts. |
| `governance` | `{ strategy?, maxTokens? }` | Optional. Memory strategy: `cumulative` (default, 8000 tokens), `decay`, or `continuous`. |
| `query` | `{ model? }` | Optional. Model override for queries. |
| `onEvent` | `UnifiedHandler<NeuronEvent>` | Optional. Subscribed via `.on(...)` before `init()` runs, so `neuron:init:*` events are observable. Also accepted in `restore()` runtime options. |
