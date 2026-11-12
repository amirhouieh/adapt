---
title: Events & Lifecycle
description: Subscribing to brain events, the order they fire in, timing expectations, and the full event reference.
---

Brain emits events at every pipeline stage. Use them for real-time UIs, debugging, side effects, or forwarding to external systems. Neuron events are forwarded through Brain — subscribe on Brain.

## Subscribing

```typescript
// Specific event (typed)
brain.on('neuron:synthesized', (payload) => {
  console.log(`${payload.neuronId}: ${payload.evolution}`)
})

// All events
brain.on((event) => {
  console.log(`[${event.type}] ${event.id} at ${event.timestamp}`)
})
```

### Forwarding to a UI

```typescript
// Forward all brain events to an Electron renderer
brain.on((event) => {
  window.webContents.send('brain:event', {
    type: event.type,
    ...event.payload,
  })
})
```

See [Recipes — SSE Event Broadcasting](./recipes#sse-event-broadcasting) for a server-sent events example.

### Catching init events

`brain.on(...)` can only see events fired *after* it runs. But `brain:init:*` and `neuron:init:*` events fire *during* `Brain.create()` / `Brain.restore()` — before you hold a `brain` reference to subscribe on. To observe the init sequence, pass an `onEvent` handler in the config (or restore runtime options). It is attached via `.on(...)` before initialization starts:

```typescript
const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  onEvent: (event) => console.log(`[${event.type}]`),  // sees brain:init:started onward
})
```

`onEvent` is also accepted by `Brain.restore()` runtime options, and by `TextNeuron.create` configs and `restore` options for standalone-neuron `neuron:init:*` events.

## Lifecycle

A Brain's lifecycle has two phases:

```text
BIRTH                          LEARN (repeats per inject)
─────                          ─────
 Config generation              Extract (parallel)
 Neuron setup (sequential)      Update
 Internal neuron setup          Internal cascade
 Ready                          Evolve (optional)
```

Birth happens once. Learning repeats every time you call `inject()`.

> Internal event names use the `brain:init:*` / `neuron:init:*` prefixes. The public callsite is `Brain.create(config)` for fresh-init and `Brain.restore(pathOrStore, runtime?)` for restore — there is no separate `brain.init()` step.

### Birth

`Brain.create()` runs three stages (skipped on `Brain.restore()`, which loads from the store with no LLM calls):

**1. Config generation** — the Brain decomposes your prompt into neuron configurations. Skipped if you provide explicit `neurons`.

```text
brain:init:started
brain:init:config:generating
brain:init:config:generated          → N neuron configs
```

**2. Neuron setup** — each neuron is initialized **sequentially**. No LLM call: the neuron saves its config and its two-stage learning setup.

```text
neuron:init:started                  → neuron 1
neuron:init:completed
brain:neuron:added                   → neuron 1 visible

neuron:init:started                  → neuron 2
neuron:init:completed
brain:neuron:added                   → neuron 2 visible
```

`brain:neuron:added` fires when a neuron becomes visible to the outside world.

**3. Internal neuron setup** — Brain initializes its four [internal neurons](./brain#consulting-internal-neurons). Sequentially, but no `brain:neuron:added` (they're internal).

```text
neuron:init:started / completed   ×4
brain:init:completed                 → Brain is ready
```

### Learning

Each `brain.inject()` call processes data through extract → update. Injections are split into batches.

```text
brain:inject:started
 └─ Batch 1 ─────────────────────────────────────
     (each neuron, in parallel, one of:)
     neuron:observe:dismissed           ← extract found nothing relevant
     neuron:synthesize:dismissed        ← relevant, memory unchanged
     neuron:synthesized                 ← memory updated
     neuron:health:updated              ← always follows synthesized
     brain:inject:batch:completed

 └─ Batch 2 (internal cascade) ──────────────────
     neuron:synthesized                 ← internal neurons
     neuron:health:updated
     neuron:query:started               ← internal global query
     brain:inject:batch:completed

brain:inject:completed
```

Key invariants:

- **Neurons learn in parallel.** All neurons in a batch start at the same time; each runs extract, then update.
- **One outcome event per neuron per batch:** `neuron:observe:dismissed`, `neuron:synthesize:dismissed`, or `neuron:synthesized`. The event names are kept from the earlier engine.
- **`neuron:health:updated` always follows `neuron:synthesized`.** Reliable pair.
- **Internal neurons run in a second batch.** They learn from the user-facing neurons' updated memory. This is why you see two batches per injection.

### Async cascade

Internal neurons issue queries that complete asynchronously — often during the *next* injection rather than the current one:

```text
Injection 1:
  neuron:synthesized
  neuron:query:started               ← internal query begins
  brain:inject:completed             ← injection finishes, query still running

Injection 2:
  brain:inject:started
  neuron:synthesized
  neuron:query:completed             ← previous query finishes mid-injection
  ...
```

This overlap is normal. Internal queries don't block injections.

### Evolution signals

When neurons detect structural problems (high dismissal, coverage gaps, low relevance), signals fire:

```text
neuron:synthesized
brain:signal:received                ← evolution signal
neuron:health:updated
```

Signals accumulate. When enough build up (default threshold: 5), the evaluator triggers automatically and may restructure the brain. See [Evolution](./evolution).

## Timing expectations

Rough ranges based on typical LLM latency. Actual times vary by model, provider, and data volume.

| Phase | Typical duration |
|---|---|
| Config generation | 2–4s |
| Per neuron init | 3–10s |
| Full birth (2–3 neurons) | 30–60s |
| Extract (per neuron, per batch) | 2–4s |
| Update (per neuron, per batch) | 2–10s |
| Internal query | 3–6s |
| Single injection | 8–30s |

The largest variance comes from the update step — rewriting a large memory takes longer than a small one. Injections that trigger evolution take longer still.

## Event Reference

Events are grouped by phase. The most-used ones are `neuron:synthesized` (a neuron updated its knowledge), `brain:ask:completed` (a query finished), and `evaluator:evaluation:completed` (the evolution system made decisions).

### Brain Events

| Phase | Events | Key payload fields |
|---|---|---|
| **Init** | `brain:init:started`, `brain:init:config:generating`, `brain:init:config:generated`, `brain:init:completed`, `brain:init:failed` | `configs[]`, `neuronIds[]`, `usage` |
| **Inject** | `brain:inject:started`, `brain:inject:batch:started`, `brain:inject:batch:completed`, `brain:inject:completed`, `brain:inject:failed` | `injectId`, `itemCount`, `batchCount`, `results[]` |
| **Ask** | `brain:ask:started`, `brain:ask:synthesis:started`, `brain:ask:completed`, `brain:ask:failed` | `queryId`, `query`, `insight`, `sources[]`, `gaps[]`, `usage` |
| **Neuron Mgmt** | `brain:neuron:added`, `brain:neuron:removed`, `brain:neuron:status:changed` | `neuronId`, `name`, `instructions`, `previousStatus`, `newStatus` |
| **Signals** | `brain:signal:received` | `source`, `description`, `timestamp` |
| **Evaluator** | `evaluator:evaluation:started`, `evaluator:evaluation:completed`, `evaluator:evaluation:failed` | `signalCount`, `decisions[]`, `reasoning` |
| **Evolution** | `evolution:action:started`, `evolution:action:executed`, `evolution:action:failed` | `action`, `targets[]`, `reasoning`, `result` |
| **Config** | `brain:config:updated` | `updates`, `changedFields[]` |

### Neuron Events

| Phase | Events | Key payload fields |
|---|---|---|
| **Init** | `neuron:init:started`, `neuron:init:completed`, `neuron:init:failed` | `neuronId`, `systemPrompt`, `usage` |
| **Learn** | `neuron:observe:dismissed` (extract found nothing), `neuron:synthesize:dismissed` (memory unchanged), `neuron:synthesized` (memory updated) | `neuronId`, `newUnderstanding`, `previousUnderstanding`, `evolution` |
| **Query** | `neuron:query:started`, `neuron:query:completed`, `neuron:query:failed`, `neuron:query:thinking` | `neuronId`, `insight`, `relevance`, `confidence`, `gaps[]` |
| **Health** | `neuron:health:updated` | `neuronId`, `activation`, `status`, `previousStatus` |
| **Signals** | `neuron:signal` | `neuronId`, `description`, `metrics` |
| **Config** | `neuron:config:updated`, `neuron:understanding:set` | `neuronId`, `changedFields[]`, `understanding` |

### Thinking events

`neuron:query:thinking` fires when the LLM produces intermediate reasoning. Payload: `thoughts: string[]` and `usage: TokenUsage`. Useful for debugging (seeing *why* a neuron made a decision) and real-time UI feedback (streaming the thought process to users).
