# LFM3 1.7B: five ways to learn, same five tasks — 12 November 2026

## Verdict

**Two-step wins on LFM3.** Step 1 extracts what is relevant to the topic; step 2 updates the understanding with it. Plain text, no JSON.

- It learned across every task to the end, with 1 failed step in 100 calls.
- It was the fastest (23 min total) and the cheapest ($0.07 total).
- Its memories are real understanding: organised, mostly current, and grounded.

**v2 does not work on LFM3 today.** Its memory cap blocks learning once memory is full. In the three long tasks it never learned 235 of 386 inputs.

**Bare rewrite does not work.** It copies the raw logs instead of learning, then stops once memory gets long.

**v1 works, but compresses too hard.** Short memories that lose whole topics.

**d1.1 helps v2 but cannot save it.** It halves v2's calls and fixed one scope mistake. The cap still blocks learning.

## The five arms

| Arm | What it does |
|---|---|
| v1 | Original Adapt: observe a batch, then update the understanding. Structured output. |
| v2 | Current v2 line revision: per input, relevance check, then edit selected memory lines. 10,000-character cap. |
| v2d1 | v2, but each relevance check is answered by Liquid's decision model `liquid/d1.1` (YES when P ≥ 0.5). |
| bare | One plain-text prompt per batch: purpose + whole memory + new inputs → complete new memory. |
| twostep | Per batch: (1) "extract whatever valuable and relevant information it has related to this topic", (2) "here is information extracted about this topic and here is our existing understanding; update the understanding accordingly". Plain text. |

Scripts: [bare-text-arm.ts](../scripts/bare-text-arm.ts) (bare, twostep), [original-v1-qwen-comparison.ts](../scripts/original-v1-qwen-comparison.ts) (v1, v2, v2d1).

## Setup

- Model: `liquid/lfm-3-1.7b` on OpenRouter, served by Liquid at fp8, 256K context. Decision model: `liquid/d1.1`.
- Liquid's endpoint makes thinking mandatory and ignores every cap (`effort: low/minimal`, `max_tokens`). All arms ran with thinking on.
- Temperature 0, output limit 8,192 tokens (the endpoint's maximum), 2 provider retries.
- v2's declared context was the model's native 262,144 tokens.
- Same five original v1 tasks and batches as the 3 November Qwen and Gemini comparisons. Memory only; no query answers.
- One run per arm and task. Synthetic histories.
- Raw data: [`evals/.data/original-v1-lfm3-openrouter/2026-11-12T12-38-04.586Z`](../.data/original-v1-lfm3-openrouter/2026-11-12T12-38-04.586Z) (`config/original-v1-lfm3-openrouter.json`).

## Mechanics

| Arm | Calls | Minutes | Cost | Failed steps | Inputs never learned (long tasks) |
|---|---:|---:|---:|---:|---:|
| v1 | 101 | 36 | $0.09 | 4 (output cut off) | — |
| v2 | 833 | 90 | $0.21 | 0 reported | 235 of 386 (`memory_capacity`) |
| v2d1 | 439 | 80 | $0.19 | 0 reported | 243 of 386 (`memory_capacity`) |
| bare | 50 | 27 | $0.08 | 30 (output cut off) | most of developer, therapist, behavior |
| twostep | 100 | 23 | $0.07 | 1 (output cut off) | 8 (one batch) |

v2 per task, inputs never learned: personal-behavior 53/85, developer-memory 86/150, therapist-profile 96/120. Each batch after memory reached the 10,000-character cap was rejected whole. This is the same capacity deadlock seen on Gemini on 3 November.

Bare: thinking writes the whole memory as a draft, then writes it again. Once memory passes about 14,000 characters, the 8,192-token budget goes entirely to thinking and nothing is saved.

Two-step memory size stayed between about 6,000 and 9,000 characters without any cap: the update step compresses on its own.

## What each arm learned

### Coffee

- **twostep**: after the switch to espresso, kept only espresso, beans and milk; dropped pour-over, French press and cold brew as instructed. Values exact (200°F, 9 bar, 25–30 s, 1:2, 140–155°F). Small additions not in the source: "≈93 °C", "like powdered sugar".
- **v2d1**: d1 rejected cold brew (P = 0.01) after the scope change. Kept pour-over. All espresso facts exact.
- **v2**: kept pour-over and French press; lost bean origins.
- **bare**: kept everything, no scope change, plus the comment "Pour-over and French press details remain as previously described."
- **v1**: espresso core only; lost milk and beans; adds an unsupported explanation of "solubility".

### Preference evolution (Robbie)

- **twostep**: one integrated story of the changes: laid off from Google → Stripe Staff Engineer; Adidas fell apart → Nike convert; B12 → pescatarian; cracked iPhone screens → Samsung. Keeps why each change happened. Errors: "pescatarian/vegan diet", "although he misses Google" (not in source), and a stale "seriously considering switching" next to the switch.
- **v2 / v2d1**: many correct facts but as an unordered list where old and new beliefs sit side by side: "only wears Adidas shoes and loves them", "prefers the iPhone", "this veganism is the best decision" alongside Nike, Samsung and pescatarian. v2d1 adds wrong facts ("moving away from his long-time use of Nike Pegasus 41", job loss dated 15 December).
- **bare**: the 24 source messages copied word for word.
- **v1**: only shoes and the Stripe job; diet and phone changes are gone.

### Developer memory (150 events)

- **twostep**: the strongest profile. Organised principles from the whole stream: YAGNI and monolith-until-needed, strict TypeScript, Result types, early returns and guard clauses, naming rules, immutability and spread over `Object.assign`, real databases in integration tests, observability, and the closing "simplicity is a feature… ship it". Problems: keeps Prettier as current alongside Biome, some duplicates (GraphQL rejected twice), garbled phrases ("use them only in intentional test mocks"), and misses the pagination regret. One batch (inputs 97–104) lost to a cut-off update.
- **v1**: covers the late material (naming, guard clauses, spread, v1.0.0, reflections) in 1,650 characters; much thinner.
- **v2 / v2d1**: blocked by capacity from input 57 / 41; one later batch got through, and nothing after input 72 / 56 was learned. Memory reads as dated commit records.
- **bare**: raw event log copied in, then stalled at input 96.

### Therapist profile (120 events)

- **twostep**: a full, organised profile: credentials, philosophy, CBT/ACT/somatic methods, ADHD strategies, cultural work ("traditional practices when requested" — the client's lead is preserved), boundaries, fees, logistics. Errors: "Sessions total about 167 hours per week" (garbled), RSD mislabelled as "Reaction to Perceived Criticism/Rejection".
- **v1**: a short generic summary plus testimonials; the same "167 hours per week" garble.
- **v2 / v2d1**: stopped learning at input 24 of 120.
- **bare**: stalled at input 64.

### Personal behavior (85 events)

- **twostep**: captures the core patterns (late-night spirals, career talk without action, gym with Sara, the 28 October "talk about growth" step, the anxiety-driven admission, Dave frustration). Weaknesses: much of it is a dated diary of early September; some progress is stale ("aim to finish lecture 4" when he reached 6); it adds a "Suggested next steps" advice list nobody asked for.
- **v1**: current and compact (lecture 6, gym three times) but with errors: "transitioning to product management", promotion email "to Tom", apologised "to Sara for harshness".
- **v2 / v2d1**: stopped learning at input 32 / 40.
- **bare**: stalled after input 24.

## What d1.1 changed

- Halved v2's model calls (833 → 439) at almost no cost (about $0.000003 per decision).
- Fixed the cold-brew scope error in coffee.
- Did not change v2's main failure: the capacity deadlock happens after relevance.

## What this says

1. The idea is fine; v2's machinery is the problem on this model. Its narrow per-input steps, line selection and hard cap cause most of the losses.
2. Your two-step framing — extract, then update — is the simplest design that learned well here.
3. Plain text works when each call has one clear job. One prompt doing both jobs ("bare") copied instead of learning.
4. A whole-memory rewrite only works while the thing being rewritten stays small. Two-step stays small because it rewrites a distilled understanding, not raw data.

## Next steps

1. Make two-step the base and fix its visible weaknesses:
   - stale beliefs kept next to new ones (Prettier/Biome, iPhone);
   - unrequested advice sections and diary-style lists;
   - the one cut-off update (retry it instead of dropping the batch).
2. Put d1.1 in front of step 1 as a cheap "anything relevant?" gate.
3. Run two-step locally on LM Studio (thinking on) to confirm it holds on the downloaded Q8 model.

## Follow-up: fixing two-step, and a d1.1 gate (same day)

Two more arms, same suite and settings ([bare-text-arm.ts](../scripts/bare-text-arm.ts)):

- **twostep2**: the update prompt adds three rules: replace outdated statements and note what changed; no advice or suggestions; an understanding, not a dated list of events. Extracted information whose update fails is carried into the next update instead of being dropped.
- **twostep2d1**: twostep2, with each input first passing a `liquid/d1.1` relevance decision (kept when P ≥ 0.5).

Mechanics: both arms ran all five tasks with 0 failed steps. Calls, time and cost were the same as twostep (about $0.07 per arm).

### The extra rules made fidelity worse

The advice sections and diary-style lists are gone. Some stale statements were replaced (iPhone → Samsung is now told as a change). But the smoother prose invented things the source never says:

- Preference: "announced his departure from Stripe" around 15 December, and "participates in marathons; personal best marathon distance was 10 km".
- Personal behavior: the person is called "Maria" (Maria is a friend; the person is Alex) and "shifting from product-manager".
- Developer: "the code throws on failures", the opposite of the source's explicit-returns rule.

This is one run each, so some of the difference may be run-to-run noise. The direction matches the earlier lesson, though: more rules in the prompt, more drift.

### d1.1 as a hard gate loses useful content

At P ≥ 0.5, d1.1 dropped:

- in therapist-profile, 19 inputs, including her posts on RSD, time blindness, imposter syndrome and decision fatigue (P 0.05–0.42);
- in developer-memory, 24 inputs, mostly bare commits, but also the "GitHub Actions — we're on GitHub" decision;
- in personal-behavior, the dentist reschedule, which is an avoidance signal.

It saved no model calls, because every batch still had at least one relevant input. The extract step already filters. **Keep d1.1 out of the learning path**; it fits decisions such as routing an input to the right neuron, or spotting text that tries to control the memory.

### Run-to-run noise: the original two-step, four runs

The original two-step ran three more times (`twostep-r2`, `-r3`, `-r4`), same prompts and settings. All 20 jobs finished; the only failed step across the four runs is the one cut-off update in run 1 of developer-memory.

Stable in all four runs (the core is reliable):

- Coffee: 200°F, 9 bars, 25–30 s, 1:2, 140–155°F, channeling; cold brew excluded.
- Preference: Stripe, Nike, pescatarian because of B12, Samsung, the Google layoff.
- Personal behavior: Alex, Dave, gym, dentist, late nights.
- Developer: Biome, immutability, integration tests with real databases, monolith/YAGNI, naming rules, "ship it".
- Therapist: CBT, ACT, ADHD, perfectionism, Asian-American focus, $300 sessions, burnout.

Varies between runs (small errors, a different mix each run):

| Item | Runs out of 4 |
|---|---|
| Coffee: pour-over and French press kept after the espresso-only switch | 1 |
| Coffee: bean origins lost | 1 |
| Preference: "pescatarian/vegan" mixed up | 2 |
| Preference: stale "considering switching" next to the switch | 2 |
| Personal: progress stale (lecture 6 missing) | 2 |
| Personal: advice or "next steps" written in | 2 |
| Developer: Prettier presented as current next to Biome | 2 |
| Developer: pagination regret | 0 (always missed) |
| Therapist: "167 hours" garbled | 2 |

Not seen in any of the four original runs, but seen in the single twostep2 run: the wrong name ("Maria"), marathons, "throws on failures". Those three errors are most likely caused by twostep2's added rules.

So each run has a few small, random errors on top of a stable core. Chasing them one at a time with prompt rules mostly chases noise.

### Updated recommendation

- Keep the original two-step prompts.
- Judge any future change over several runs, never one.
- Target the errors that repeat (staleness in 2 of 4 runs, missed regrets), not single slips. Prefer structural fixes over more prompt rules.
- Next: move two-step into v2's real pipeline (store, restart, recovery), and confirm it on the local LFM3 model.

## Limits

- One run per arm and task; differences in single sentences may not repeat.
- Judged by reading stored memory against the source histories; no scores.
- Thinking is on for all arms here because Liquid's endpoint requires it. The 3 November local runs had thinking off.
- The incomplete local LFM3 run (Q8 GGUF, thinking off for v1/v2) is kept at `evals/.data/original-v1-lfm3/2026-11-12T11-47-36.141Z` as a reference only.
