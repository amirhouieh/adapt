---
title: Cost & Performance
description: LLM call counts per operation, model-slot routing, and tuning for production workloads.
---

Adapt's cost is dominated by LLM calls. This page gives you the exact call count per operation so you can estimate spend and latency, and points to the levers that move the most.

## Quick Reference

Typical cost for common workflows:

| Scenario | Neurons | Calls per `inject` | Calls per `ask` |
|---|---|---|---|
| Simple (3 neurons, 1 finds the data relevant) | 3 | 4 | 5 |
| Medium (5 neurons, 2 find it relevant) | 5 | 7 | 7 |
| Large (10 neurons, 3 find it relevant) | 10 | 13 | 12 |
| Deep mode ask (5 neurons) | 5 | — | 2–12 |

> **Cost tip:** Learning runs on every inject and scales linearly with neurons. This is where a fast/cheap model pays off the most. Learning is plain text, so small local models work. See [Configuration — Model Cascade](./configuration#model-cascade) for the cost-optimized cascade setup.

## Detailed Call Counts

N = number of neurons, B = number of batches.

### Core Operations

| Operation | LLM Calls | Model Slot | Notes |
|---|---|---|---|
| **`inject(data)`** | | | |
| → Extract | `N × B` | `learning.model` | 1 call per neuron per batch |
| → Update | `0 – N × B` | `learning.model` | Only when extract found something relevant |
| → Memory strategy | `0 – N × B` | `learning.model` | `cumulative` / `decay` only, when the memory crosses its limit |
| **`ask(question)`** | | | |
| → Neuron selection | `1` | `query` | Skipped if only 1 neuron has knowledge |
| → Neuron queries | `N` | `learning.query` | Parallel. N = relevant neurons, not all |
| → Synthesis | `1` | `query` | Combines neuron results into final answer |
| **`ask(question, { mode: 'deep' })`** | `2–12` | `query` | Agentic — LLM decides which neurons to query and when to stop |
| **`query(question)`** | `1` | `learning.query` | Standalone neuron query (single call) |

### Lifecycle Operations

| Operation | LLM Calls | Model Slot | Notes |
|---|---|---|---|
| **`Brain.create()`** | | | |
| → Decomposition | `1` | `init` | Only with `autoSetup: true`. Determines neuron structure |
| → Prompt parsing | `1` | `blueprintModel` | Extracts purpose and synthesis directives |
| → Neuron init | `0` | — | No LLM call. Neuron config is saved as given |
| **`adjust(directive)`** | `0` | — | Adds the directive as a rule for both stages. Memory is not edited |
| **`update(config)`** | `0` | — | Replaces config fields. Memory is not edited |

### Evolution Operations

| Operation | LLM Calls | Model Slot | Notes |
|---|---|---|---|
| **`signal()`** | `0` | — | Buffers only. No immediate LLM call |
| **Evaluator trigger** | `1–12` | `evolution` | Agentic — inspects neurons, reviews gaps, makes decisions |
| → Create N neurons | `1 + N` | `blueprintModel` | 1 generation + 1 per neuron init |
| → Merge neurons | `1` | `blueprintModel` | Single generation call |
| → Split into N | `1 + (N-1)` | `blueprintModel` | 1 generation + 1 init per new neuron |
| → Update neuron | `1–15` | `blueprintModel` | 1 guidance + optional adjust cascade |
| → Delete neuron | `0` | — | Mechanical removal |

## Where to spend the smarter model

Routing the right model to the right slot is the cheapest performance win. Some heuristics:

- **`learning.model`** — extract and update run on every batch, every neuron. Plain text, no schema: a small model works. This is where most calls go.
- **`learning.query`** — runs once per ask per neuron. Smart model recommended; the answer the user sees is shaped here.
- **`query` (brain ask synthesis)** — final integration step. Smart model.
- **`init` / `blueprintModel`** — one-time and rare (decomposition, neuron config generation). Smart model. Cost is amortized.
- **`evolution`** — runs when signals accumulate. Smart model with tool-calling support is required.

See [Configuration — Model Cascade](./configuration#model-cascade) for the full cascade and the `Cost-optimized setup` example.

## Latency

Per-call latency is dominated by the model and provider, not Adapt. A few observations:

- Neurons learn in parallel within a batch. Each neuron makes 1–2 calls in a row (extract, then update).
- Internal neurons run a second pass after user-facing neurons. They use queries that resolve asynchronously and often complete on the next inject.
- Deep-mode ask is variable: 2–12 calls depending on the agent's path.

For a step-by-step lifecycle with timing estimates, see [Events — Brain lifecycle timing](./events#timing-expectations).
