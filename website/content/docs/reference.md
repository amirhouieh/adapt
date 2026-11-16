---
title: Reference
description: Every public method, config option with its default, emitted event with payload, store and LLM plugin in adapt-memory 0.2.0.
---

This page lists exact names, signatures, defaults, events and return types. Read [concepts](/docs/concepts) and [how-it-works](/docs/how-it-works) first for the words and the lifecycle. Import names: root `adapt-memory`; SQLite `adapt-memory/sqlite` (Node, `better-sqlite3`, an optional peer dependency); `adapt-memory/sqlite/bun` (ESM only, `bun:sqlite`). Nothing else is exported.

## Exports

| Import | Values |
|---|---|
| `adapt-memory` | `Brain`, `MemoryBrainStore`, `Neuron`, `MemoryNeuronStore`, `MemoryNeuronCollection`, `createAiSdkLLM`, `localModel`, `DEFAULT_LOCAL_MODEL_ID` (`'lfm3-1.7b'`), `DEFAULT_LOCAL_BASE_URL` (`'http://localhost:1234/v1'`), `neuronConfigSchema` (zod), `STRATEGIES` (`['continuous','cumulative','decay']`), plus types (including `LocalModel`) |
| `adapt-memory/sqlite` | `SQLiteBrainStore`, `SQLiteBrainCollection`, `SQLiteNeuronStore`, `SQLiteNeuronCollection` |
| `adapt-memory/sqlite/bun` | the same four, on `bun:sqlite` |

Hard dependencies: `@ai-sdk/openai-compatible`, `ai`, `jsonrepair`, `nanoid`, `zod`. For a hosted model other than an OpenAI-compatible one, install its `@ai-sdk/*` provider yourself.

Not exported by name: `LearningConfig`, `EvolutionConfig`, `GapsConfig`, `IngestConfig`, `InternalNeuronsConfig`, `BrainRuntimeOptions`, `BrainUpdateResult`, `ConsultResult`, `TextInput`. Use `BrainConfig['learning']` and similar.

## Brain static methods

| Method | Returns | Notes |
|---|---|---|
| `Brain.create(config: BrainConfig)` | `Promise<Brain>` | Designs the neurons from the prompt. Throws "Brain already exists in this store" if the store holds a brain. Attaches `onEvent` before init. 2 model calls with `autoSetup`, 1 without. Both need JSON output, so `autoSetup: false` still needs it. |
| `Brain.restore(input: string \| BrainStore, runtime?: BrainRuntimeOptions)` | `Promise<Brain>` | String is a path for the Node SQLite store. Throws "No brain found in this store" if empty. 0 model calls. A local model is saved with the brain and needs nothing. A hosted model must be passed as `runtime.model` (or `runtime.llm`) in a new process, else the first model call throws. |

`BrainRuntimeOptions`: `model`, `blueprintModel`, `init`, `query`, `evolution`, `learning`, `llm`, `repairWithFeedback`, `maxRepairAttempts`, `onEvent`. Not accepted on restore: `gaps`, `autoSetup`, `internalNeurons`, `neurons`.

- The model options supply live hosted models for the saved references. The saved per-job models and evolution settings win. To change them, call `update` after restore.
- `learning` sets defaults for neurons created later. Saved neurons keep their saved settings.

## Brain instance methods

| Method | Returns | Model calls | Notes |
|---|---|---|---|
| `inject(data: string \| TextInput \| readonly (string \| TextInput)[], options?: { id?: string })` | `Promise<BrainInjectResult>` | per neuron per run: 1 to 3 | `options.id` becomes the result `id` and the events' `injectId` (default `inject_<nanoid>`). `TextInput = { deliveryId: string, text: string, observedAt: string }`. `observedAt` must equal `new Date(x).toISOString()` or it throws. A neuron ignores a `deliveryId` it has seen with the same text. The same `deliveryId` with other text is a conflict and is not learned. Strings get a fresh id. |
| `ask(query: string, options?: AdaptGenerateOptions & { model?: LanguageModel, mode?: 'direct' \| 'deep' })` | `Promise<BrainAskResult>` | direct: (1 if more than one candidate) + picked + 1. deep: up to 12 agent steps, plus 1 per tool call (at most 15), plus 1 | Default `mode: 'direct'`. `model` overrides the picking and answer slot only. |
| `askStream(query, options?)` | `Promise<AdaptStreamResult>` | as ask | Emits only `brain:ask:started`. No background-neuron feed, no gap signal. Result type below. |
| `consult(query, options?: { neuron?: string })` | `Promise<{ insight, sources, gaps }>` | 1 with `neuron`. Else an agent loop over the internal neurons with knowledge (up to 12 steps, needs tool calling), plus 1 JSON answer call | Queries internal neurons only. With none that have knowledge it returns `{ insight: '', sources: [], gaps: [] }`. |
| `inspect(query, options?: AdaptGenerateOptions & { model?: LanguageModel })` | `Promise<{ insight, usage }>` | up to 12 steps | Read-only agent. Tools: `listNeurons`, `inspectNeuron`, `consultInternal`, `getBrainConfig`, `answer`. Needs tool calling. |
| `signal({ source: string, description: string })` | `void` | 0 | `source` and `description` are free text. Evolution reads both. Always emits `brain:signal:received`. If `evolution.enabled`, buffers it and may start a run. |
| `evolve()` | `Promise<EvolutionResult>` | 1 to 12 | Throws if `evolution.enabled` is false. Runs are queued. Flushes a part-full leftover buffer first. |
| `update(updates: Partial<BrainConfig>)` | `Promise<BrainUpdateResult>` | 1 if `prompt` changed, else 0. If `prompt` or `learning.name`, `learning.description` or `learning.instructions` changed and evolution is on: plus `evolve()`, 1 to 12 more | Returns `{ changedFields, config, neuronResults, evolution? }`. `evolution` is the `EvolutionResult` when it ran. Which fields apply: [guides](/docs/guides#change-the-brain-brainupdate). |
| `addNeuron(config: GeneratedNeuronConfig)` | `Promise<Neuron>` | 0 | Origin is `'prompt'`. |
| `updateNeuron(id, { name?, description?, instructions? })` | `Promise<Neuron>` | 0 | Memory kept. |
| `mergeNeurons(ids: string[], config: GeneratedNeuronConfig)` | `Promise<Neuron>` | 0 | Needs 2 or more distinct ids. Memories joined. Sources removed. |
| `removeNeuron(id)` | `Promise<void>` | 0 | Memory lost. |
| `adjustNeuron(id, directive: string)` | `Promise<{ neuron, result }>` | 0 | Adds the directive as a rule. Memory kept. |
| `getNeurons()` / `getNeuron(id)` | `Neuron[]` / `Neuron \| undefined` | 0 | External neurons. `getNeurons()` includes paused ones. |
| `getInternalNeuron(id)` | `Neuron \| undefined` | 0 | Use the full id, such as `__internal_global_understanding`. |
| `getNeuronStatus(id)` | `'active' \| 'inactive' \| undefined` | 0 | Pause state. Not the same as health status. |
| `pauseNeuron(id)` / `resumeNeuron(id)` | `Promise<void>` | 0 | Paused: skipped by `inject` and evolution's view. Still asked. Persisted. Emits `brain:neuron:status:changed`. |
| `on(type, handler)` / `on(handler)` | `this` | 0 | Specific event or all events. No `off` or `once`. |
| `dispose()` | `Promise<void>` | 0 | Waits for learning that is already running, then closes stores. Drops the leftover buffer. |

`AdaptGenerateOptions` (for `ask`, `askStream`, `inspect`): AI SDK call settings such as `abortSignal`, `temperature`, `maxOutputTokens` and `headers`, plus `repairWithFeedback` and `maxRepairAttempts`.

Getters: `prompt`, `promptContext` (`{ purpose, synthesisDirective }`), `config` (resolved: prompt, models, ingest, evolution), `llmRepairOptions`. Fields: `store`, `llm`, `neurons` (Map), `internalNeurons` (Map).

### Result types

| Type | Shape |
|---|---|
| `BrainAskResult` | `{ insight: string, sources: { neuronId: string, relevance: number, confidence: number, insight: string }[], gaps: string[] }` |
| `BrainInjectResult` | `{ id: string, batches: { id: string, index: number, results: { neuronId: string, result: LearnOutput }[] }[] }` |
| `LearnOutput.status` | `'synthesized'` (memory changed; the result also has `newUnderstanding` and `evolution`, a short text of what changed in this neuron's memory, unrelated to brain evolution), `'observe:dismissed'` (nothing relevant), `'synthesize:dismissed'` (relevant, memory unchanged). Other statuses are returned raw when a run is deferred, failed, too large or over capacity. |
| `AdaptStreamResult` | `{ textStream: AsyncIterable<string>, fullStream: AsyncIterable<event>, text: Promise<string>, usage: Promise<usage>, toolCalls: Promise<toolCall[]>, steps: Promise<step[]>, output?: Promise<json> }`. `fullStream` events have `type` `'text-delta'`, `'json-delta'`, `'tool-call'`, `'usage'`, `'finish'` or `'error'`. |
| `EvolutionResult` | `{ changes: EvolutionChange[], reasoning: string }` |
| `EvolutionChange` | `{ action: 'create' \| 'update' \| 'remove', neuronId }` or `{ action: 'merge', neuronId, mergedIds }` |

## Brain config (`BrainConfig`)

### Core

| Option | Default | Notes |
|---|---|---|
| `prompt` | required | One sentence: what to understand. |
| `model` | `localModel()` | LFM3 on LM Studio at `http://localhost:1234/v1`. Or an AI SDK model object, or `{ plugin?, provider?, id, options? }`. |
| `blueprintModel` | `model` | Runs the prompt split. Fallback for `init.model`. |
| `llm` | built from your live models | Custom plugin. Cannot run learning (see LLM plugin). |
| `store` | `new MemoryBrainStore()` | Memory only, lost on exit. Use `SQLiteBrainStore` to keep it. |
| `neurons` | none | `GeneratedNeuronConfig[]`, created before setup. |
| `autoSetup` | `true` | One structured call writes neurons from `prompt`. |
| `onEvent` | none | Attached before init. |
| `repairWithFeedback` | none | `(attempt: AdaptRepairAttempt) => string \| Promise<string>`. Runs only if the built-in repair still fails schema validation. Structured calls only. |
| `maxRepairAttempts` | `1` | Clamped 0 to 3. |

### Models per job

| Option | Default | Job |
|---|---|---|
| `init.model` | `blueprintModel` | Writes the neurons at setup. |
| `query.model` | `model` | Picks neurons and writes answers. |
| `evolution.model` | `model` | Runs evolution. Needs tool calling. |

### `ingest`

| Option | Default |
|---|---|
| `ingest.batchSize` | `20` |

### `learning` (applies to every neuron the brain creates)

| Option | Default | Notes |
|---|---|---|
| `learning.model` | brain `model` | Extract, update and shorten calls. |
| `learning.blueprintModel` | brain `blueprintModel` | |
| `learning.query.model` | the neuron's model | Per-neuron answers. |
| `learning.governance.strategy` | `'cumulative'` | `'continuous' \| 'cumulative' \| 'decay'`. |
| `learning.governance.maxTokens` | `8000` | Estimated as characters / 4. Capped by 8192. `cumulative` shortens above 100% of the cap. `decay` shortens above 80%. Both shorten to about 70%. |
| `learning.understand.thresholds` | `{ maxObservations: 10, maxTokens: 8000, minImportance: 0.5 }` | Stored, but no logic reads it. |
| `learning.instructions` / `name` / `description` | none | Read only through `brain.update`, where they become an evolution signal. |

Precedence for governance: built-in default, then `learning.governance`, then the neuron's own `governance`.

### `evolution`

| Option | Default | Notes |
|---|---|---|
| `evolution.enabled` | `true` | |
| `evolution.autoEvaluate` | `true` | Start a run by itself at the threshold. |
| `evolution.evaluatorSignalThreshold` | `5` | Signals needed for an automatic run. |
| `evolution.model` | `model` | Needs tool calling. |
| `evolution.coverageGap.relevanceThreshold` | `0.3` | Not changeable by `update` or on restore. |

### `gaps`

| Option | Default | Notes |
|---|---|---|
| `gaps.maxStored` | `100` | Oldest dropped first. |
| `gaps.chunkChars` | `4000` | Buffered characters that trigger one leftover call. |

Not restored: a restored brain uses 100 and 4000.

### `internalNeurons`

Each key is `boolean | { governance?: { strategy?, maxTokens? } }`. Default `true` for all. Only `governance` of the object is used.

| Key | Neuron id | Default governance |
|---|---|---|
| `globalUnderstanding` | `__internal_global_understanding` | `decay`, 8000 |
| `globalQueryUnderstanding` | `__internal_global_query_understanding` | `decay`, 8000 |
| `injectionGaps` | `__internal_injection_gaps` | `decay`, 8000 |
| `queryGaps` | `__internal_query_gaps` | `cumulative`, 8000 |

### Fixed limits (not options)

| Limit | Value |
|---|---|
| Evolution agent steps | 12 |
| Gap records shown to evolution | 20 |
| Past runs shown to evolution | 5 |
| Deep ask steps / tool calls | 12 / 15 |
| `inspect` steps | 12 |
| Answer step drops sources with relevance at or below | 0.1 |
| Neuron run size | 8 items, 8000 characters, 8000 counted tokens |
| One input | 2000 characters |
| Learning context / output | 32768 / 8192 tokens |
| Understanding size cap | 32768 characters |
| Learning retries | 3 attempts, 1 s then 4 s |
| Learning concurrency per neuron | 1 running, 4 waiting |
| Learning temperature | 0 |

## Neuron

Standalone use: `Neuron.create(config)`, `Neuron.restore(input, runtime?)`. Constructors are private. Both fully initialize.

### `Neuron.create` config (`NeuronConfig`)

| Option | Default | Notes |
|---|---|---|
| `model` | `localModel()` | |
| `instructions` | required | The topic. |
| `store` | required | `NeuronStore`, for example `new MemoryNeuronStore()`. |
| `id` | `neuron_<nanoid>` | kebab-case by convention. Immutable. |
| `name` | `id` | |
| `description` | none | What `direct` ask uses to pick. |
| `origin` | `'developer'` | `'prompt' \| 'developer' \| 'emergent'`. Brain-created neurons use `'prompt'`. |
| `blueprintModel` | `model` | |
| `query.model` | `model` | |
| `governance` | `{ strategy: 'cumulative', maxTokens: 8000 }` | |
| `understand.thresholds` | `{ maxObservations: 10, maxTokens: 8000, minImportance: 0.5 }` | Stored, but no logic reads it. |
| `health` | built-in | `Partial<NeuronHealth>`. |
| `onEvent`, `repairWithFeedback`, `maxRepairAttempts`, `learning` | none / none / `1` / none | |

### Neuron methods

| Method | Returns | Notes |
|---|---|---|
| `learn(batch: LearnInput \| readonly LearnInput[], options?)` | `Promise<LearnOutput>` | `LearnInput = string \| TextInput`. `options` is ignored. |
| `query(question, options?)` | `Promise<QueryResult>` | `{ relevant, relevance, confidence, insight, gaps: string (newline-joined), usage }`. 1 structured call. No call if the memory is empty and nothing is pending. |
| `queryStream(question, options?)` | `Promise<AdaptStreamResult>` | |
| `getUnderstanding()` | `Promise<string>` | The memory. |
| `setUnderstanding(text)` | `Promise<void>` | Only on an empty neuron. Else throws. |
| `getSummary()` | `Promise<string>` | The memory text itself, or `'(no understanding yet)'`. Not a generated summary. |
| `hasKnowledge()` | `Promise<boolean>` | |
| `getGovernance()` | `{ strategy, maxTokens }` | |
| `getHealth()` | `{ activation, threshold, status: 'active' \| 'dormant', lastAccessed: Date, signalThresholds }` | Starts `'dormant'`. Becomes `'active'` after about 2 memory changes. |
| `update(partial: Partial<NeuronConfig>)` | `Promise<{ changedFields: string[] }>` | `update({ instructions })` keeps the memory and throws on empty text. `id` cannot change. |
| `adjust(directive: string)` | `Promise<AdjustResult>` | 0 calls. `AdjustResult = { changedFields, adjustedConfig, adjustedUnderstanding }`. |
| `flush(signal?)`, `resume(signal?)` | | `resume` re-runs pending work. |
| `erase()`, `dispose()` | `Promise<void>` | |
| `id`, `name`, `description`, `instructions`, `origin`, `isInitialized()` | getters | |

`Neuron.restore(input: string \| NeuronStore, runtime?)`. Runtime options: `id` (when the store holds more than one neuron), `model`, `llm`, `repairWithFeedback`, `maxRepairAttempts`, `onEvent`, `learning`. A local model is saved with the neuron. With no saved or passed model it throws "restoring a neuron requires a live model".

## Events

Subscribe: `brain.on(type, (payload) => ...)` or `brain.on((event) => ...)`. Envelope: `{ id: 'event_<nanoid>', type, timestamp: number (ms), payload }`. Neuron events are forwarded through the brain. This table lists only events the code emits.

### Brain events

| Type | Payload |
|---|---|
| `brain:init:started` | `{}` |
| `brain:init:config:generating` | `{}` |
| `brain:init:config:generated` | `{ configs: GeneratedNeuronConfig[], usage }` |
| `brain:init:completed` | `{ neuronIds }` |
| `brain:init:failed` | `{ error }` |
| `brain:inject:started` | `{ injectId, itemCount, batchCount }` |
| `brain:inject:batch:started` | `{ injectId, batchId, batchIndex, itemCount }` |
| `brain:inject:batch:completed` | `{ injectId, batchId, batchIndex, results: NeuronBatchResult[] }` |
| `brain:inject:completed` | `{ injectId, batches }` |
| `brain:inject:failed` | `{ injectId, error }` |
| `brain:ask:started` | `{ queryId, query }` |
| `brain:ask:synthesis:started` | `{ queryId, specialists }` (deep only; its `queryId` does not match the started and completed events) |
| `brain:ask:completed` | `{ queryId, insight, sources, gaps, usage }` |
| `brain:ask:failed` | `{ queryId, error }` |
| `brain:neuron:added` | `{ neuronId, name, instructions }` |
| `brain:neuron:removed` | `{ neuronId }` |
| `brain:neuron:status:changed` | `{ neuronId, previousStatus, newStatus }` (`'active' \| 'inactive'`) |
| `brain:signal:received` | `{ source, description, timestamp: Date }` |
| `brain:config:updated` | `{ updates, changedFields }` |
| `evolution:started` | `{ signalCount }` |
| `evolution:change` | `EvolutionChange` |
| `evolution:completed` | `EvolutionResult` |
| `evolution:failed` | `{ error }` |

### Neuron events

| Type | Payload |
|---|---|
| `neuron:init:started` | `{ neuronId }` |
| `neuron:init:completed` | `{ neuronId, systemPrompt, usage }` |
| `neuron:init:failed` | `{ neuronId, error }` |
| `neuron:observe:dismissed` | `{ neuronId, output, gaps, usage? }` |
| `neuron:synthesized` | `{ neuronId, newUnderstanding, previousUnderstanding, significance: 'routine', evolution, usage? }` |
| `neuron:synthesize:dismissed` | `{ neuronId, output, usage? }` |
| `neuron:query:started` | `{ neuronId, query }` |
| `neuron:query:completed` | `{ neuronId, insight, relevant, relevance, confidence, gaps: string[], usage }` |
| `neuron:query:failed` | `{ neuronId, error }` |
| `neuron:health:updated` | `{ neuronId, activation, status, previousStatus? }` (only after a memory change) |
| `neuron:signal` | `{ neuronId, description, timestamp, metrics? }` |
| `neuron:config:updated` | `{ neuronId, changedFields, config }` |
| `neuron:understanding:set` | `{ neuronId, understanding }` |

Some neuron event names appear in the types but are never emitted, so do not listen for them.

## Stores

| Class | Import | Notes |
|---|---|---|
| `MemoryBrainStore`, `MemoryNeuronStore` | root | Default. Per process. Nothing saved. |
| `SQLiteBrainStore(path = ':memory:')`, `SQLiteNeuronStore(path)` | `/sqlite` | Node, `better-sqlite3`, WAL mode. Brain file plus one file per neuron: `<stem>.<neuronId><ext>`. `:memory:` stays in memory. |
| same names | `/sqlite/bun` | `bun:sqlite`. ESM only. |

`BrainStore` interface: `state`, `neurons`, `internalNeurons`, `evolution`, `dismissedBatches` (gap records), `getNeuronStore(id): NeuronStore`, `runAtomic`, `dispose()`.

`NeuronStore` interface: `understanding`, `evolution`, `state`, `learningHistory`, `memoryChanges`, `pendingWork`, `pendingInputs`, `processedInputs`, `outbox`, `learningAttempts`, `learningRevisions`, `learning`, `observations` (legacy, unused by learning), `runAtomic`, `dispose()`. This list is abridged; the full types are in `src/stores/types.ts`.

Each collection implements: `add(item)`, `get(id)`, `list(filter?)`, `update(id, changes)`, `delete(id)`, `clear()`, `count(filter?)`, `search(query)`, `addBatch(items)`, and `atomic()`. `atomic()` is a synchronous view used only inside the owning store's `runAtomic` callback. Items have a string `id`. A custom `BrainStore` must return a `NeuronStore` for any neuron id from `getNeuronStore`.

What is saved and what is not: [guides](/docs/guides#save-and-restore).

## LLM plugin

Model input, `LanguageModel`:

- Any AI SDK model object.
- Or `AdaptModelConfig = { plugin?, provider?, id, options? }`.
- Only the config is saved with a brain. A client or key is never saved.

`localModel(id = 'lfm3-1.7b', options?: { baseURL?: string })` returns a `LocalModel`:

- Value: `{ plugin: 'ai-sdk', provider: 'local', id, options: { baseURL } }`.
- `baseURL` default: `'http://localhost:1234/v1'`.
- It is plain data, so a brain saves it and restores it with no model passed.

`createAiSdkLLM(options?)` builds the default plugin (id `'ai-sdk'`):

- `options`: `{ providers?: Record<string, (modelId, config) => AiLanguageModel>, gateway?: boolean }`.
- Use it when you restore a hosted brain without passing `model`.
- Each `providers` key must equal the live model's `provider` string. For `createOpenAICompatible({ name: 'openrouter' })(...)`, check `model.provider`.
- The `local` provider is built in.
- `gateway: true` allows AI Gateway model strings.

`AdaptLLMPlugin`: `{ id, version?, model: { toConfig, validateConfig? }, call(request), streamCall?(request) }`.

- A failed structured output must be returned as `{ text, json: undefined }`, not thrown.
- Neuron learning needs the default plugin. A custom plugin with an `id` other than `'ai-sdk'` throws "text procedure provider requires the Adapt AI SDK plugin" when a neuron learns, so a custom plugin cannot run `inject`.

Which calls need JSON output:

- Needed: setup, the prompt split, neuron picking, neuron answers, the direct and deep answer step.
- Not needed: learning, the leftover call, shortening, evolution, deep-ask tool loop, `inspect`.

Repair of JSON output, in order:

1. Strip text before the first JSON object.
2. Fix `{{`.
3. Run `jsonrepair`.
4. Clamp numbers to schema bounds.
5. Validate with a lenient schema. A missing `gaps` becomes `[]`.
6. If you set `repairWithFeedback`, it runs when step 5 still fails.

`AdaptRepairAttempt = { text, error: ZodError, schema, attempt, llm, model, request }`.

A local runtime helper (`createLocalLLM`) is not exported.
