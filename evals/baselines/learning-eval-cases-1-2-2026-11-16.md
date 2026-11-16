# Learning eval, cases 1 and 2: today's adapt vs full context (LFM3, 2026-11-16)

## Verdict

**Full context passes. Today's adapt fails.** This is the second branch of the C verdict: the claim has to move to long streams and storage before anything is built. On a 30-day stream, the same 1.7B model reading all raw notes answers every cell right, and its answer moves with the rate.

## Setup

- Model: `lfm3-1.7b` on local LM Studio (`localhost:1234`), on-device. Reloaded with a 32k context (it was 8k; the full-context arm overflowed it). No OpenRouter.
- Script: `evals/scripts/learning-eval-cases-1-2.ts` (generator plus runner). Raw logs: `evals/.data/learning-eval-cases-1-2/<timestamp>/`.
- Stream: 30 days of dated notes (`Mon 2026-10-05 07:40: ...`), 1 to 2 unrelated notes per day, the target on N distinct days. The habit is never stated.
  - Case 1: coffee in the morning on 2, 8 or 22 days.
  - Case 2: sushi dinner on 1 or 10 days.
- Arms, same question text:
  - **adapt**: `Brain.create` (autoSetup, evolution off) → `inject(all notes)` → `flush()` every neuron → `ask`.
  - **full**: one chat call with all notes plus the question.
- Scoring: forced choice, options shuffled per run, the model answers with a letter, exact match. No LLM judge. Chance: case 1 is 1/5 (never / rarely / sometimes / most days / not known), case 2 is 1/3 (regularly / once / never mentioned).
- Runs: **1 per cell**, plus one rerun of the two sushi cells for adapt (see "Infra"). Amir asked for lean runs instead of 4.

## Results

| Cell | Gold | Full context | adapt | Target lines in adapt memory |
|---|---|---|---|---|
| coffee, 2 days | rarely | **rarely** ✓ | not known ✗ | 2 of 2 |
| coffee, 8 days | sometimes | **sometimes** ✓ | not known ✗ | 1 of 8 |
| coffee, 22 days | most days | **most days** ✓ | most days ✓ | 13 of 22 |
| sushi, 1 day | tried once | **tried once** ✓ | never mentioned ✗ | 0 of 1 |
| sushi, 10 days | regularly | **regularly** ✓ | tried once ✗ | 3 lines, 2 days, of 10 |

- Full context: 5 of 5. Both curves move with the rate.
- adapt: 1 of 5 (chance would be about 1.2). The one pass is the high-rate cell, where 13 coffee lines were still in memory.
- Stored size: full context keeps 3.4–4.3 KB of raw notes. adapt keeps 1.3–2.6 KB.

## What adapt's memory looks like

It is a dated diary, not an understanding: copied note lines (`Mon 2026-10-05 07:40 Walked the long way to the office`). No line ever says "coffee most mornings" or "sushi often". So today's adapt does recall badly, and does not learn the pattern either.

It also misses most of the stream:
- coffee-8: batch 1 was `deferred` (a failed run waits for a retry), batches 2 and 3 stayed queued, and `flush()` ran nothing. Memory covers only 5 to 15 Oct.
- coffee-2: every batch was learned, but memory ends on 23 Oct. The last week was dropped in the rewrite.
- sushi-10: the first batch was learned, and the next three stayed queued.

## Infra (not results)

- First parallel batch (4 cells at once): coffee-2 and coffee-8 adapt ended with empty memory, and full context hit Node's 300 s fetch timeout while the model was reasoning. Those runs were thrown out. Fixes: stream the full-context reply, log the `flush` output, and run at most 2 cells at a time. coffee-2 and coffee-8 were rerun.
- The sushi cells first ran in that same batch. adapt's sushi-1 "pass" came with no sushi in memory, so it was a guess. Both sushi cells were rerun once for adapt; the table shows the rerun.
- LFM3 reasons for 2,400–9,700 tokens before answering in full context (75–300 s per call).
- One adapt run takes 13–57 min.

## What this means for C

1. On short streams, plain recall on the same model already passes cases 1 and 2. So "learns patterns a summary can't" is not shown at 30 days. The next test needs a long stream (90+ days, mixed topics), where full context stops fitting or breaks, with stored bytes reported per arm.
2. Today's adapt fails because it keeps a diary that loses part of the stream, not because it summarizes. The deferred and queued runs that `flush()` does not drain are a separate bug worth a look before any ledger work.
