# Leftover prompt on LFM3 (2026-11-13)

Question: can LFM3 find the lines in a batch that no neuron kept, given the data and the notes the neurons kept? (Approach 1 for per-input gaps; see `brain-evolution-smoke-lfm3-2026-11-13.md`.)
Script `evals/scripts/leftover-prompt-lfm3.ts`, OpenRouter `liquid/lfm-3-1.7b`, 2 runs, 22 calls.
Notes come from the real extract step. Expected answers written before the run. No LLM judge.
Raw: `evals/.data/leftover-prompt-lfm3/2026-11-13T16-31-13.720Z/`.

## Single entry per call

| Case | Expected | Run 1 | Run 2 |
|---|---|---|---|
| mixed-one-left (coding, food) | rain | ✓ | ~ rain + TypeScript (kept line repeated) |
| mixed-two-left (coding) | ramen, rain | ✓ | ✓ |
| all-kept (coding, food) | NONE | ✓ (empty reply) | ✗ ramen + oats repeated |
| six-lines (coding) | sushi, less meat, train | ~ all 3 + TypeScript repeated | ✓ |

## All 4 entries in one call (chunk)

| Run | Entry 1 | Entry 2 | Entry 3 (NONE) | Entry 4 |
|---|---|---|---|---|
| 1 | ✓ | ✓ | ✗ "rain" (copied from entry 1) | ✓ |
| 2 | ✓ | ✓ | ✓ | ✓ |

## What this says

- **No real leftover was ever missed** (12 of 12 expected lines found, single and chunk).
- **The error is false gaps:** a kept line comes back as left over, 3 of 8 single calls. It happens when the notes paraphrase the line ("Dinner: vegetarian ramen" vs the original sentence).
- **Chunking works at least as well:** 7 of 8 entries right, vs 5 of 8 single (counting the empty reply as NONE). One error was a line bleeding from a neighbour entry.
- An empty reply must count as NONE.

## Risk

A false gap of a kept line (e.g. "ramen" when a food neuron exists) could make evolution create a duplicate neuron. Evolution sees the active neurons, so it should leave it, but this is not tested.

## Next

If building: chunk by length, treat empty as NONE, then rerun the evolution smoke (`brain-evolution-smoke.ts`) to see that the food neuron is filled and no duplicate neuron is made.
