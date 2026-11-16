---
title: Concepts
description: What a brain keeps, how it changes itself, and how adapt compares to RAG and other memory layers.
---

## The problem

Your agent should learn the user over time: what they think, what changed, what matters now. The data arrives as a stream of messages, notes, events and logs.

With plain RAG, search returns the old statement and the new one side by side, and something else has to decide which is current. Memory layers decide at write time, each with a unit of memory chosen before it has seen your data: a fact, a graph edge, a memory block, a profile.

## The field

- **RAG** stores chunks and searches them at question time. Nothing is learned between the write and the question.
- **mem0** extracts facts as data arrives and updates or deletes the facts that new ones conflict with.
- **Zep/Graphiti** stores timestamped facts as graph edges and invalidates superseded ones. It is stronger than adapt on history today.
- **Letta** keeps memory blocks in context that the agent edits, plus searchable archival memory.
- **LangMem** keeps profiles (one rewritten document) or collections of extracted memories, maintained by a background manager.
- **A-MEM** links notes and updates older notes when new ones arrive.

adapt also keeps rewritten text, so rewriting is not the difference. Like Letta and LangMem, it starts from a shape chosen up front: topics it designs from your prompt. Unlike them, it changes that set of topics when input fits none of them. The difference is how the understanding is divided, and that the division changes with the data.

## Architecture

adapt has three properties together.

1. **Attention-based.** Understanding is split into **neurons**. A neuron is one topic, its instructions, and its **understanding** of that topic: plain text, rewritten as data arrives. The API also calls the understanding the memory. Each neuron keeps only what fits its own topic, which is what attention means today ([below](#attention)). What no neuron keeps is a **gap**.
2. **Self-evolving.** The structure reshapes itself, mainly from those gaps.
3. **Small local models.** Each neuron's job is narrow enough for a small model on your machine.

A **brain** is your goal, written as one prompt, plus its neurons. When you create a brain, it designs its first neurons from the prompt. You can also write them yourself.

You feed a brain with `brain.inject(data)`, which means learn from this data. You question it with `brain.ask(question)`, which means ask what it understands. `ask` has two modes: `direct` (the default), where one call picks the neurons to ask, and `deep`, where an agent loop asks them. Both calls return plain values.

A gap has two forms: input that no neuron kept, and a question that no neuron could answer. The brain records both.

Parts of this are borrowed, including memory that reorganizes itself (A-MEM, Letta's sleep-time agents, LangMem's background manager). They are named in [Background](/docs/how-it-works#background-where-the-ideas-come-from). The claim is the combination: understanding split into topics by attention, a structure that reorganizes itself from what fits no topic, and small models on the device, later extended with attention to change and to expectation.

## Attention

> **Attention:** deciding what deserves effort.

This is not transformer attention. Today it decides what each neuron keeps, not how much effort an input gets. On input, every active neuron reads the whole batch and keeps only what fits its topic; what no neuron keeps is a gap. On a question, one call picks the neurons whose topic fits, and their answers become one answer. A question no neuron could answer is also a gap.

Next ([#25](https://github.com/unbody-io/adapt/issues/25)), the brain shifts effort to bursts, sudden spikes in how often something appears, and to drift, slow change in what the data is about. Then ([#26](https://github.com/unbody-io/adapt/issues/26)), to whatever broke its expectations.

![Attention today, simplified. A batch of three inputs goes to every neuron. Each neuron keeps only the part that fits its own topic, and one neuron keeps nothing. The input no neuron kept is a gap, and evolution reads the gaps. How gaps are found exactly is on the How it works page.](/diagrams/attention.svg)

Where this is going is one loop: **expect** (learn what the data usually does), **notice surprise** (see where it differs), attend, understand, reorganize, all on the device. Today's release is stage 1: attend, understand and reorganize. Stage 2 adds expect and notice surprise.

![The loop adapt is built around: expect, notice surprise, attend, understand, reorganize, repeating on the device. Stage 1, shipped today, is attend, understand and reorganize; today attention is by topic and does not depend on surprise. Expect and notice surprise are next, in issues 25 and 26.](/diagrams/loop.svg)

## Three pillars

Each follows from attention. Each has four parts: what it means, why it follows, how to use it today, and what is next.

### Self-evolving

**What it means.** The set of neurons is not fixed. The brain creates, updates, merges and removes its own neurons. This is called evolution.

**Why it follows from attention.** Attention leaves a remainder you can count: input no neuron kept, and questions no neuron could answer. Gaps say where the structure no longer fits the data, so they are the main input to changing it.

**Today.** Each gap sends a **signal**, a short note that something is missing or changed. Signals also come from neuron health (how often a neuron dismisses input, and how well it answers), `brain.signal` and `brain.update` ([how it works](/docs/how-it-works#5-evolution)). At 5 signals, the brain runs one evolution agent that can create, update, merge or remove neurons. This is on by default.

```ts
await brain.evolve() // run one now
brain.on('evolution:change', (change) => console.log(change.action, change.neuronId))
```

Options: `evolution.autoEvaluate` (default on) and `evolution.evaluatorSignalThreshold` (default 5). Events: `evolution:started`, `evolution:change`, `evolution:completed`, `evolution:failed`.

Evolution needs a model with tool calling. A removed neuron takes its understanding with it; set `evolution.autoEvaluate: false` to run evolution only when you call `brain.evolve()`.

**Next.** Restructuring around attention to change, such as a temporary neuron for a burst ([#25](https://github.com/unbody-io/adapt/issues/25)).

### Proactive

**What it means.** The brain knows what didn't fit, without being asked. One idea, two stages: today it knows what didn't fit its topics, and next it knows what didn't match its expectations.

**Why it follows from attention.** If each neuron keeps only its topic, the remainder is visible to the brain itself as input arrives. No user has to point at the hole.

**Today.** The brain records what didn't fit as gaps: input no neuron kept, and questions no neuron could answer. Each gap is stored with the brain and sent as a signal, and those signals drive evolution. Your app can listen for them as they happen, and question the brain's gap records with `consult`. Without a target, `consult` runs an agent over all of the brain's own records and needs tool calling; [How it works](/docs/how-it-works#6-background-neurons) shows how to read one gap record directly.

```ts
brain.on('brain:signal:received', (s) => console.log(s.source, s.description))
const unkept = await brain.consult('What data did no neuron keep?')
```

`ask()` also returns `gaps`: what the answering model could not answer for that question.

**Next.** Attention to change, bursts and drift ([#25](https://github.com/unbody-io/adapt/issues/25)), then surprise: noticing what didn't match what it expected ([#26](https://github.com/unbody-io/adapt/issues/26)).

### Local-first

**What it means.** By default the model that runs adapt runs on your machine, behind a local OpenAI-compatible server such as LM Studio. Hosted models also work ([guides](/docs/guides#hosted-models)). Tested on Node and Bun. A CommonJS build is provided for Electron, untested.

**Why it follows from attention.** Each neuron's job is narrow: read a batch, keep what fits one topic, rewrite one short text. Each is a plain-text step that LFM3 1.7B completes, so the default can be a small local model.

**Today.** With no model option, adapt uses LFM3 1.7B on LM Studio at `http://localhost:1234/v1`. `localModel()` points adapt at another local model or server ([quickstart](/docs/quickstart#other-local-models)). What has been tested, and how well it does, is in [evidence](/docs/how-it-works#cost-and-evidence).

**Next.** Planned: cheap statistics see every event, and a small model sees only what is surprising ([#25](https://github.com/unbody-io/adapt/issues/25), [#26](https://github.com/unbody-io/adapt/issues/26)).

## Use cases

**Personal email assistant.** Today: "What do I think about X, and what changed?" Later: "What would I reply to Alex?"

**Team standups.** Today: neurons for projects, blockers and owners. Later: "What will block next week?"

**Product feedback.** Today: a neuron for each theme, and new themes appear as gaps become new neurons. Later: an alert when a theme bursts ([#25](https://github.com/unbody-io/adapt/issues/25)).

## When not to use it

adapt keeps a rewritten understanding, not the source text. For verbatim recall, citations and audit trails, use RAG or a database alongside adapt. For a reliable history of how facts changed, use a temporal store such as Zep/Graphiti: today a neuron keeps no past versions of its understanding.

## Status

- **Shipped:** neurons and brains; learning from text with `inject`; `ask` in `direct` and `deep` modes; gaps; evolution; background neurons; local models by default; SQLite save and restore. MIT. The latest version on npm is 0.0.6; this release is not published yet ([changelog](https://github.com/unbody-io/adapt/blob/main/CHANGELOG.md)). Until it is, `npm i adapt-memory` installs 0.0.6, which has none of this page's API.
- **Next:** attention to change, bursts and drift ([#25](https://github.com/unbody-io/adapt/issues/25)); expectation, including "what would I reply to Alex?" ([#26](https://github.com/unbody-io/adapt/issues/26)); explicit history: dated snapshots of each understanding, and a store of the user's own messages.
- **Where this is going:** adapt will learn what to expect from your data and notice when reality differs. Today: attention-based understanding that organizes itself. Next: attention to change, and prediction.

Inputs are at most 2000 characters each; split longer text before `inject`. Other limits are in [reference](/docs/reference).

## Next

[How it works](/docs/how-it-works) follows a brain step by step, with the model calls each step makes.
