---
title: Introduction
description: Self-organizing memory for AI agents, built for small local models.
---

adapt is a TypeScript memory layer designed around attention, self-evolution and proactivity, optimized for small local and on-edge models (1–2B).

adapt takes a different approach to memory. Most memory layers are recall-based: they store data and retrieve it when asked. adapt is attention-based: it tracks what you tell it to, and decides which incoming data deserves its effort. This lets adapt keep a small, current memory instead of a growing archive, notice data that fits nothing it tracks, and reshape what it tracks as the data changes. Each of these steps is narrow enough for a small local model.

![adapt is where attention, self-evolution and proactivity overlap. Attention: each neuron keeps only its topic. Self-evolution: the brain creates, merges and removes neurons. Proactivity: it notices what fits nowhere and acts without being asked. Attention and proactivity overlap in gaps; self-evolution and proactivity in evolution that runs on its own; attention and self-evolution in the topics it reshapes. All of it runs on small local and on-edge models.](/diagrams/venn.svg)

A brain holds a set of neurons. Each neuron has a topic and one plain-text memory. `inject()` sends text to every neuron; each extracts what fits its topic and rewrites its memory. Text no neuron keeps is recorded as a gap. Gaps trigger evolution, which creates, merges or removes neurons. `ask()` routes a question to the neurons whose topics match and merges their answers.

## Install

```bash
npm i adapt-memory   # not on npm yet; npm currently serves 0.0.6
```

The default model is LFM3 1.7B in [LM Studio](https://lmstudio.ai) at `http://localhost:1234/v1`. Use `localModel()` for another local model or server.

## Example

```ts
import { Brain } from 'adapt-memory'

const brain = await Brain.create({ prompt: 'Track my coding preferences and food habits.' })

await brain.inject([
  'I always use strict TypeScript.',
  'Dinner: vegetarian ramen.',
  'Code review: prefer small pure functions.',
])

const answer = await brain.ask('What do I prefer in code?')
console.log(answer.insight)
```

## Next

[Quickstart](/docs/quickstart) · [Concepts](/docs/concepts) · [How it works](/docs/how-it-works) · [Guides](/docs/guides) · [Reference](/docs/reference)
