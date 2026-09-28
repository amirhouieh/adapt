# Adapt

![Adapt — a memory layer that grows and reshapes over time](https://raw.githubusercontent.com/unbody-io/adapt/main/assets/hero.jpg)

**Your agent can search everything it stored and still not know you changed your mind.**

Adapt is a memory layer that watches data as it arrives, forms conclusions, and revises them when new data contradicts the old ones. It is not a store you query. It is a thing that has been paying attention.

```bash
npm install @unbody-io/adapt
```

---

## The difference in one example

Feed six months of code reviews into a vector store and ask what your review style is.

RAG returns the chunks most similar to your question. Five review comments. You get a summary of five comments.

Adapt has been reading them as they arrived. In March you rejected a factory pattern as over-engineering. In June you approved one on a service that had grown. It noticed the shift, revised the conclusion, and kept both.

```ts
const result = await brain.ask('How has my view on abstraction changed?')

// "Six months ago you treated abstraction as premature by default.
//  Since the auth refactor you accept it where a module has more than
//  two consumers. The threshold moved, the skepticism did not."
```

That answer is not in any single chunk. No amount of retrieval finds it, because it is not stored anywhere. It comes from having watched the sequence.

---

## Quick start

Adapt uses the [Vercel AI SDK](https://sdk.vercel.ai) for model access. Install a provider alongside it.

```bash
npm install @ai-sdk/openai   # or @ai-sdk/anthropic, @ai-sdk/google
```

```ts
import { Brain } from '@unbody-io/adapt'
import { openai } from '@ai-sdk/openai'

const brain = await Brain.create({
  prompt: 'Track my coding patterns and development philosophy.',
  model: openai('gpt-4o'),
})

await brain.inject([
  { type: 'commit', message: 'refactor: extract validation into pure functions' },
  { type: 'review', comment: 'Too heavy. Factory functions work fine at our scale.' },
])

const result = await brain.ask('What is my coding philosophy?')
console.log(result.insight)
```

Persist it with SQLite and pick it up later:

```ts
const brain = await Brain.restore('./memory.db')
```

---

## How it works

Memory lives in Neurons: small units of understanding, each holding a conclusion and the evidence behind it.

When data arrives, Adapt decides what to do with it. New territory creates a Neuron. Supporting evidence strengthens one. Contradicting evidence revises it. A Neuron that has grown to cover two unrelated things splits. Two that have converged merge. Nothing that stops earning its place survives.

The structure is an output, not a schema you designed up front. You do not model your domain. You point it at a stream.

---

## When to use this

Good fit:

- Long-running agents that should get better at a specific person or codebase over months
- Questions about drift, contradiction, or pattern across time
- Anywhere "what do I know about X" matters more than "find document Y"

Bad fit:

- Fact lookup and citation. Use a vector store. It is better at this and cheaper.
- Anything needing verbatim recall. Adapt keeps understanding, not transcripts.
- Compliance or audit trails. Not a system of record.

Most real systems want both. Adapt alongside retrieval, not instead of it.

---

## Compared to what you are probably using

|  | Vector RAG | Conversation memory (mem0, Zep) | Adapt |
| --- | --- | --- | --- |
| Stores | Chunks | Extracted facts | Conclusions with evidence |
| On new data | Embeds and appends | Appends, sometimes dedupes | Revises what it already believed |
| Handles contradiction | Returns both | Usually last write wins | Updates the conclusion, keeps the history |
| Structure | Fixed | Fixed | Reorganizes itself |
| Answers "what changed" | No | Partially | Yes |

---

## What it costs

Every injection triggers model calls, so this is heavier than an embed-and-store pipeline. It earns that when the questions you care about are about pattern rather than lookup, and it does not when they are not.

Requires a model with structured output and tool calling.

---

## Status

`0.0.x`. In use, changing fast, breaking changes expected. Node, Bun, Electron. ESM and CJS. In-memory or SQLite. MIT.

Local models (Ollama, LM Studio) are not fully tested yet.

Issues and PRs welcome. If you try it and it does not fit your case, that is the most useful issue you can open.

[Docs](https://adapt.unbody.io) · [Changelog](https://github.com/unbody-io/adapt/blob/main/CHANGELOG.md) · [npm](https://www.npmjs.com/package/@unbody-io/adapt)
