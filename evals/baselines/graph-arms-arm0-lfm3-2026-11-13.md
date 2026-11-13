# Graph arms: pre-check and arm 0 (2026-11-13)

Question: do we need graph, and where? See `internal-docs/handoff-graph-arms-2026-11-13.md`.
Dataset: `evals/datasets/graph-arms.json` (30 inputs, 14 questions, written before any run).
Scored by hand against `expected` / `wrong`. No LLM judge.

## Pre-check: does the old graph code work on LFM3?

`evals/scripts/graph-learning-eval.ts` with `evals/config/graph-lfm3-local.json`
(LM Studio `lfm3-1.7b` Q8, local; this build reasons before answering, so max output was raised to 4096).
11 min, 9 model calls. Raw: `evals/.data/v2/graph-learning/2026-11-13T13-01-03.693Z/`.

| Stage | Result |
|---|---|
| initial | correct: ProjectA, ProjectB → one TeamX; quoted instruction ignored |
| correction | failed: both tries used all 4096 tokens on reasoning, empty answer |
| distinct-identity | wrong: ProjectC deferred as "ambiguous" instead of added |
| ambiguous-identity | failed: decision step ran out of tokens twice |

1 of 4. The graph code cannot be reused as-is for arm 1 on this model.
Not checked on OpenRouter (the local adapter has no API key support).

## Arm 0: text neurons only (today)

`evals/scripts/graph-arms-eval.ts`, OpenRouter `liquid/lfm-3-1.7b`, Brain with two text neurons
(kitchen, household), batches of 3, `brain.ask` per question.
Raw: `evals/.data/graph-arms/arm0-2026-11-13T13-12-07.476Z/` (`answers.md`, `result.json` with every call).

| Q | Scenarios | Result | Note |
|---|---|---|---|
| q01 spare key now | 1, 2 | wrong | says Alex Rowan; household memory merged the two Morgan Lees ("finance advisor … returned spare key") |
| q02 loan approver, still advisor? | 1, 2 | correct | trace of the merge: "phone 12" (house number) |
| q03 electrician's phone | 1, 3 | wrong | gives the coach's number |
| q04 coach = electrician? | 1, 3 | wrong | "yes, same person", though the input said not |
| q05 who repaired water damage | 2 | wrong | kitchen: De Vries crew; household: Lotte Visser. Answer shows both |
| q06 on leave in March | 2 | correct | |
| q07 contact now | 2 | correct | |
| q08 countertop + cost | 2 | correct | dates mixed up |
| q09 sockets | 2 | correct | 8, long answer |
| q10 cabinet maker's phone | 3 | correct | |
| q11 tap fixer in kitchen | 3 | correct | |
| q12 plumber's phone | 3, 4 | crash | Brain ask: neuron reply without `gaps` fails validation |
| q13 tiles + contact now | 4 | correct | |
| q14 who to call about tile | 3, 4 | correct | |

**Total 9/14.** By scenario: same name 1/4, who-did-what over time 5/7, across topics 3/6 (1 crash), two hops 2/3.

Cost: 56 learn calls, 75 ask calls (~5 per question), memory kitchen ~658 + household ~893 tokens, 574 s.

## What this says

- Arm 0 fails where graph is meant to help: **same name** (1/4). Both Mo Haddads and both Morgan Lees were merged.
- Across topics and two hops mostly work, because both neurons copy most facts (household holds most kitchen facts). That copying also caused q05: two neurons, two different answers.
- The bar for arms 1–3: beat 1/4 on same name without losing the 9/14.

## Open

- q12 crash is a bug (Brain ask still requires `gaps`), not a graph result. Fix before the next arm so all arms run the same code.
- One run each; LFM3 output varies run to run.
