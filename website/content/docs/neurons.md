---
title: Neurons
description: TextNeuron — two-stage learning, querying, and memory strategies.
---

API guide for `TextNeuron`, the neuron Adapt uses to learn. For the mental model, see [Concepts](./concepts).

## TextNeuron

Only `model`, `instructions`, and `store` are required:

```typescript
import { TextNeuron, MemoryNeuronStore } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

const neuron = await TextNeuron.create({
  model: openai('gpt-4o'),
  instructions: 'Track product design principles and user research insights.',
  store: new MemoryNeuronStore(),
})

await neuron.learn([
  'User testing showed: 3-click navigation preferred over hamburger menu',
  'Design review: dark mode should be default for evening users',
])

const understanding = await neuron.getUnderstanding() // string
const result = await neuron.query('What are the key design principles?')
```

### How a neuron learns

A neuron keeps one memory: plain text. Each `learn()` call runs two stages, at most two model calls:

1. **Extract** — the model reads the batch against the neuron's `instructions` and pulls out what is relevant. If nothing is, it replies `NONE` and the neuron dismisses the batch.
2. **Update** — the model rewrites the memory with what was extracted. The result is the new memory.

No schema, no buffer, no thresholds to wait for: `learn()` returns once the memory is updated.

`learn()` takes `string` items or `TextInput` items (when you own ids and times). `observedAt` must be in the exact form `Date.toISOString()` gives (`2026-11-10T09:00:00.000Z`):

```typescript
await neuron.learn([
  { deliveryId: 'msg-42', text: 'Moved the launch to March.', observedAt: '2026-11-10T09:00:00.000Z' },
])
```

### Memory strategies

`governance` controls what happens when the memory grows. The strategy runs right after the update stage, before the memory is saved.

```typescript
const neuron = await TextNeuron.create({
  model: openai('gpt-4o'),
  instructions: 'Track product design principles and user research insights.',
  store: new MemoryNeuronStore(),
  governance: { strategy: 'decay', maxTokens: 8000 },
})

neuron.getGovernance() // { strategy: 'decay', maxTokens: 8000 }
await neuron.update({ governance: { strategy: 'cumulative' } })
```

| Strategy | What happens | Good for |
|---|---|---|
| `cumulative` (default) | Over `maxTokens`, one model call shortens the memory, keeping what matters most. | General learning — bounded size |
| `decay` | At 80% of `maxTokens`, one model call shortens the memory, keeping recent facts in detail and shortening older ones more. | Topics where recent data matters most |
| `continuous` | Nothing: the memory is never shortened. | Small topics only — see the warning below |

The shorten call uses the same plain style as the update step: it is told the topic and your `adjust` rules, to keep current values where something changed, and to add nothing (no advice, no lessons).

Tokens are estimated as characters / 4. `maxTokens` defaults to 8000, for standalone and Brain neurons alike. It is capped by the memory size of the learning setup (8192 tokens by default).

> **`continuous` stops learning at the cap.** The memory can hold about 8192 tokens. With `continuous`, once an update would go past that, the update is refused, that batch is dropped, and later batches fail the same way. Use it only for topics that stay small.

### Restore

To restore a persisted neuron, use `TextNeuron.restore`:

```typescript
import { SQLiteNeuronStore } from '@unbody-io/adapt/sqlite'

// Path-string sugar (Node SQLite)
const neuron = await TextNeuron.restore('./neuron.db', { model: openai('gpt-4o') })

// Or pass an explicit NeuronStore instance
const neuron = await TextNeuron.restore(
  new SQLiteNeuronStore('./neuron.db'),
  { model: openai('gpt-4o') },
)

// Standalone neurons can carry their own id when restoring from a shared store
const neuron = await TextNeuron.restore('./neuron.db', {
  id: 'design-principles',
  model: openai('gpt-4o'),
})
```

The `model` argument rehydrates persisted model refs through the LLM plugin. See [Brain — Fresh vs Restored](./brain#fresh-vs-restored) for the full runtime semantics — it applies identically to neuron `restore`.

Constructors are private — `create` and `restore` are the only public entry points, and both fully initialize the neuron (no separate `init()` call). Memory strategy settings are saved with the neuron and come back on restore.

## Neuron API

```typescript
// Learning
await neuron.learn(batch)                    // LearnOutput

// Querying
const result = await neuron.query('...')     // QueryResult
const stream = await neuron.queryStream('...') // AdaptStreamResult

// Memory
await neuron.getUnderstanding()              // string
await neuron.setUnderstanding(text)          // Starting memory (empty neuron only)
await neuron.getSummary()                    // Prose summary
await neuron.hasKnowledge()                  // Has any memory?

// Memory strategy
neuron.getGovernance()                       // { strategy, maxTokens }

// Introspection
neuron.getHealth()                           // { activation, status, signalThresholds }
neuron.getMetrics()                          // { ingestion: { dismissalRate, ... }, query: { ... } }
await neuron.getEvolution()                  // EvolutionRecord[]
neuron.getMetadata()                         // NeuronMetadata

// Config
await neuron.adjust('natural language directive')
await neuron.update({ instructions: '...', governance: { strategy: 'decay' } })

// Identity
neuron.id                                    // string
neuron.name                                  // string
neuron.instructions                          // string
neuron.description                           // string
neuron.type                                  // 'text'
neuron.origin                                // 'prompt' | 'developer' | 'emergent'
```

### Learn Output

`learn()` returns a discriminated union:

```typescript
const result = await neuron.learn(data)

switch (result.status) {
  case 'synthesized':
    // Memory changed
    console.log(`What changed: ${result.evolution}`)
    break

  case 'observe:dismissed':
    // Extract found nothing relevant (replied NONE)
    break

  case 'synthesize:dismissed':
    // Relevant, but the memory did not change
    break
}
```
