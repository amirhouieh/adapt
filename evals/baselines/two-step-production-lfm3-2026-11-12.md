# Two-step as a v2 production procedure, LFM3 1.7B — 12 November 2026

## Verdict

**The production procedure matches the eval arm.** `adapt.text-procedure.two-step@1` runs through v2's real executor, coordinator and SQLite store. It sends exactly what the eval arm `twostep` sent, learns every task to the end, and costs the same.

- Two OpenRouter runs: 10 of 10 jobs learned every input (386 of 386 in the long tasks), with 0 failed steps, 0 cut-offs and 0 deferred runs.
- Every extract request was byte-identical to the eval arm's (50 of 50 compared). Any difference in memory comes from the model, not the procedure.
- Calls, time, cost and memory size are the same as the 4 eval-arm runs: 100 calls, about 23 minutes and about $0.065 per run. Memory stayed between 1,000 and 8,400 characters with no cap.
- The core facts held, with two exceptions the model varies on (see below). The known slips came back at the same rate.
- Local LM Studio (Q8 GGUF, thinking on): confirmed. All 5 tasks learned every input, with 0 failures, 0 cut-offs and the same 100 calls. Same core, same kind of slips.

## What was built

- `src/learning/text-procedures/two-step.ts`: recipe `adapt.text-procedure.two-step@1`, with one operation that makes at most two plain-text calls per run.
  1. extract: the `twostep` arm's prompt, word for word, with the lens purpose as the topic. If the reply is exactly `NONE`, the batch is consumed with no change and no second call.
  2. update: the `twostep` arm's prompt, word for word: the existing understanding (or "(none yet)") plus the extract. The reply becomes the new memory.
- No schema, no line selection, no compaction, and no memory-size rejection inside the procedure. The capacity check only asks whether both requests fit the loaded context. It reserves one output's worth for the extract.
- Developer instructions, if any, are added under the topic. They were empty in these runs, so the prompts are exactly the arm's.
- **Cut-off update or extract**: the run returns `defer`, and the batch's inputs stay in the durable pending queue. The coordinator retries after backoff (`retries.maxLogicalAttempts`). Inputs that arrive in the meantime join the same pending work, so the next attempt extracts them together and carries them into one update. This keeps the batch, durably, without new store state.
  - Deviation from the brief: the brief said to carry the *extracted text* forward. The store commits a run's inputs all at once and has nowhere to keep carried text, and adding that would be new machinery. Keeping the inputs pending carries the same information; the cost is one extra extract call. The SQLite test below shows a cut-off batch surviving, joining the next input, and committing.
- Not changed: the coordinator still refuses a narrative longer than `memory.maxCharacters`. That is a storage bound, set in config. These runs used 4 × the output limit (32,768 characters).
- Not supported: `governance.strategy` maps only onto line revision, so the coffee task's "switch to cumulative" step is recorded as not applicable for this arm. The scope change still runs.
- Tests: `tests/adaptive-text-two-step.test.ts` (10 tests). They cover the exact prompts, `NONE`, both cut-offs, other failures, no size rejection, the context fit, and one TextNeuron + SQLite test: cut-off → deferred → joined by a later input → committed → restored after reopen.

## Setup

- Arm `v2twostep` in [original-v1-qwen-comparison.ts](../scripts/original-v1-qwen-comparison.ts): the public `TextNeuron` in adaptive mode, the real coordinator and `SQLiteNeuronStore`, a reopen at each checkpoint, and the same 5 tasks and batches as the five-arm report.
- OpenRouter: `liquid/lfm-3-1.7b`, thinking mandatory, temperature 0, output limit 8,192, 2 provider retries, declared context 262,144. Config: `evals/config/original-v1-lfm3-openrouter-twostep.json`. No `requestBodyExtras`.
- Local: LM Studio `lfm3-1.7b` Q8_0, loaded at 32,768 context with 4 parallel slots. Thinking on, returned separately as `reasoning_content`, so nothing leaked into the answer. Output limit 8,192, no retries. Config: `evals/config/original-v1-lfm3-local-twostep.json`.
- Profile: batches of up to 8 inputs, retries 3 attempts with 1–4 s backoff, memory bound 32,768 characters.
- Raw data:
  - OpenRouter run 1: `evals/.data/two-step-production-lfm3-openrouter/2026-11-12T14-29-12.808Z`
  - OpenRouter run 2: `evals/.data/two-step-production-lfm3-openrouter/2026-11-12T14-29-48.239Z`
  - Local: `evals/.data/two-step-production-lfm3-local/2026-11-12T14-30-15.968Z`
- Eval-arm reference: the four `twostep` runs in `evals/.data/original-v1-lfm3-openrouter/2026-11-12T12-38-04.586Z` ([five-arm report](lfm3-five-arms-2026-11-12.md)).

## Mechanics

| Run | Calls | Minutes (summed) | Cost | Failed steps | Inputs learned | Memory chars (coffee, pref, personal, dev, therapist) |
|---|---:|---:|---:|---:|---|---|
| production r1 | 100 | 23.3 | $0.067 | 0 | all | 1,167 / 1,722 / 8,380 / 6,948 / 6,376 |
| production r2 | 100 | 23.0 | $0.064 | 0 | all | 1,067 / 2,526 / 6,017 / 8,144 / 6,927 |
| eval arm r1 | 100 | 22.6 | $0.067 | 1 (cut-off) | all but 8 | 1,227 / 1,893 / 9,391 / 8,482 / 5,691 |
| eval arm r2 | 100 | 22.5 | $0.064 | 0 | all | 1,586 / 2,296 / 6,176 / 9,393 / 5,480 |
| eval arm r3 | 100 | 22.9 | $0.065 | 0 | all | 896 / 1,719 / 5,509 / 8,738 / 7,502 |
| eval arm r4 | 100 | 21.7 | $0.063 | 0 | all | 1,366 / 2,004 / 9,064 / 8,362 / 6,419 |

Neither production run had a cut-off, so the defer-and-retry path was exercised only by the tests, not live.

## Core facts (OpenRouter, 2 production runs)

Held in both runs:

- Coffee: 200°F, 9 bars, 25–30 s, 1:2, 140–155°F, channeling, bean origins. Espresso only after the scope change: pour-over, French press and cold brew dropped.
- Preference: Google layoff, Stripe Staff Engineer, Nike, pescatarian because of B12, Samsung.
- Personal behavior: Alex, gym (with Sara), dentist, late nights.
- Developer: Biome, immutability, real databases / Docker Compose for integration tests, "simplicity is a feature".
- Therapist: CBT, ACT, ADHD, perfectionism, Asian-American focus, $300 sessions, burnout.

Missing where all 4 eval-arm runs had them:

- Developer: "monolith first" (0 of 2). Run 1's extract step left it out of one batch's extract, and its next update dropped it from another. Run 2 kept it through three updates, then the fourth dropped it.
- Personal behavior, run 2: Dave is never named. The DB-migration exchange is kept without his name.

Since the requests are identical, both gaps are the model varying from run to run, not the procedure. They do show that the "stable core" from 4 runs was a little too optimistic: a long whole-memory rewrite can still drop a fact.

## Known slips, how often

| Item | Production (of 2) | Eval arm (of 4) |
|---|---|---|
| Coffee: pour-over and French press kept after the espresso-only switch | 0 | 1 |
| Coffee: bean origins lost | 0 | 1 |
| Preference: vegan and pescatarian mixed up | 2 | 2 |
| Preference: stale "considering switching" next to the switch | 2 | 2 |
| Personal: progress stale (lecture 6 missing) | 1 | 2 |
| Personal: advice or to-do list written in | 1 | 2 |
| Developer: Prettier presented as current next to Biome | 2 | 2 |
| Developer: pagination regret | 0 (always missed) | 0 (always missed) |
| Therapist: "167 hours" garbled | 2 | 2 |

New single slips seen here: preference run 1 says the Samsung's screen cracked (it was the iPhone), and personal run 2 has "1:1s with Alex", as if Alex were the manager (Alex is the person).

## Local LM Studio (1 run)

| Task | Inputs | Calls | Failures | Memory chars | Minutes |
|---|---|---:|---:|---:|---:|
| coffee | 7/7 | 4 | 0 | 1,545 | 1.4 |
| preference-evolution | 24/24 | 6 | 0 | 1,650 | 4.4 |
| personal-behavior | 85/85 | 22 | 0 | 6,287 | 38.7 |
| developer-memory | 150/150 | 38 | 0 | 7,698 | 51.6 |
| therapist-profile | 120/120 | 30 | 0 | 5,278 | 40.4 |

- No cut-offs and no deferred runs. Reasoning comes back separately as `reasoning_content`, so the answers are clean plain text.
- It is slow: about 20 s per call with 4 jobs sharing the model (52 minutes for the longest task).
- Coffee: all espresso values exact, but pour-over and French press were kept after the espresso-only switch, and listed twice. This is the eval arm's 1-in-4 slip.
- Preference: same core (Google layoff, Stripe Staff Engineer, Nike, B12 → pescatarian, Samsung). Slips: stale "considering a more durable phone", and "lost it around Dec 15" (a job loss that never happened, also seen once in twostep2).
- Personal behavior: Dave, Sara, gym, dentist and late nights are kept, but the person is only "he", never Alex. Lecture 5 and lecture 6 are both stated as current. It adds advice ("Boundary suggestions", "concrete next steps").
- Developer: "monolith first", immutability, simplicity and integration tests kept. Prettier is recorded correctly as replaced by Biome. Pagination regret missed again.
- Therapist: CBT, ACT, ADHD, perfectionism, Asian-American focus, $300 and burnout kept. No "167 hours" garble this time.

## What this says

1. Two-step is now a real v2 procedure with v2's durability: atomic commit, pending queue, retry, reopen. It still makes 2 calls per batch.
2. It is much less code than line revision: one operation, two prompts, no selection, no compaction, no cap.
3. Its quality is the model's quality. Further gains will not come from the procedure's plumbing.

## Next steps

1. Remove the procedures two-step replaces (line revision, field revision, the narrative recipes) once nothing depends on them. `governance.strategy` should go with line revision.
2. Target the repeating slips (staleness, Prettier/Biome, the always-missed regret, dropped single facts) with structural changes, judged over several runs.

## Limits

- Two production runs on OpenRouter, plus one local run. Synthetic histories.
- Judged by reading stored memory against the source histories, plus keyword counts to find facts quickly. No scores.
- The cut-off path is covered by tests but did not happen live.
- One unrelated test fails in the full suite: `tests/v1-text-phases.test.ts` "invalid observation response" ("Compared values have no visual difference", a v1-baseline comparison). `tests/integration.test.ts` needs a key. Neither touches text procedures.
