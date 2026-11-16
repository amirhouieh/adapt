---
title: How it works
description: The brain lifecycle in order, with exact model call counts and the option that tunes each step, then cost and evidence, then the lineage of the ideas.
---

This page follows a brain through its life: setup, inject, ask, gaps, evolution and background neurons. Then it reports cost and evidence, and where the ideas come from. Read [concepts](/docs/concepts) first for the words. Option names and defaults are in [reference](/docs/reference).

This page is the one home for model call counts. Each step lists its calls and the options that tune it.

## 1. Setup

Setup runs inside `Brain.create` and gives the brain the neurons it learns with:

1. Neurons you pass in `neurons` are created first. No model call.
2. If `autoSetup` is true (the default), one call turns the prompt into neurons, each `{ id, name, description, instructions }`. The call must return JSON. Neurons whose id you gave are skipped.
3. One more call, always, even with `autoSetup: false`, splits the prompt into a purpose and an answer style. The brain uses it when it writes answers.
4. Four background neurons are created unless you turn them off. These are ordinary neurons the brain keeps about itself and your questions, such as one that learns from input no neuron kept (section 6).

Model calls: 2 with `autoSetup`, 1 without. Creating a neuron costs no call.

Tune: `autoSetup`, `neurons`, `init.model`, `blueprintModel`, `internalNeurons`.

## 2. Inject

`brain.inject(data)` is how a brain learns from text, and each neuron decides on its own what to keep:

1. Every active neuron reads the whole batch, in parallel. The brain does not route or score inputs.
2. **Extract.** The neuron copies out what fits its topic. If nothing fits, it replies `NONE` and stops. The status is `observe:dismissed`.
3. **Update.** The neuron gets its old understanding and the extract, and writes the whole new understanding. Identical text is `synthesize:dismissed`. New text is `synthesized`.

Both calls are plain text, with no JSON and no tools. The update rewrites the whole text and the neuron keeps no past versions, so an old value survives only if the new text repeats it ([what has changed](#what-has-changed)). The `neuron:synthesized` event carries `previousUnderstanding`, so your app can keep dated copies itself.

A size rule can add a third call that shortens the understanding. See [memory size](/docs/guides#memory-size-governance).

Model calls per neuron per run: 1 if nothing fits, 2 if something fits, 3 if the understanding is also shortened. Each neuron whose understanding changed also feeds the global understanding background neuron (section 6): 1 to 2 more calls.

Limits:

- A batch holds up to `ingest.batchSize` inputs (default 20). Batches run one after another.
- A neuron cuts a batch into runs of at most 8 inputs and 8000 characters, so a batch of 20 short inputs is 3 runs per neuron. Long inputs make more runs.
- An input longer than 2000 characters is skipped without an error. No neuron learns it, and it is reported as a gap only if every neuron also dismissed the rest of its batch. Split long text first.
- A reply that was cut off is never saved. The run waits and retries.
- Paused neurons are skipped.

`inject` returns `{ id, batches: [{ id, index, results: [{ neuronId, result }] }] }`.

On one local server, calls queue, so many neurons on one server run slowly ([speed](#speed)).

Tune: `ingest.batchSize`, `learning.governance`, `learning.model`, `adjustNeuron` for a per-neuron rule.

## 3. Ask

`brain.ask(question)` builds one answer from the neurons whose topics fit the question.

![Ask in direct mode: a question, a call that picks neurons, picked neurons with example relevance and confidence scores, one last call, and the answer with sources and gaps.](/diagrams/ask.svg)

Each neuron returns two scores. **Relevance** is how well its understanding fits the question, 0 to 1. **Confidence** is how sure it is of its own answer, 0 to 1.

### `direct` mode (default)

1. Keep neurons that have an understanding or input waiting. Paused neurons are kept.
2. If more than one is left, one call picks the neurons whose id, name and description fit. The prompt asks it to be inclusive. An empty pick means all.
3. Each picked neuron makes one call that must return JSON. It reads its instructions and its whole understanding, answers only from that, and returns `{ relevant, relevance, confidence, response, gaps }`. A neuron with nothing to read makes no call. A neuron that fails is skipped.
4. Neurons with `relevant: false` are dropped. One last call writes the answer and drops neurons with relevance 0.1 or lower. It also sees the brain's purpose and the understanding of the background neuron that tracks the whole brain (section 6), and it is told to show both sides where they conflict. That background text can disagree with a neuron's understanding, and the answer can then state a change backwards ([what has changed](#what-has-changed)).

Model calls: 1 if more than one neuron has knowledge, plus the number picked, plus 1.

### `deep` mode

`brain.ask(q, { mode: 'deep' })` has no picking call. One agent loop runs on the query model, and it needs tool calling.

- The tool `querySpecialist` asks any neuron any question.
- Three consult tools read background neurons that have knowledge: `consultGlobalUnderstanding` reads `__internal_global_understanding`, `consultCoverageGaps` reads `__internal_injection_gaps` (input gaps), and `consultAnswerGaps` reads `__internal_query_gaps` (question gaps).
- Limits: 12 steps and 15 tool calls. The 15-call cap is checked between steps.
- Parallel tool calls are switched off for OpenAI and Anthropic models only. A weak local model can still make many tool calls in one step.
- The same last call then writes the answer, and it needs JSON output.

Model calls: up to 12 agent steps, plus 1 per tool call, plus 1 for the answer.

Both modes print to the console: `[synthesis:direct]` lines in `direct`, and `[synthesis]` lines in `deep`, one per agent step.

### Result

`ask` returns `{ insight, sources: [{ neuronId, relevance, confidence, insight }], gaps }`.

- In `direct`, `sources` holds neurons with relevance above 0.1.
- In `deep`, `sources` lists every neuron the agent queried.
- `gaps` is what the answering model reports it could not answer. It is not computed from the brain's gap records (section 4).

After `ask` returns, the brain learns from the question in the background, without awaiting it. That costs 1 to 2 calls, and more if the question became a gap (section 4).

### `askStream`

`askStream(q, options)` returns a raw stream. In `direct` it runs picking and the neuron calls, then streams the answer. In `deep` it streams the agent loop. It emits only `brain:ask:started`, does not feed background neurons and sends no gap signal.

Tune: `mode`, `query.model`, `learning.query.model`, `evolution.coverageGap.relevanceThreshold`.

## 4. Gaps

A gap is input that no neuron kept, or a question that no neuron could answer. Gaps show the brain what it is not attending to. A **signal** is a short note that something is missing or changed. Every gap sends one, and signals start evolution (section 5). The `gaps` field of an `ask` result is different: it is the answering model's report (section 3).

There are three sources.

**Whole-batch gap.** Every active neuron answered `NONE`. The brain stores the batch, sends the signal "N input(s) taken by no neuron", and feeds the batch to the background neuron that tracks input gaps (section 6).

**Leftover gap.** Some neuron took the batch, but part of it may not be kept. The brain keeps the batch and the notes the neurons extracted. At `gaps.chunkChars` (default 4000) of buffered data and notes, one plain-text call lists what is in the data and not in the notes. An empty list does nothing. Otherwise the list is stored as a gap and sent as a signal. This buffer lives in RAM, and `dispose` drops it.

**Question gap.** After `ask`, every source scored below `evolution.coverageGap.relevanceThreshold` (default 0.3), or there were no sources. The brain sends the signal "No neuron could answer: <question>" and feeds the question to the background neuron that tracks question gaps (section 6).

The brain stores at most `gaps.maxStored` gap records (default 100) and drops the oldest first. Evolution sees the newest 20. Question gaps are signals only and are not stored as records.

Gaps are counted per batch, not per input. If one neuron takes a batch, there is no whole-batch gap. The leftover call covers that case.

Tune: `gaps.chunkChars`, `gaps.maxStored`, `evolution.coverageGap.relevanceThreshold`.

## 5. Evolution

Evolution creates, updates, merges and removes neurons when signals show that the current set no longer fits the data.

![Evolve: signals from inputs no neuron kept, questions no neuron fit and other sources reach a threshold of 5; an agent with tools reads, creates, updates, merges or removes neurons; stored gaps are retried on the changed neurons.](/diagrams/evolve.svg)

**Where signals come from:**

1. Whole-batch gaps and leftover gaps.
2. Question gaps.
3. Neuron health, the counters each of your neurons keeps of how often it dismisses input and how relevant and confident its answers are. Only your own neurons send these, on three triggers: a dismissal rate above 0.8 after more than 10 inputs; average relevance below 0.3 over at least 5 questions; average confidence below 0.3 over at least 5 questions.
4. Your own `brain.signal({ source, description })`.
5. `brain.update` with a changed `prompt`, or changed `learning.name`, `learning.description` or `learning.instructions`.

**When a run starts:**

- Automatically, at `evolution.evaluatorSignalThreshold` buffered signals (default 5), if `evolution.enabled` and `evolution.autoEvaluate` are true. Both default to true. One signal alone does not start a run.
- Manually, with `await brain.evolve()`. It throws if evolution is disabled.
- On `brain.update` with a changed prompt or learning text, which runs `evolve()` at once if evolution is on.
- Runs are queued, never parallel. A failed run keeps its signals, and the next signal retries.

**What a run is.** One agent loop on `evolution.model`, which needs tool calling, with at most 12 steps. It sees the brain prompt; each active neuron's id, name, description, instructions and understanding length (not the understanding itself); up to 20 gap records; the buffered signals; and the last 5 runs. Its tools:

| Tool | Effect |
|---|---|
| `readMemory({ id })` | Reads one neuron's understanding. |
| `createNeuron({ id, name, description, instructions })` | Adds a neuron. |
| `updateNeuron({ id, name, description, instructions })` | Changes what a neuron tracks. Its understanding is kept. |
| `mergeNeurons({ ids, id, name, description, instructions })` | Makes one new neuron seeded with the joined understandings. The sources are removed. |
| `removeNeuron({ id })` | Removes a neuron. Its understanding is lost. |

There is no split tool. To split a neuron, the agent updates one and creates another.

**Result.** `{ changes, reasoning }`. A change is `{ action: 'create' | 'update' | 'remove', neuronId }` or `{ action: 'merge', neuronId, mergedIds }`. It is saved in the store.

**Retry of gaps.** After a run, stored gaps are fed again to the neurons that changed. Whole-batch gaps go to created, updated and merged neurons. Leftover gaps go only to neurons created or merged after the gap was stored. If a neuron takes the gap, the gap is deleted. If not, its `retryCount` goes up.

Model calls: 1 to 12 for the run, plus 1 to 2 per gap per changed neuron.

Tune: `evolution.enabled`, `evolution.autoEvaluate`, `evolution.evaluatorSignalThreshold`, `evolution.model`.

## 6. Background neurons

Background neurons (internal neurons in the code) are the four ordinary neurons the brain keeps about itself and your questions. All four are on by default.

Each has two names. The **config key** is what you write in `internalNeurons`. The **id** is what you pass to `getInternalNeuron` or `consult`. For example, key `queryGaps` has id `__internal_query_gaps`.

| Config key | Id | What it learns |
|---|---|---|
| `globalUnderstanding` | `__internal_global_understanding` | A note each time one of your neurons changes its understanding: what changed, and the new text. It can hold an old value a neuron dropped, but not reliably. |
| `globalQueryUnderstanding` | `__internal_global_query_understanding` | One note per `ask` (not `askStream`). |
| `injectionGaps` | `__internal_injection_gaps` | Batches no neuron took, and batches absorbed after evolution. |
| `queryGaps` | `__internal_query_gaps` | Questions no neuron could answer. |

- Each feed is a normal learn: 1 to 2 calls, plus a shortening call at times. They run in the background. On a one-slot local server they queue behind your calls.
- The understanding of `__internal_global_understanding` is added to every `direct` answer as context.
- Query any of them with `brain.consult(q, { neuron: id })`.
- Turn one off with `internalNeurons: { queryGaps: false }`.
- They do not take part in `inject` and send no health signals to evolution. They are created only on `Brain.create`; `Brain.restore` loads them from the store.

### What runs without you

Automatic evolution at 5 signals, gap retry after evolution, background learning of the four neurons, the leftover call, and retry timers for cut-off runs. Events report every signal and every evolution run to your app. Answers come only from `ask`, and no timer reviews what the brain understands.

## Cost and evidence

Model call counts for each step are in sections 1 to 6. The results below ran on LFM3 1.7B and checked outputs by string match and by reading every text, with no LLM judge.

### What has changed

Does a rewritten understanding still say "used to X, now Y"? LFM3 1.7B on LM Studio, evolution off, five cases (code editor, diet, project owner, meeting day, programming language), 2 runs each. Each run injects 7 to 8 inputs in three calls, with the change stated once among unrelated inputs, then asks "What changed about <topic>?" ([baseline and raw logs](https://github.com/unbody-io/adapt/blob/main/evals/baselines/what-has-changed-lfm3-2026-11-15.md)).

- **Kept old value, new value and the fact of change:** 8 of 10 runs (4 of 5 cases, both runs each). Example: "This week I switched from Vim to Zed".
- **Lost the old value:** both runs of the owner case. The input said "Sara moved to the mobile team. Tom is now the owner"; the understanding became "Tom owns the billing project", with no Sara.
- **Why:** the kept changes held because the input narrated the change and the rewrite repeated it. Nothing in the update step keeps an old value when the new text states only the new one, and [shortening](/docs/guides#memory-size-governance) is told to keep the current value.
- **Other errors in the understanding:** one neuron held both diet values with no change marker, so it contradicted itself; one kept a stale "go-to language for everything" line next to the new language; one added lines nobody wrote.
- **`ask` in `direct` mode:** for editor, meeting and language, both runs stated the old and new value; editor run 2 also added a claim no understanding made. Diet run 2 missed that eating fish again was a reversal. Owner run 1 answered backwards ("moved from Tom to Sara"): the old owner survived only in the global understanding background neuron, which the answer step reads, and the answer mixed it with the neuron's text. Owner run 2 said it could not give one answer.

### Invented statements

The learn step sometimes writes a claim that no input made. On a 10-fact test with two neurons and 6 runs on LFM3 1.7B via OpenRouter, the current learn prompts invented 4 claims in total, down from 10 before the fix, and kept 56 of 60 facts ([baseline](https://github.com/unbody-io/adapt/blob/main/evals/baselines/learn-invention-lfm3-2026-11-13.md)).

### Speed

All on one Mac with LM Studio and LFM3 1.7B.

- A learning call took about 20 seconds with 4 jobs sharing one server ([baseline](https://github.com/unbody-io/adapt/blob/main/evals/baselines/two-step-production-lfm3-2026-11-12.md)).
- The what-has-changed runs took 3057 seconds for 10 runs, about 5 minutes per run (create, three injects, one `ask`).
- Evolution passed two smoke scenarios with `evolve()` called by hand: 54 calls in 1003 seconds ([baseline](https://github.com/unbody-io/adapt/blob/main/evals/baselines/brain-evolution-smoke-local-default-2026-11-15.md)).

## Background: where the ideas come from

adapt is related to four lines of work. It uses none of their algorithms. Two inform the roadmap, and two are analogies.

- **Predictive processing** (roadmap). Brains are modelled as expecting their input and spending effort on the error (Rao and Ballard; Friston). adapt will use this idea for attention to surprise (#26).
- **Hierarchical temporal memory and standard statistics** (roadmap). Numenta's HTM learns sequences online and flags anomalies. Burst and drift detection, and Markov prediction, are standard statistical tools, and adapt will use them as such (#25, #26).
- **Complementary learning systems** (analogy). A fast store and a slow store learn at different rates (McClelland, McNaughton and O'Reilly). adapt keeps a rewritten, semantic summary per topic and no fast store of episodes yet; it does not learn slowly by interleaving.
- **Cognitive architectures** (analogy). Soar and ACT-R split cognition into modules with their own memories. A neuron is a narrow module in that sense.

Memory that reorganizes itself has prior art too: A-MEM updates older notes when new ones arrive, Letta's sleep-time agents rewrite memory blocks in the background, and LangMem has a background memory manager. adapt differs in what it reorganizes: the set of topic-scoped understandings, driven mainly by gaps.

The claim is the combination. Understanding is split into neurons that each keep one topic, what no neuron keeps becomes a gap, the structure reshapes itself mainly from those gaps, and each neuron's job is narrow enough for a small local model on the device.
