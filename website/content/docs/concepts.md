---
title: Concepts
description: What a brain keeps, how it changes itself, and how adapt compares to RAG and other memory layers.
---

## Compared with RAG and memory layers

adapt decides at write time what to keep, and it divides what it keeps by topic. An agent that learns a user over time gets a stream of messages, notes, events and logs in which facts change. With plain RAG, search returns the old statement and the new one side by side, and something else has to decide which is current. Memory layers decide at write time, each with a unit of memory chosen before it has seen your data: a fact, a graph edge, a memory block, a profile.

- **RAG** stores chunks and searches them at question time. Nothing is learned between the write and the question.
- **mem0** extracts facts as data arrives and updates or deletes the facts that new ones conflict with.
- **Zep/Graphiti** stores timestamped facts as graph edges and invalidates superseded ones. It is stronger than adapt on history.
- **Letta** keeps memory blocks in context that the agent edits, plus searchable archival memory.
- **LangMem** keeps profiles (one rewritten document) or collections of extracted memories, maintained by a background manager.
- **A-MEM** links notes and updates older notes when new ones arrive.

adapt also keeps rewritten text, so rewriting is not the difference. Like Letta and LangMem, it starts from a shape chosen up front: topics it designs from your prompt. Unlike them, it changes that set of topics when input fits none of them. The difference is how the understanding is divided, and that the division changes with the data.

## Architecture

adapt has three properties together.

1. **Attention-based.** Understanding is split into **neurons**. A neuron is one topic, its instructions, and its **understanding** of that topic: plain text, rewritten as data arrives. The API also calls the understanding the memory. Each neuron keeps only what fits its own topic, which is what attention means here ([below](#attention)). What no neuron keeps is a **gap**.
2. **Self-evolving.** The structure reshapes itself, mainly from those gaps.
3. **Small local models.** Each neuron's job is narrow enough for a small model on your machine.

A **brain** is your goal, written as one prompt, plus its neurons. When you create a brain, it designs its first neurons from the prompt. You can also write them yourself.

You feed a brain with `brain.inject(data)`, which means learn from this data. You question it with `brain.ask(question)`, which means ask what it understands. `ask` has two modes: `direct` (the default), where one call picks the neurons to ask, and `deep`, where an agent loop asks them. Both calls return plain values.

A gap has two forms: input that no neuron kept, and a question that no neuron could answer. The brain records both.

Parts of this are borrowed, including memory that reorganizes itself (A-MEM, Letta's sleep-time agents, LangMem's background manager). They are named in [Background](/docs/how-it-works#background-where-the-ideas-come-from). The claim is the combination: understanding split into topics by attention, a structure that reorganizes itself from what fits no topic, and small models on the device.

## Attention

> **Attention:** deciding what deserves effort.

This is not transformer attention. In adapt it decides what each neuron keeps, not how much effort an input gets. On input, every active neuron reads the whole batch and keeps only what fits its topic; what no neuron keeps is a gap. On a question, one call picks the neurons whose topic fits, and their answers become one answer. A question no neuron could answer is also a gap.

![A batch of three inputs goes to every neuron. Two neurons keep their part, one keeps nothing, and the input no neuron kept becomes a gap that evolution reads.](/diagrams/attention.svg)

## Three pillars

Each follows from attention. Each has three parts: what it means, why it follows from attention, and how to use it.

### Self-evolving

**What it means.** The set of neurons is not fixed: the brain creates, updates, merges and removes its own neurons, a process called evolution.

**Why it follows from attention.** Attention leaves a remainder you can count: input no neuron kept, and questions no neuron could answer. Gaps say where the structure no longer fits the data, so they are the main input to changing it.

**How to use it.** Each gap sends a **signal**, a short note that something is missing or changed. Signals also come from neuron health (how often a neuron dismisses input, and how well it answers), `brain.signal` and `brain.update` ([how it works](/docs/how-it-works#5-evolution)). At 5 signals the brain runs evolution: one agent that can create, update, merge or remove neurons. Evolution is on by default.

```ts
await brain.evolve() // run one now
brain.on('evolution:change', (change) => console.log(change.action, change.neuronId))
```

Options: `evolution.autoEvaluate` (default on) and `evolution.evaluatorSignalThreshold` (default 5). Events: `evolution:started`, `evolution:change`, `evolution:completed`, `evolution:failed`.

Evolution needs a model with tool calling. A removed neuron takes its understanding with it; set `evolution.autoEvaluate: false` to run evolution only when you call `brain.evolve()`.

### Proactive

**What it means.** The brain knows what didn't fit its topics, without being asked.

**Why it follows from attention.** If each neuron keeps only its topic, the remainder is visible to the brain itself as input arrives. No user has to point at the hole.

**How to use it.** The brain records what didn't fit as gaps: input no neuron kept, and questions no neuron could answer. Input gaps are stored with the brain, every gap is sent as a signal, and those signals drive evolution. Your app can listen for signals as they happen. Gaps also feed two of the background neurons, one for input no neuron kept and one for questions no neuron could answer, and `brain.consult(question)` asks the background neurons instead of your own. Without a target, `consult` runs an agent over all background neurons that have knowledge and needs tool calling; [How it works](/docs/how-it-works#6-background-neurons) shows how to ask one directly.

```ts
brain.on('brain:signal:received', (s) => console.log(s.source, s.description))
const unkept = await brain.consult('What data did no neuron keep?')
```

`ask()` also returns `gaps`: what the answering model could not answer for that question.

### Local-first

**What it means.** By default the model that runs adapt runs on your machine. Hosted models also work ([guides](/docs/guides#hosted-models)).

**Why it follows from attention.** Each neuron's job is narrow: read a batch, keep what fits one topic, rewrite one short text. Each is a plain-text step that LFM3 1.7B completes, so the default can be a small local model.

**How to use it.** With no model option, adapt uses LFM3 1.7B on LM Studio at `http://localhost:1234/v1` ([quickstart](/docs/quickstart#1-start-a-local-model)). `localModel()` points adapt at another local model or server ([quickstart](/docs/quickstart#other-local-models)). Results on LFM3 1.7B are in [cost and evidence](/docs/how-it-works#cost-and-evidence).

## Use cases

**Personal email assistant.** "What do I think about X, and what changed?"

**Team standups.** Neurons for projects, blockers and owners.

**Product feedback.** A neuron for each theme, and new themes appear as gaps become new neurons.

## When not to use it

adapt keeps a rewritten understanding, not the source text. For verbatim recall, citations and audit trails, use RAG or a database alongside adapt. For a reliable history of how facts changed, use a temporal store such as Zep/Graphiti: a neuron keeps no past versions of its understanding.

## Status

MIT. Version 0.2.0 ([changelog](https://github.com/unbody-io/adapt/blob/main/CHANGELOG.md)). Earlier versions were published as `@unbody-io/adapt`.

- **Shipped:** neurons and brains; learning from text with `inject`; `ask` in `direct` and `deep` modes; gaps; evolution; background neurons; local models by default; SQLite save and restore. Runs on Node and Bun, and a CommonJS build is provided for Electron.
- **Next:** attention to change ([#25](https://github.com/unbody-io/adapt/issues/25)): bursts, sudden spikes in how often something appears, and drift, slow change in what the data is about, with evolution restructuring around them, such as a temporary neuron for a burst or an alert when a feedback theme bursts. Then expectation ([#26](https://github.com/unbody-io/adapt/issues/26)): noticing what didn't match what the brain expected, and prediction, such as "what would I reply to Alex?". Explicit history: dated snapshots of each understanding, and a store of the user's own messages.

Inputs are at most 2000 characters each; split longer text before `inject`. Other limits are in [reference](/docs/reference).

### Roadmap

adapt is built around one loop: **expect** (learn what the data usually does), **notice surprise** (see where it differs), attend, understand and reorganize, all on the device. This release covers attend, understand and reorganize, with attention by topic. Expect and notice surprise come next: cheap statistics see every event, and a small model sees only what is surprising ([#25](https://github.com/unbody-io/adapt/issues/25), [#26](https://github.com/unbody-io/adapt/issues/26)).

![The loop: expect, notice surprise, attend, understand, reorganize. Attend, understand and reorganize are shipped; expect and notice surprise are next.](/diagrams/loop.svg)

## Next

[How it works](/docs/how-it-works) follows a brain step by step, with the model calls each step makes.
