---
title: Guides
description: How to write prompts and neuron instructions for small models, save and restore a brain, define your own neurons, use hosted models, and listen to events.
---

This page covers the controls. Read [how-it-works](/docs/how-it-works) first. Exact option names and defaults are in [reference](/docs/reference).

## Prompt design

Everything you write reaches a model word for word. The brain prompt goes into setup, and each neuron's `instructions` go into its extract and update calls. No call rewrites them. A small model reads them literally, so this is the part of adapt where your effort pays most.

### The brain prompt

The prompt decides which neurons exist, so a vague prompt makes vague neurons. Say what to understand and what matters. Good:

```text
Track my coding patterns across commits, code reviews and technical talks.
I want to understand my development philosophy, my preferred tools and the
antipatterns I avoid.
```

Weak:

```text
Be a good brain that learns stuff.
```

Setup is told to use as few neurons as cover the request, so a broad domain can collapse into one neuron. If the domain has separate parts, say so:

```text
When you see distinct concerns, prefer specialists over one broad neuron.
If two things could be separate neurons, make them separate.
```

If the domain is one thing, one neuron is right. If you already know the neurons you want, skip setup and write them ([your own neurons](#your-own-neurons)). Keep the prompt short and plain.

### Neuron instructions

`instructions` are the topic. Rules:

- State the topic, never facts. Facts come from the input.
- Lead with the questions the neuron must answer.
- Ask for specifics if you want them: counts, dates, examples.
- Narrow instructions dismiss most batches. Broad instructions keep most, and the understanding grows faster.
- Plain short sentences. A 1.7B model follows a list of two or three questions better than a paragraph of qualifications.

Example:

```text
Track product design principles.

Track answers to:
- What are the team's core design principles?
- Where do two principles conflict?

Keep concrete examples, counts and dates.
```

`description` is a separate field. In `direct` ask, it is what the picking call reads, together with `id` and `name`. Make it say when to ask this neuron.

### Changing a rule later

`brain.adjustNeuron(id, 'Also track accessibility')` adds your sentence as a rule to both learning prompts. Earlier rules stay, the understanding is not edited, and new input is learned under the new rule. To replace the instructions, use `brain.updateNeuron`.

## Save and restore

A brain should survive a restart. This is the one home for persistence.

First run:

```ts
import { Brain } from '@unbody-io/adapt'
import { SQLiteBrainStore } from '@unbody-io/adapt/sqlite'

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  store: new SQLiteBrainStore('./brain.db'),
})
```

SQLite needs `npm i better-sqlite3`. Later runs:

```ts
const brain = await Brain.restore('./brain.db')
```

- `Brain.create` throws "Brain already exists in this store" if the store holds a brain. `Brain.restore` throws "No brain found in this store" if it is empty.
- Restore makes no model calls.
- A local model needs nothing extra on restore. It is saved as plain data: id and server address.
- A hosted model is saved only as a reference, never a client or key. In a new process, pass it again: `Brain.restore('./brain.db', { model })`. Without it, the first model call fails. In the same process the live model is cached, so an in-memory restore works.
- Layout: the brain file plus one SQLite file per neuron, `<stem>.<neuronId><ext>`. `brain.db` gives `brain.coding.db`. Background neurons get files too. `:memory:` stays in memory.
- Saved: prompt, prompt split, model references, `ingest.batchSize`, evolution settings, and each neuron's instructions, governance, current understanding and learning records (revision numbers and short notes of what changed, not past understandings).
- Not saved: the `gaps` config (restore uses 100 and 4000), the signal buffer, the leftover buffer, the `internalNeurons` config and the `learning` defaults. Pass `learning` to `Brain.restore` again if you set it.
- Restore also accepts `blueprintModel`, `init`, `query`, `evolution`, `llm`, `onEvent`, `repairWithFeedback` and `maxRepairAttempts`. The model options only supply live hosted models for the saved references and do not replace the saved per-job models or evolution settings. To change one, call `brain.update` after restore, which saves the change.
- Bun: import from `@unbody-io/adapt/sqlite/bun` and pass the store instance: `Brain.restore(new SQLiteBrainStore('./brain.db'))`. The path-string form always uses the Node adapter.
- Call `await brain.dispose()` when done.

### Memory size: governance

A memory that grows without limit stops fitting the model, so governance shortens it. Set it for all neurons with `learning.governance`, or per neuron with `governance: { strategy, maxTokens }` in the neuron config. The cap is the smaller of `maxTokens` and 8192 tokens, with tokens estimated as characters divided by 4.

| Strategy | Starts shortening | Shortens to |
|---|---|---|
| `cumulative` (default, `maxTokens` 8000) | above 100% of the cap | about 70% of the cap, with one plain-text call |
| `decay` | above 80% of the cap | about 70% of the cap. Keeps recent detail, shortens older facts more. |
| `continuous` | never | not applicable |

With `continuous`, a full memory stops learning, so use it only for topics that stay small. A run whose request would not fit the model's context is refused, not truncated.

An understanding is one text that is rewritten whole, and a neuron keeps no past versions. Shortening drops old values on purpose: it is told to keep the current value where something changed. To keep history today, store `previousUnderstanding` from the `neuron:synthesized` event with a date. Built-in history is next ([what has changed](/docs/how-it-works#what-has-changed)).

## Your own neurons

Define neurons yourself when you know the topics, or to save the setup call.

```ts
import { Brain } from '@unbody-io/adapt'

const brain = await Brain.create({
  prompt: 'Track cooking knowledge.',
  autoSetup: false,
  neurons: [
    {
      id: 'techniques',
      name: 'Cooking Techniques',
      description: 'Culinary methods and approaches',
      instructions: 'Track cooking techniques, methods and principles.',
    },
    {
      id: 'recipes',
      name: 'Recipes',
      description: 'Recipes and their ingredients',
      instructions: 'Track recipes with cuisine, ingredients and difficulty.',
    },
  ],
})
```

- `id` is kebab-case.
- You can set `autoSetup: true` together with `neurons`. Setup then adds neurons next to yours.
- `Brain.create` still makes one call to split the prompt.
- Each neuron costs calls on every inject, and evolution can change or merge neurons later.

### Edit neurons

| Goal | Call | Model calls | Understanding |
|---|---|---|---|
| Add one | `await brain.addNeuron(config)` | 0 | new, empty |
| Change what it tracks | `await brain.updateNeuron(id, { name?, description?, instructions? })` | 0 | kept |
| Add a rule | `await brain.adjustNeuron(id, 'Also track accessibility')` | 0 | kept |
| Join two or more | `await brain.mergeNeurons([idA, idB], { id, name, description, instructions })` | 0 | joined, sources removed |
| Remove | `await brain.removeNeuron(id)` | 0 | lost |
| Pause | `await brain.pauseNeuron(id)` | 0 | kept |
| Resume | `await brain.resumeNeuron(id)` | 0 | kept |
| Add a signal | `brain.signal({ source: 'me', description: 'Split coding into frontend and backend' })` | 0 | kept |

A signal is one note. A run starts at 5 signals, or when you call `brain.evolve()`. A paused neuron is skipped by `inject` and by evolution's view, and is still asked by `ask` and `consult`.

### Change the brain: `brain.update`

`brain.update(config)` changes only these fields:

- `model`, `blueprintModel`, `init.model`, `query.model`, `evolution.model`
- `ingest.batchSize`
- `evolution.enabled`, `evolution.evaluatorSignalThreshold`, `evolution.autoEvaluate`
- `prompt`
- `learning`: `model`, `blueprintModel`, `query`, `governance`

It ignores `evolution.coverageGap`, `gaps`, `internalNeurons`, `autoSetup`, `neurons`, `store`, `llm` and `onEvent`.

A change to `prompt` costs 1 call, to split the new prompt. A change to `learning.name`, `learning.description` or `learning.instructions` does not edit neurons. Both kinds of change also send a signal. If evolution is on, `update` then runs `evolve()` at once and waits for it, which is 1 to 12 more calls. The result has an `evolution` field with what changed. Set the learning model when you create the brain.

### A neuron alone

A neuron can run without a brain. It has no setup, no gaps and no evolution.

```ts
import { Neuron, MemoryNeuronStore } from '@unbody-io/adapt'

const neuron = await Neuron.create({
  instructions: 'Track my coding preferences.',
  store: new MemoryNeuronStore(),
})
await neuron.learn(['I always use strict TypeScript.'])
console.log((await neuron.query('What do I prefer in code?')).insight)
```

It restores like a brain: `Neuron.restore('./neuron.db', { id })`, with `id` when the store holds more than one neuron. A hosted model must be passed again as `model`. Options are in [reference](/docs/reference#neuron).

## Local models and per-job models

The default is LFM3 1.7B in LM Studio, the only model tested with this release. Another local model or server is a `localModel(...)` call; Qwen here is untested:

```ts
import { Brain, localModel } from '@unbody-io/adapt'

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  model: localModel('qwen/qwen3.5-2b'),
})
```

For llama.cpp use `localModel('<model id>', { baseURL: 'http://localhost:8080/v1' })` with the id your server reports.

`model` is the default for every job. Each job can have its own model, and each falls back to its parent.

| Option | Job |
|---|---|
| `blueprintModel` | Splits the prompt. Fallback for `init.model`. |
| `init.model` | Designs the neurons at setup. |
| `query.model` | Picks neurons and writes answers. |
| `evolution.model` | Runs evolution. Needs tool calling. |
| `learning.model`, `learning.query.model` | Apply to neurons the brain creates. |

A separate model for evolution, which needs tool calling. Check tool calling on the second model first; this pairing is untested:

```ts
const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  model: localModel('lfm3-1.7b'),
  evolution: { model: localModel('qwen/qwen3.5-2b') },
})
```

### What the model must support

| Step | Structured output (JSON) | Tool calling |
|---|---|---|
| Learning (`inject`) | no, plain text | no |
| Setup (`Brain.create`) | yes | no |
| The prompt split in `Brain.create` | yes, even with `autoSetup: false` | no |
| `ask`, `direct` mode | yes | no |
| `ask`, `deep` mode | yes | yes |
| Evolution | no | yes |
| `inspect` | no | yes |
| `consult` without a `neuron` id | yes | yes |

Deep ask needs both: the agent gathers answers with tools, and the last answer step must return JSON.

Server settings: a context of at least 32768 tokens and output of 8192 tokens. A cut-off reply is retried, not saved.

### Cost and small-model tips

Calls are the cost, and on a local model they are also time. Counts are in [how-it-works](/docs/how-it-works). To spend less:

- Use fewer neurons. Calls grow with the neuron count.
- Pause neurons you do not need now.
- Keep inputs under 2000 characters each.
- Turn off background neurons you do not use: `internalNeurons: { queryGaps: false }`.
- Use `ask` in `direct` mode. `deep` mode makes up to 12 agent steps.
- Set `evolution.autoEvaluate: false` and call `brain.evolve()` yourself.
- Raise `evolution.evaluatorSignalThreshold`.

Small-model facts:

- Learning calls for one neuron run one at a time, and at most 4 may wait. A fifth fails with `DeviceQueueFullError`, so the run fails and retries. On a one-slot server, many neurons queue.
- A call that must return JSON goes through a repair step. There is no automatic re-ask. You can add one with `repairWithFeedback`. Details are in [reference](/docs/reference#llm-plugin).
- A cut-off reply is retried, never saved as an understanding.
- Check tool calling on your model before you use evolution, `inspect` or deep ask.

## Hosted models

A hosted model runs off your machine. Pass any AI SDK model. OpenRouter with LFM3 is the tested hosted path. `@ai-sdk/openai-compatible` is installed with adapt. With pnpm or another strict package manager, run `npm i @ai-sdk/openai-compatible` so your code can import it.

```ts
import { Brain } from '@unbody-io/adapt'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const openrouter = createOpenAICompatible({
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  supportsStructuredOutputs: true,
})
const model = openrouter('liquid/lfm-3-1.7b')

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  model,
})
```

A hosted model is saved with a brain only as a reference. Pass it again on restore: `Brain.restore('./brain.db', { model })`. See [save and restore](#save-and-restore).

## Events

Use events to show progress, log, or wait for a step.

```ts
brain.on('brain:inject:completed', (payload) => console.log(payload.injectId))
brain.on((event) => console.log(event.type)) // all events
```

- Every event is `{ id, type, timestamp (ms), payload }`. There is no `off` or `once`. A handler that throws is not caught. A `*:failed` event also reaches handlers on `'error'`.
- To see init events, pass `onEvent` to `Brain.create` or `Brain.restore`. It is attached before init runs, and a later `on` misses them.
- `await brain.inject(...)` returns after all your batches are done. Background neuron learning may still run. `brain:inject:*` events fire once per batch of yours.

The full list is in [reference](/docs/reference#events).
