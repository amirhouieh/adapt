---
title: Stores
description: Memory and SQLite storage layers, persistence across sessions, and custom stores.
---

Brain has two independent storage layers:

| Layer | Interface | Purpose |
|---|---|---|
| **Brain Store** | `BrainStore` | Brain state, neuron registry, evolution history, dismissed batches |
| **Neuron Store** | `NeuronStore` | Per-neuron memory, learning history, evolution, state |

You only configure the brain store directly. Per-neuron stores are derived from it through `BrainStore.getNeuronStore(neuronId)` — same code path on `Brain.create` and `Brain.restore`, so the two cannot disagree on where each neuron's data lives.

## Memory Stores (default)

```typescript
import { Brain, MemoryBrainStore } from '@unbody-io/adapt'

const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  store: new MemoryBrainStore(),
})
```

Ephemeral — data lost on process exit. Good for development and testing. `MemoryBrainStore` caches a `MemoryNeuronStore` per neuron id internally.

## SQLite Stores

Adapt ships runtime-specific SQLite adapters. Core Adapt remains runtime-agnostic; only the adapter import changes.

| Adapter | Runtime | Driver |
|---|---|---|
| `@unbody-io/adapt/sqlite` | Node.js | `better-sqlite3` |
| `@unbody-io/adapt/sqlite/bun` | Bun | `bun:sqlite` |

### Node.js

**Install:**

```bash
npm install better-sqlite3
```

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'

const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  store: new SQLiteBrainStore('./brain.db'),
})
```

Persistent via `better-sqlite3`. Each neuron's data is written to a sibling file derived from the brain DB path (e.g. `./brain.db` → `./brain.<neuron-id>.db`). On the next session, restore with `Brain.restore('./brain.db')` — no LLM calls on restore.

### Bun

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite/bun'

const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  store: new SQLiteBrainStore('./brain.db'),
})
```

Persistent via Bun's built-in `bun:sqlite`. Restore behavior matches Node — pass a `SQLiteBrainStore` instance to `Brain.restore()`:

```typescript
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite/bun'

const brain = await Brain.restore(new SQLiteBrainStore('./brain.db'))
```

(The path-string sugar `Brain.restore('./brain.db')` always uses the Node SQLite adapter via dynamic import, so Bun callers must pass an explicit store instance.)

Standalone neurons follow the same shape: `TextNeuron.create(config)` writes to the configured store; `TextNeuron.restore(pathOrStore)` reads it back. See [Neuron API → Lifecycle](./reference/neuron-api#lifecycle).

### Hierarchical Persistence

For apps with multiple entities, scope a brain DB path per entity. Per-neuron files are derived as siblings of that brain DB automatically:

```typescript
const brain = await Brain.create({
  prompt: '...',
  model,
  store: new SQLiteBrainStore(`./${entityId}/brain.db`),
})
```

This lets you cleanly delete all data for a single entity by removing its directory.

## Persistence Across Sessions

```typescript
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'

// Session 1: create and learn
const brain = await Brain.create({
  prompt: '...',
  model: openai('gpt-4o'),
  store: new SQLiteBrainStore('./brain.db'),
})
await brain.inject(data)
await brain.dispose()

// Session 2: restore and continue
const brain2 = await Brain.restore('./brain.db', { model: openai('gpt-4o') })
await brain2.ask('What do you know?')                   // full knowledge from session 1
```

The `model` argument rehydrates persisted model refs through the LLM plugin. See [Brain — Fresh vs Restored](./brain#fresh-vs-restored) for the full runtime options (custom plugins, per-slot overrides).

## Custom Stores

If you need a backend other than in-memory or SQLite (e.g., PostgreSQL, Redis, a cloud database), you can implement your own stores. Both interfaces follow a simple collection-based pattern — each namespace is a CRUD collection for a specific type of record.

**NeuronStore** — one per neuron, holds that neuron's memory (`understanding`), learning records, evolution history, and state. Abridged:

```typescript
interface NeuronStore {
  observations: NeuronCollection<ObservationRecord>
  understanding: NeuronCollection<UnderstandingRecord>
  evolution: NeuronCollection<EvolutionRecord>
  state: NeuronCollection<StateRecord>
  dispose(): Promise<void>
}
```

The full interface also has the collections two-step learning writes to (`learningHistory`, `memoryChanges`, `pendingInputs`, `processedInputs`, and others) — see `NeuronStore` in `src/stores/types.ts`. The `observations` collection is kept for older stores; TextNeuron learning does not write to it.

**BrainStore** — one per brain, holds the brain's state, neuron registry, internal neuron registry, evolution history, and dismissed batches. Also resolves per-neuron stores via `getNeuronStore(id)`:

```typescript
interface BrainStore {
  state: BrainCollection<BrainStateRecord>
  neurons: BrainCollection<BrainNeuronRecord>
  internalNeurons: BrainCollection<BrainNeuronRecord>
  evolution: BrainCollection<BrainEvolutionRecord>
  dismissedBatches: BrainCollection<DismissedBatchRecord>
  getNeuronStore(neuronId: string): NeuronStore
  dispose(): Promise<void>
}
```

`getNeuronStore(neuronId)` is the single seam for per-neuron persistence — Brain calls into it on both `create` and `restore`, so the two paths cannot disagree on where a neuron's data lives. A custom `BrainStore` implementation must return a `NeuronStore` for any neuron id (typical strategy: cache one per id, derive a path/key from the id for persistent backends).

Both `NeuronCollection` and `BrainCollection` implement the same CRUD interface. Each method does what you'd expect — the important one to note is `search()`, which should support full-text search (used by ListNeuron's deduplication during synthesis):

```typescript
interface NeuronCollection<T extends { id: string }> {
  add(item: T): Promise<void>
  get(id: string): Promise<T | undefined>
  list(filter?: Record<string, unknown>): Promise<T[]>
  update(id: string, changes: Partial<Omit<T, 'id'>>): Promise<void>
  delete(id: string): Promise<void>
  clear(): Promise<void>
  count(filter?: Record<string, unknown>): Promise<number>
  search(query: string): Promise<T[]>
  addBatch(items: T[]): Promise<void>
}
```

### Complete custom neuron store example

```typescript
class MapNeuronCollection<T extends { id: string }> implements NeuronCollection<T> {
  private items = new Map<string, T>()

  async add(item: T): Promise<void> {
    if (this.items.has(item.id)) throw new Error(`Record with id "${item.id}" already exists`)
    this.items.set(item.id, item)
  }

  async get(id: string): Promise<T | undefined> {
    return this.items.get(id)
  }

  async list(filter?: Record<string, unknown>): Promise<T[]> {
    const values = [...this.items.values()]
    if (!filter) return values
    return values.filter((item) =>
      Object.entries(filter).every(([key, value]) => (item as Record<string, unknown>)[key] === value)
    )
  }

  async update(id: string, changes: Partial<Omit<T, 'id'>>): Promise<void> {
    const existing = this.items.get(id)
    if (!existing) throw new Error(`Record with id "${id}" not found`)
    this.items.set(id, { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    if (!this.items.delete(id)) throw new Error(`Record with id "${id}" not found`)
  }

  async clear(): Promise<void> {
    this.items.clear()
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    return (await this.list(filter)).length
  }

  async search(query: string): Promise<T[]> {
    const normalized = query.toLowerCase()
    return (await this.list()).filter((item) =>
      JSON.stringify(item).toLowerCase().includes(normalized)
    )
  }

  async addBatch(items: T[]): Promise<void> {
    for (const item of items) await this.add(item)
  }
}

class MapNeuronStore implements NeuronStore {
  observations = new MapNeuronCollection<ObservationRecord>()
  understanding = new MapNeuronCollection<UnderstandingRecord>()
  evolution = new MapNeuronCollection<EvolutionRecord>()
  state = new MapNeuronCollection<StateRecord>()

  async dispose(): Promise<void> {
    // no-op
  }
}
```
