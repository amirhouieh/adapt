---
title: Brain API Reference
description: Complete Brain class API — lifecycle, data, neuron management, evolution, and result types.
---

Complete API reference for the `Brain` class, covering lifecycle management, data operations, neuron management, evolution controls, and all associated result types.

## Lifecycle

| Method | Returns | Description |
|---|---|---|
| `Brain.create(config)` | `Promise<Brain>` | Construct a fresh brain. Throws if the store already contains a brain. |
| `Brain.restore(pathOrStore, runtime?)` | `Promise<Brain>` | Restore an existing brain. Path-string sugar uses Node SQLite via dynamic import; Bun callers pass an explicit `BrainStore`. `runtime` carries the LLM context the brain needs after restore. Throws if the store is empty. |
| `dispose()` | `Promise<void>` | Walk neuron stores and close the brain store. |

Constructors are private — `Brain.create` and `Brain.restore` are the only public entry points. Both fully initialize the brain; there is no separate `init()` step.

**`Brain.restore()` runtime options:**

```typescript
interface BrainRuntimeOptions {
  model?: LanguageModel                  // Live AI SDK model — covers the 90% case
  blueprintModel?: LanguageModel
  init?: { model?: LanguageModel }
  query?: { model?: LanguageModel }
  evolution?: { model?: LanguageModel }
  learning?: LearningConfig
  llm?: AdaptLLMPlugin                   // Custom plugin — for BYO runtimes
  onEvent?: UnifiedHandler<BrainEvent>   // Subscribed before restore init runs
}
```

All fields are optional. See [Brain — Fresh vs Restored](../brain#fresh-vs-restored) for the canonical write-up of when to use each form.

### Pre-init event subscription (`onEvent`)

`BrainConfig.onEvent` (for `Brain.create`) and `BrainRuntimeOptions.onEvent` (for `Brain.restore`) register an event handler via `.on(...)` **before** initialization runs. Without it, the first events you can observe are post-init — `brain:init:*` events fire during `Brain.create` / `Brain.restore` and would be missed by a handler attached afterward. Pass `onEvent` to capture the full init sequence:

```typescript
const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  onEvent: (event) => console.log(`[${event.type}]`),  // sees brain:init:started, neuron:init:*, ...
})
```

## Data

| Method | Returns | Description |
|---|---|---|
| `inject(data, options?)` | `Promise<BrainInjectResult>` | Route data to all neurons |
| `ask(query, options?)` | `Promise<BrainAskResult>` | Query all neurons, synthesize response |
| `askStream(query, options?)` | `Promise<AdaptStreamResult>` | Streaming variant of `ask()` |
| `consult(query, options?)` | `Promise<ConsultResult>` | Query internal neurons |
| `inspect(query, options?)` | `Promise<InspectResult>` | Agentic read-only introspection |

**`ask()` options:** `{ model?: LanguageModel, mode?: 'direct' | 'deep' }` + AI SDK `CallSettings`

**`consult()` options:** `{ neuron?: string }` — target a specific internal neuron by ID

## Neuron Management

| Method | Returns | Description |
|---|---|---|
| `addNeuron(config)` | `Promise<Neuron>` | Add neuron with explicit config |
| `removeNeuron(id)` | `Promise<void>` | Remove neuron and dispose store |
| `adjustNeuron(id, directive)` | `Promise<{ neuron, result }>` | Natural language steering (preserves knowledge) |
| `getNeuron(id)` | `Neuron \| undefined` | Get neuron by ID |
| `getNeurons()` | `Neuron[]` | Get all external neurons |
| `getInternalNeuron(id)` | `Neuron \| undefined` | Get internal neuron by ID |
| `pauseNeuron(id)` | `Promise<void>` | Set neuron status to `'inactive'`. Inject fan-out skips paused neurons; query path is unaffected. |
| `resumeNeuron(id)` | `Promise<void>` | Set neuron status to `'active'`. |
| `getNeuronStatus(id)` | `NeuronStatus \| undefined` | Returns `'active'` / `'inactive'`, or `undefined` if neuron not found. Defaults to `'active'` for records that predate the status field. |

## Evolution

| Method | Returns | Description |
|---|---|---|
| `evolve()` | `Promise<EvolutionResult>` | Run evolution now. Requires `evolution.enabled` (default: `true`). Runs are queued, never parallel. |
| `updateNeuron(id, { name?, description?, instructions? })` | `Promise<Neuron>` | Change what a neuron tracks; memory is kept |
| `mergeNeurons(ids, config)` | `Promise<Neuron>` | Replace 2+ neurons with one; memories are joined |

`EvolutionResult` is `{ changes: EvolutionChange[]; reasoning: string }`. A change is `{ action: 'create' | 'update' | 'remove', neuronId }` or `{ action: 'merge', neuronId, mergedIds }`.

## Signals & Config

| Method | Returns | Description |
|---|---|---|
| `signal({ source, description })` | `void` | Add a signal for evolution |
| `update(updates)` | `Promise<BrainUpdateResult>` | Update brain config |
| `on(type, handler)` | `this` | Subscribe to specific event |
| `on(handler)` | `this` | Subscribe to all events |

## Accessors

| Property | Type | Description |
|---|---|---|
| `prompt` | `string` | Brain's purpose prompt |
| `promptContext` | `object \| undefined` | Decomposed prompt context |
| `config` | `ResolvedBrainConfig` | Current resolved config (computed view) |
| `neurons` | `Map<string, Neuron>` | Map of external neurons |
| `internalNeurons` | `Map<string, Neuron>` | Map of internal neurons |
| `store` | `BrainStore` | Persistence layer |

## Result Types

### BrainAskResult

```typescript
{
  insight: string                          // Synthesized answer
  sources: Array<{
    neuronId: string
    relevance: number
    confidence: number
    insight: string
  }>
  gaps: string[]                           // Aggregated knowledge gaps
}
```

### BrainInjectResult

```typescript
{
  id: string                               // Inject ID
  batches: Array<{
    id: string
    index: number
    results: Array<{
      neuronId: string
      result: LearnOutput                  // See neuron-api.md
    }>
  }>
}
```

### BrainUpdateResult

```typescript
{
  changedFields: string[]
  config: ResolvedBrainConfig
  neuronResults: Array<{
    neuronId: string
    changedFields: string[]
  }>
  evolution?: EvolutionResult              // Present when semantic changes ran evolution
}
```
