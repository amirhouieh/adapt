---
title: Getting Started
description: Install Adapt and build your first Brain in under 5 minutes.
---

Adapt is a TypeScript library for building AI systems that learn and evolve from data. This guide walks you through installation and building your first Brain in under 5 minutes.

## Install

```bash
npm install @unbody-io/adapt
```

Adapt ships dual ESM and CommonJS builds — `import { Brain } from '@unbody-io/adapt'` works in modern bundlers and `require('@unbody-io/adapt')` works in Electron's main process or any other CJS consumer.

Adapt connects to LLMs through [Vercel AI SDK](https://sdk.vercel.ai) providers. Install the one that matches your LLM service — for example, `@ai-sdk/openai` for OpenAI or `@ai-sdk/anthropic` for Claude:

```bash
npm install @ai-sdk/openai
```

See [Configuration — Using Different Providers](./configuration#using-different-providers) for the full list of supported providers.

## Quick Start

### Brain

A Brain takes a prompt describing what to learn, automatically creates specialized neurons to cover different aspects of that domain, and coordinates them. You feed it data, it routes to all neurons, and when you ask a question it synthesizes answers from all of them.

```typescript
import { Brain } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

const brain = await Brain.create({
  prompt: 'Track my coding patterns and development philosophy.',
  model: openai('gpt-4o'),
})

await brain.inject([
  'commit: refactor: extract validation into pure functions',
  'review: Too heavy — factory functions work fine for our scale.',
])

const result = await brain.ask('What is my coding philosophy?')
console.log(result.insight)
```

### Standalone Neuron

If you don't need multi-domain orchestration, neurons work independently without a Brain. You get direct control over a single learning domain:

```typescript
import { TextNeuron, MemoryNeuronStore } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

const neuron = await TextNeuron.create({
  model: openai('gpt-4o'),
  instructions: 'Track product design principles and philosophy.',
  store: new MemoryNeuronStore(),
})

await neuron.learn([
  'User said: simplicity over features',
  'Team decided: no dark patterns, ever',
])

const result = await neuron.query('What are our design principles?')
console.log(result.insight)
```

### Explicit Neurons

By default, Brain uses the LLM to decompose your prompt into neurons automatically. If you already know what neurons you want, you can define them explicitly:

```typescript
const brain = await Brain.create({
  prompt: 'Track cooking knowledge.',
  model: openai('gpt-4o'),
  autoSetup: false,
  neurons: [
    {
      id: 'techniques',
      name: 'Cooking Techniques',
      type: 'text',
      description: 'Culinary methods and approaches',
      instructions: 'Track cooking techniques, methods, and principles.',
    },
    {
      id: 'recipes',
      name: 'Recipe Collection',
      type: 'text',
      description: 'Tracked recipes and ingredients',
      instructions: 'Track recipes with cuisine type, ingredients, and difficulty level.',
    },
  ],
})
```

Both `autoSetup` and `neurons` can coexist — Brain will auto-generate additional neurons alongside your explicit ones.

### SQLite Persistence

By default, all state is held in memory and lost when the process exits. To persist knowledge across sessions, use SQLite. Two construction verbs handle the two cases — `Brain.create` for the first run, `Brain.restore` for every run after.

**Node.js**

```bash
npm install better-sqlite3
```

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'
import { openai } from '@ai-sdk/openai'

// First run — fresh brain, persists to disk
const brain = await Brain.create({
  prompt: 'Track my coding patterns.',
  model: openai('gpt-4o'),
  store: new SQLiteBrainStore('./brain.db'),
})

// Subsequent runs — restore from disk, no LLM calls during init
const brain = await Brain.restore('./brain.db', { model: openai('gpt-4o') })
```

Per-neuron data is written to sibling files derived from the brain DB path automatically (e.g. `./brain.db` → `./brain.<neuron-id>.db`). The `model` argument rehydrates persisted model refs through the LLM plugin — see [Brain — Fresh vs Restored](./brain#fresh-vs-restored) for runtime options including custom plugins and per-slot model overrides.

**Bun**

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite/bun'
import { openai } from '@ai-sdk/openai'

// First run
const brain = await Brain.create({
  prompt: 'Track my coding patterns.',
  model: openai('gpt-4o'),
  store: new SQLiteBrainStore('./brain.db'),
})

// Subsequent runs — Bun callers must pass an explicit store instance
const brain = await Brain.restore(
  new SQLiteBrainStore('./brain.db'),
  { model: openai('gpt-4o') },
)
```

The path-string sugar `Brain.restore('./brain.db', ...)` always uses the Node SQLite adapter via dynamic import; Bun callers construct `SQLiteBrainStore` from `@unbody-io/adapt/sqlite/bun` and pass the instance instead.

## Next Steps

- [Concepts](./concepts) — architecture and mental model
- [Brain](./brain) — full Brain API guide
- [Neurons](./neurons) — TextNeuron in depth: two-stage learning and memory strategies
- [Prompt Design](./prompt-design) — the most important input to a neuron
