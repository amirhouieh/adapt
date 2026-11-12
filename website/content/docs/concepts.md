---
title: Concepts
description: The mental model — architecture, learning, neurons, evolution, and steering. Read this once; guide pages assume it.
---

This page is the canonical mental model for Adapt. The guide pages assume you've read it — they jump straight into API usage rather than re-explaining the concepts here.

## Architecture

Adapt has two building blocks: **Brain** (an orchestrator) and **Neurons** (specialists). A Brain contains neurons, routes data to them, and synthesizes answers across them. Each neuron independently learns from the data it sees and builds its own understanding.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                              Brain                                   │
│  Routes data · Synthesizes answers · Evolves structure                │
│                                                                       │
│  ┌────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │   Evaluator     │  │  Evolution            │  │  Internal        │  │
│  │  Watches for    │  │  Orchestrator         │  │  Neurons         │  │
│  │  structural     │  │  Acts on evaluator    │  │  Track meta-     │  │
│  │  problems and   │  │  decisions: create,   │  │  knowledge:      │  │
│  │  suggests       │  │  merge, split,        │  │  gaps, query     │  │
│  │  changes        │  │  update, delete       │  │  patterns,       │  │
│  │                 │  │  neurons              │  │  cross-domain    │  │
│  │                 │  │                       │  │  understanding   │  │
│  └────────────────┘  └──────────────────────┘  └──────────────────┘  │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          ┌──────────┐    ┌──────────┐    ┌──────────┐
          │Neuron A  │    │Neuron B  │    │Neuron N  │
          │  (Text)  │    │  (Text)  │    │  (Text)  │
          └────┬─────┘    └────┬─────┘    └────┬─────┘
               │               │               │
               │        Extract → Update       │
               └───────────────┬───────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼                     ▼
              ┌───────────┐        ┌───────────┐
              │  LLM      │        │  Storage   │
              │  (ai-sdk) │        │  (Memory/  │
              └───────────┘        │   SQLite)  │
                                   └───────────┘
```

## Learning

When data flows into a neuron (via `learn()` on a standalone neuron, or `inject()` on a Brain), it runs two stages. The memory is plain text.

1. **Extract** — the model reads the batch against the neuron's purpose and pulls out what is relevant. If nothing is relevant, the neuron dismisses the batch. Brain keeps dismissed data so it can spot coverage gaps.

2. **Update** — the model rewrites the neuron's memory with what was extracted.

A **memory strategy** (`continuous`, `cumulative`, `decay`) then decides whether the memory needs compressing before it is saved.

**Querying** is separate from learning: when you ask a question, the LLM reads the neuron's memory and answers with relevance and confidence scores. It doesn't re-process raw data.

## Brain vs Standalone

| | Use this when |
|---|---|
| **Brain** (`Brain.create`) | You want auto-decomposition into multiple specialists, parallel routing, multi-neuron synthesis, and evolution. |
| **Standalone neuron** (`TextNeuron.create`) | You only need one domain and want direct control. No orchestration, no evolution. |

Standalone neurons are first-class — they expose the same `learn` / `query` / `update` / `adjust` surface a Brain calls into. Most examples on this site use a Brain because that's the more common starting point.

## Neurons

Every neuron is a `TextNeuron`: one plain-text memory, learned in two stages (extract, then update), kept in size by a memory strategy (`continuous`, `cumulative`, `decay` + a token limit). See [Neurons](./neurons).

## Evolution

The neuron structure isn't static. As data arrives and queries flow in, neurons can become overloaded, overlap, or leave gaps. Evolution is the loop that lets a Brain reshape itself: **signal → evaluate → act**.

- **Signals** flag that something might need to change. Three sources: automatic (neuron health — high dismissal, low confidence, stagnation), coverage gaps (no neuron could process / answer), and developer-injected via `brain.signal({ source, description })`.
- **Evaluator** is an LLM agent that triggers when signals accumulate (default threshold: 5). It inspects neurons, queries their knowledge, and consults internal neurons before deciding what to do.
- **Actions** the evaluator can take: **create**, **merge**, **split**, **update**, or **delete** neurons.

Brain also runs four **internal neurons** that track meta-knowledge about the system itself — cross-domain patterns (Global Understanding), query topics (Global Query Understanding), data nothing could process (Injection Gaps), questions nothing could answer (Query Gaps). The evaluator consults them; you can too via `brain.consult()`.

## Steering

Three distinct verbs cover the steering surface. They are not interchangeable:

| Verb | What it feeds | When to use |
|---|---|---|
| `inject(data)` | Data — runs through extract → update | Routine — you have new information |
| `signal({ source, description })` | Metadata — feeds the evolution evaluator | "We need a neuron for X" / "These two overlap" / "Restructure now" |
| `adjustNeuron(id, directive)` / `neuron.adjust()` | Natural-language steering for one neuron | "Stop tracking desktop" / "Be stricter about distinct topics" |
| `update(config)` | Mechanical config replacement (models, thresholds, prompt) | Threshold tuning, model swap, semantic prompt change |

Data goes through `inject`. Structural change goes through `signal`. Per-neuron behavior tweaks go through `adjust`. Mechanical config changes go through `update`.
