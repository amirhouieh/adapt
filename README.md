# adapt

adapt is a TypeScript memory layer designed around attention, self-evolution and proactivity, optimized for small local and on-edge models (1–2B).

adapt takes a different approach to memory. Most memory layers are recall-based: they store data and retrieve it when asked. adapt is attention-based: it tracks what you tell it to, and decides which incoming data deserves its effort. This lets adapt keep a small, current memory instead of a growing archive, notice data that fits nothing it tracks, and reshape what it tracks as the data changes. Each of these steps is narrow enough for a small local model.

![adapt is where attention, self-evolution and proactivity overlap.](website/public/diagrams/venn.svg)

Under the hood, adapt splits memory into neurons: small units, each attending to one topic and keeping one plain-text memory of it, called its understanding. A brain is the set of neurons that serves one goal, which you give as a prompt. `inject()` sends new text to every neuron; each extracts what fits its topic and rewrites its understanding. Text no neuron keeps is recorded as a gap, and gaps drive evolution, which creates, merges or removes neurons. `ask()` sends a question to the neurons whose topics match and merges their answers.

## Install

```bash
npm i adapt-memory
```

## Quickstart

Load `lfm3-1.7b` in LM Studio with a 32768-token context and start its server on port 1234. Then:

```ts
import { Brain } from 'adapt-memory'
import { SQLiteBrainStore } from 'adapt-memory/sqlite' // npm i better-sqlite3

const brain = await Brain.create({
  prompt: 'Track my coding preferences and food habits.',
  store: new SQLiteBrainStore('./brain.db'),
})
await brain.inject(['I always use strict TypeScript.', 'Dinner: vegetarian ramen.'])
const answer = await brain.ask('What do I prefer in code?')
console.log(answer.insight, answer.gaps)
await brain.dispose()
// later: const brain = await Brain.restore('./brain.db')
```

The code needs ESM and top-level `await`. The [quickstart](https://adapt.unbody.io/docs/quickstart) walks through each step.

## Status

MIT. Version 0.2.0 ([changelog](CHANGELOG.md)). Earlier versions were published as `@unbody-io/adapt`; their stores are not supported. Shipped features, next steps and limits are on the [concepts page](https://adapt.unbody.io/docs/concepts#status).

## Links

- Docs: <https://adapt.unbody.io/docs>
- [Changelog](https://github.com/unbody-io/adapt/blob/main/CHANGELOG.md) · [npm](https://www.npmjs.com/package/adapt-memory)
- Everything in one file, for coding agents: <https://adapt.unbody.io/llms-full.txt>
