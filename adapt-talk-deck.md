# Adapt — "Pay Attention" deck

Builder show-and-tell, ~7 slides. Not a pitch — an experiment I ran and want to share.
You own the visuals. Below: what goes on each slide + the intent in one line.

**Look:** dark, monochrome, terminal. Monospace. Lowercase. One accent `#9b9ba8` for
unsettled/in-flight states only. Signature motion = scramble→resolve (optional).
One idea per slide, almost no text — I talk, the slide shows.

---

## 1 — where it started

On slide: the tweet, alone.
> some questions are only answerable if you've been paying attention all along. that's why
> RAG and large context windows alone won't cut it.

*Intent: the seed, in my words, before any code existed.*

## 2 — two kinds of questions

On slide: recall vs. change-over-time.
- **recall** — *"what did X say about Y?"* → the answer is sitting in your data → RAG + big context windows nail this
- **change-over-time** — *"how has X shifted?"* → the answer isn't stored anywhere; it had to be watched as it happened
- this talk is about the second kind

*Intent: be explicit — not bashing RAG. recall is a solved problem; retrieval is great at it. Adapt is for the other class of question. Keep this respectful and clear so nobody hears "RAG is useless."*

## 3 — why that breaks (the RAG view)

On slide: one question, RAG's answer only. (the Adapt answer to this same question lands on slide 7.1.)
- question: *"how did their view on X change over time?"*
- RAG lights up the few chunks most *similar to the question* — scattered, out of time-order
- you can't draw a trajectory from a handful of snapshots → it concludes the wrong thing
- the early baseline that *proves* the change is the **least** similar → never retrieved

Reference sketch — RAG only (your call on the real design):

```text
"how did their view on X change over time?"

RAG   ·   ·      ●          ●         ·  ●·        → "seems… mostly stable?"  ✗
      └ grabs what's similar · loses the order · drops the baseline ┘
```

*Intent: this slide is ONLY the problem — don't show Adapt here. The viewer should feel that retrieval handed back disconnected snapshots and drew the WRONG conclusion. The killer detail: annotate the greyed-out earliest point as "the proof of the change — never retrieved" — that single note is the whole argument. The same question gets answered on slide 7.1 as the payoff. (~100M/month growth stays a spoken aside, not on this slide.) RAG is still fine for recall — wrong tool for this.*

## 4 — wait, this is just learning

On slide: the reframe + the brain analogy.
- the second kind of question isn't recall — it's *learning from patterns over time*
- that's what our brains do
- and we learn by two moves: **observe and filter the noise**, and **be selective** about what we pay attention to in the first place
- so what if memory worked the same way?

*Intent: the pivot from problem → idea, and the origin of the whole design (why "neurons", why an extract/filter step, why scoped specialists). State the principle only — save the mechanism for "how it works".*

## 5 — three things that make it different

On slide: what adapt is, then three things that follow from it.
- adapt is an **understanding layer**, not a store you query. its architecture is built on **attention**.
- **self-evolving** — the brain creates, merges and removes its own neurons from what it sees
- **proactive** — it notices what it doesn't cover yet (inputs no neuron kept) and acts on it without being asked
- **local-first** — runs on your device, your data stays there. built for edge devices and small local models. we start with liquid lfm-3 and qwen.

*Intent: the positioning, no abstraction. attention is the thesis the talk just built; the other three fall out of it. next slides show how each works. Note: local-first is the direction and design; the main test model today is lfm-3.*

## 6 — how it works: the big picture

On slide: two building blocks.
- a **Brain** holds many **Neurons** — each neuron is a specialist that owns one concern
- inject data → it routes to all neurons; ask a question → it synthesizes one answer across them
- and the Brain keeps reshaping which neurons exist over time

*Intent: 10,000-ft view only. the two pieces and how they connect. next two slides zoom in.*

## 7 — how a neuron learns (two steps)

On slide: extract → update, over time.
- **extract** — read each batch, keep only what's relevant to this neuron, drop the noise
- **update** — rewrite the neuron's plain-text memory with what was kept
- querying is separate: it reads the understanding, never re-reads the raw data

*Intent: this is slide 4's "observe + filter" made real — the core learning loop. show it as a cycle that runs over time, not a one-shot.*

## 7.1 — the answer (payoff to slide 3) — NEW SLIDE, inserted after slide 7

On slide: the SAME chart from slide 3 — same axes, same dots, same question — now resolved.
- replay slide 3's question: *"how did their view on X change over time?"*
- this time the line is drawn as each observation arrives, in time order
- the point RAG dropped (the early baseline) is exactly the one that told the story
- conclusion: *"flipped from 👍 to 👎 over Q2"* ✓

Reference sketch — the answer to slide 3:

```text
same question: "how did their view on X change over time?"

ADAPT   ●➘──●➘──●➘──●➘──●➘──●         → "flipped from 👍 to 👎 over Q2"  ✓
        └ each observation updated the understanding, in order ┘
```

*Intent: the payoff. identical chart to slide 3, now resolved into the curve — that callback is the whole point, so keep axes/dots/question text identical. animate it building left→right as data arrives (matched pair with slide 3; see designer prompt). NOTE: this is a NEW slide between 7 and the existing slide 8 — do not renumber existing slides 8/9/10.*

## 8 — how the brain orchestrates + evolves

On slide: route → synthesize → evolve.
- inject fans out to every neuron (each self-filters); ask fans out, then synthesizes one answer
- evolution loop: **signal → evolve** — one agent looks at the neurons, their memories and the gaps, then creates / updates / merges / removes neurons
- plus internal neurons that track gaps + meta-knowledge

*Intent: this is slide 5's "reshapes itself" made real — the Brain as the thing that grows and reshapes the network. tie the evolve loop visually back to slide 5.*

## 9 — what it looks like

On slide: the code. three verbs glow.

```typescript
const brain = await Brain.create({
  prompt: 'Track my coding patterns and philosophy.',
})

await brain.inject(commits)              // data in
const { insight } = await brain.ask(     // question out
  'What is my coding philosophy?'
)

brain.onEvent(e => render(e))            // it tells you what it sees
```

caption: *no schema, no chunking, no index tuning.*

## 10 — let's watch it run

On slide: three labels → then live app.
- standups · product feedback · space exploration — each starts knowing nothing

*Intent: get off the slides, watch structure change live.*

---

### sources (slide 3 footnote)

- agent session usage — [DX 2025 impact report](https://getdx.com/blog/ai-assisted-engineering-q4-impact-report-2025/)
- context rot — [Chroma research](https://www.morphllm.com/context-rot)
- RAG fails trends — [arXiv 2507.22917](https://arxiv.org/html/2507.22917v1), [Nature s41597-025-06098-y](https://www.nature.com/articles/s41597-025-06098-y)
- token/cost per dev-day — [Claude Code costs](https://code.claude.com/docs/en/costs)
