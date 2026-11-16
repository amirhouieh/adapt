---
title: Quickstart
description: Start a local model, create a brain, learn from text, ask a question and save the brain, in five minutes.
---

This page takes you from nothing to a brain that learns on a local model and survives a restart. It uses the terms from the [introduction](/docs): neuron, understanding, brain and gap.

The code needs ESM and top-level `await`. Use a `.mjs` file, or `"type": "module"` in `package.json`.

## 1. Start a local model

The default model is Liquid LFM3 1.7B, served by LM Studio.

1. In LM Studio, load `lfm3-1.7b`.
2. Set the context length to 32768 tokens. adapt asks for up to 8192 output tokens, so do not cap output lower.
3. Start the server on port 1234. LM Studio serves an OpenAI-compatible API, which is what adapt calls.

You do not name the model in code. With no `model` option, adapt uses `localModel()`, which is `lfm3-1.7b` at `http://localhost:1234/v1`.

## 2. Install

```bash
npm i adapt-memory
```

## 3. Create a brain

```ts
import { Brain } from 'adapt-memory'

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
})
```

The prompt is your goal. `Brain.create` makes two model calls: one designs the neurons from the prompt, and the other splits the prompt into a purpose and an answer style, which the brain uses when it writes answers.

Look at the neurons it designed:

```ts
for (const n of brain.getNeurons()) console.log(n.id, '-', n.name, '-', n.description)
```

For this prompt, expect neurons for coding and for food. The model picks their number and names, so they vary between runs.

## 4. Learn from text

```ts
const result = await brain.inject([
  'I always use strict TypeScript.',
  'Dinner: vegetarian ramen.',
  'Code review: prefer small pure functions.',
])
```

Every neuron reads the whole batch and keeps what fits its topic in its understanding. `result` is `{ id, batches: [{ id, index, results: [{ neuronId, result }] }] }`, and each `result.status` is one of:

- `synthesized`: the neuron's understanding changed.
- `observe:dismissed`: nothing in the batch fit this neuron.
- `synthesize:dismissed`: something fit, but the understanding text did not change.

Other values appear when a run was cut off or failed. See `LearnOutput` in [reference](/docs/reference#result-types). An input longer than 2000 characters is skipped without an error, so split long text first.

Print what each neuron now understands:

```ts
for (const n of brain.getNeurons()) {
  console.log(n.name, '->', await n.getUnderstanding())
}
```

Each is a short plain-text paragraph about that neuron's topic.

## 5. Ask

```ts
const answer = await brain.ask('What do I prefer in code?')
console.log(answer.insight)
console.log(answer.sources) // [{ neuronId, relevance, confidence, insight }]
console.log(answer.gaps)    // string[]
```

You get one `insight`, the `sources` behind it, and `gaps`: what the answering model reports it could not answer. The default mode is `direct`. The `deep` mode lets an agent decide which neurons to ask, and it needs a model with tool calling.

## 6. Save the brain

By default a brain lives in memory and is lost when the process exits. To keep it on disk, give `Brain.create` a SQLite store. SQLite needs `npm i better-sqlite3`.

```ts
import { Brain } from 'adapt-memory'
import { SQLiteBrainStore } from 'adapt-memory/sqlite'

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  store: new SQLiteBrainStore('./brain.db'),
})
```

In a later run, restore it by path:

```ts
const brain = await Brain.restore('./brain.db')
console.log(await brain.ask('What do I prefer in code?'))
await brain.dispose()
```

Restore makes no model calls and needs no model option: a local model is saved with the brain. `Brain.create` throws if the store already holds a brain, and `Brain.restore` throws if it is empty. What is saved is listed in [guides](/docs/guides#save-and-restore).

## 7. Finish

Besides the neurons for your topics, a brain keeps four [background neurons](/docs/how-it-works#6-background-neurons): ordinary neurons that learn about the brain itself, such as which questions no neuron could answer. They learn from each `inject` and `ask` after the call returns, so a script that exits at once can cut that learning off. When you are done, call:

```ts
await brain.dispose()
```

`dispose` waits for learning that is already running, then closes the stores.

## The whole first run

Save as `first-run.mjs` and run `node first-run.mjs`. Run it once; a second run throws because `brain.db` already holds a brain. Use `Brain.restore` after that.

```ts
import { Brain } from 'adapt-memory'
import { SQLiteBrainStore } from 'adapt-memory/sqlite'

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  store: new SQLiteBrainStore('./brain.db'),
})

await brain.inject([
  'I always use strict TypeScript.',
  'Dinner: vegetarian ramen.',
  'Code review: prefer small pure functions.',
])

for (const n of brain.getNeurons()) {
  console.log(n.name, '->', await n.getUnderstanding())
}

const answer = await brain.ask('What do I prefer in code?')
console.log(answer.insight)

await brain.dispose()
```

## Other local models

`localModel()` points adapt at another model in LM Studio or at another OpenAI-compatible server, such as llama.cpp. This release is tested on LFM3 1.7B ([results](/docs/how-it-works#cost-and-evidence)). Pass the result as `model` to `Brain.create`:

```ts
import { localModel } from 'adapt-memory'

localModel('qwen/qwen3.5-2b') // another model in LM Studio
localModel('<model id>', { baseURL: 'http://localhost:8080/v1' }) // a llama.cpp server
```

Use the id your server reports. A saved brain remembers its local model and server address. Hosted models are covered in [guides](/docs/guides#hosted-models).

## Next

- [how-it-works](/docs/how-it-works) explains what just happened and how many model calls each step makes.
- [guides](/docs/guides) shows how to write prompts, define your own neurons and listen to events.
