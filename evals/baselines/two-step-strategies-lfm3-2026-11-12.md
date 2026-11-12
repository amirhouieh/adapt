# Memory strategies on LFM3 (2 runs)

Question: when a neuron's memory grows past `maxTokens`, do `cumulative` and `decay` really run, and what do they do to the memory?

- Script: [two-step-strategies-lfm3.ts](../scripts/two-step-strategies-lfm3.ts). `liquid/lfm-3-1.7b` on OpenRouter. Three standalone `TextNeuron`s (continuous = control, cumulative, decay), same 24 dated facts (kitchen renovation, with changes), batches of 4, `maxTokens` 300.
- Every model call is logged, so the memory right before the strategy (update output) and right after (strategy output) can be read against the inputs. No LLM judge.
- Data: [r1](../.data/two-step-strategies-lfm3/2026-11-12T19-59-37.700Z), [r2](../.data/two-step-strategies-lfm3/2026-11-12T20-06-39.846Z). Read `<strategy>.md` in each.

## Did they run?

| | r1 | r2 |
|---|---|---|
| cumulative | ran batches 2–6 | ran batches 3–6 |
| decay | ran batch 3, **returned empty text** (40 s) → run failed | ran batches 3–6 |
| final memory (est. tokens): continuous / cumulative / decay | 739 / 348 / — | 786 / 368 / 297 |

r1 decay is not usable: after the failure, `learn()` returned `managed` and queued the next inputs behind the retry, and the script disposed the neuron before the retry ran (fixed in the script for r2).

## Size

Neither strategy gets the memory under the limit. Target is ~210 tokens (70% of 300); outputs were 296–440 tokens. So the strategy fires again on every later batch (one extra call per batch). The memory stays around 1–1.5× `maxTokens`, against ~2.5× for continuous.

## Before vs after, against the inputs

Facts lost were mostly lost in the **update** step, not by compression (Bosch oven lost in cumulative r1 batch 6 update and decay r2 batch 5 update; carpenter name lost in cumulative r1 batch 5 update).

The **strategy** step adds things that are not in the inputs, and they stay:

- cumulative r1: "six sockets need separate approval" (batch 4 seed; input: 6 + 2 done) and "sign-off from both trade leads" (batch 5) — both in the final memory. Batch 2 seed also wrote about itself ("As a learning agent, I notice a repeatable workflow").
- cumulative r2: "60 m² grey tiles" (input: 60x60 tiles), "€1,100 repair plus a €19,500 top-up" (input: budget raised *to* 19,500), which became "budget exceeds target by ≈€20–30k" in the final memory. Every seed adds "Key insight / Lessons / Action items" (advice nobody gave).
- decay r2: "kitchen runs smoothly; all systems tested and approved; no further maintenance required" (batch 4), "project kicked off February" (batch 6; it started in January).

Kept well by both: budget path to €20,300, Ruud Smit replacing Pieter, granite countertop, paint, fridge, inspection passed, cracked tile.

Continuous (control) final memory had almost every fact and no invented advice.

## Reliability

The strategy call sets no output limit. LFM3 used 5–7k output tokens of thinking per decay call (3 extra probe calls on r1's batch 3 memory: all ok, 21–31 s). 1 of 8 decay calls returned empty text; the strategy then throws and the whole run is retried later.

## Conclusion

Both strategies run on LFM3 and keep the memory far smaller than continuous. But on this model the compression step (1) does not reach its size target, so it runs every batch, and (2) adds invented facts and advice that then stay in memory. Continuous was the most accurate memory here.

## After the fix: strategy output limit

The strategy call now uses the update step's output limit (8192), and, like the update step, rejects a reply that is not `finish: stop` or is empty.

- 10 decay calls on r1's batch 3 memory: 9 ok (4–8k output tokens, 15–34 s), 1 hit the limit (`finish: length`) and returned 662 chars of **cut-off text**. Before this fix such text was saved as memory; now it is rejected.
- [r3](../.data/two-step-strategies-lfm3/2026-11-12T20-33-35.045Z) (decay + cumulative, 24 inputs): decay replied empty twice (batches 2 and 3). Both were rejected and retried; all 24 inputs were learned and no cut-off memory was saved.

So the limit does not stop LFM3 from sometimes thinking until it runs out. It makes the failure safe: reject, retry, never save a half memory.
