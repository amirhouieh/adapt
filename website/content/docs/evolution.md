---
title: Evolution
description: How the Brain reshapes its neurons, and how to steer it.
---

Evolution keeps the Brain's neurons the right shape for what it sees. For the conceptual overview, see [Concepts — Evolution](./concepts#evolution).

## How it works

One agent loop. The model sees:

- the Brain prompt (what you want tracked),
- every active neuron: id, name, description, instructions and memory size,
- the inputs no neuron took (gaps), newest 20 gap records,
- the buffered signals,
- the last few evolution runs.

It can call five tools. Each change is applied at once:

| Tool | What it does |
|---|---|
| `readMemory(id)` | Reads a neuron's memory |
| `createNeuron(config)` | Adds a neuron for a topic no neuron covers |
| `updateNeuron(config)` | Rewrites a neuron's name, description and instructions; its memory is kept |
| `mergeNeurons(ids, config)` | Replaces 2+ neurons with one; their memories are joined |
| `removeNeuron(id)` | Removes a neuron and its memory |

There is no split: the model narrows a neuron with `updateNeuron` and creates neurons for the rest. When the run ends, stored gaps are retried as raw inputs: a batch no neuron took goes to every neuron that was created, updated or merged; a leftover gap goes only to neurons created or merged after it was stored, never to the neurons that took its batches. A gap a neuron takes is removed.

## Signals

Signals are short notes that something may need a change. They are buffered; when `evaluatorSignalThreshold` are waiting and `autoEvaluate` is on, a run starts by itself.

- **Gaps** — an injected batch no neuron took. Brain stores it and sends a signal.
- **Leftovers** — lines no neuron kept in a batch some neuron took. Brain collects such batches with the notes the neurons kept, and when they reach `gaps.chunkChars` characters, one model call copies what no neuron kept. If anything is left, Brain stores the batches with that text and sends it as one signal; evolution sees the leftover text, not the kept lines. `brain.evolve()` checks a part-full buffer first. The buffer lives in memory only: `dispose()` drops it and it is not saved.
- **Unanswered questions** — an `ask` where every neuron scored below `coverageGap.relevanceThreshold`.
- **Neuron health** — a neuron with a high dismissal rate, or low query relevance or confidence.
- **Yours** — `brain.signal({ source, description })` from application logic.

## Evolution Config

```typescript
evolution: {
  enabled: true,                    // Master switch (default: true)
  model: openai('gpt-4o'),          // Model for the loop (falls back to brain.model)
  evaluatorSignalThreshold: 5,      // Signals before a run starts by itself (default: 5)
  autoEvaluate: true,               // Start runs by itself (default: true)
  coverageGap: {
    relevanceThreshold: 0.3,        // Below this on every neuron, a question is a gap (default: 0.3)
  },
}

gaps: {
  maxStored: 100,                   // Gap records kept for evolution (default: 100)
  chunkChars: 4000,                 // Characters of mixed batches per leftover call (default: 4000)
}
```

## Manual Control

```typescript
// Add a signal
brain.signal({
  source: 'analytics',
  description: 'Users ask about deployment but no neuron covers it',
})

// Run evolution now (runs are queued, never parallel)
const { changes, reasoning } = await brain.evolve()
// changes: [{ action: 'create', neuronId: 'deployment' }, ...]
```

Change neurons yourself, with or without evolution enabled:

| Method | What happens |
|---|---|
| `addNeuron(config)` | Add a neuron |
| `updateNeuron(id, { name?, description?, instructions? })` | Change what a neuron tracks; memory is kept |
| `mergeNeurons(ids, config)` | Replace 2+ neurons with one; memories are joined |
| `removeNeuron(id)` | Remove a neuron and its memory |
| `adjustNeuron(id, directive)` | Add a rule to how a neuron learns |

## When to Enable/Disable

**Enable** (default) when the Brain is long-lived and the domain may shift over time.

**Disable** when the neurons are known upfront and shouldn't change, for example session-scoped brains or hand-written neurons.

```typescript
// Long-term brain: let it evolve
const clientBrain = await Brain.create({
  prompt: '...',
  model,
  evolution: { enabled: true },
})

// Session brain: fixed structure
const sessionBrain = await Brain.create({
  prompt: '...',
  model,
  evolution: { enabled: false },
  autoSetup: false,
  neurons: [...],
})
```
