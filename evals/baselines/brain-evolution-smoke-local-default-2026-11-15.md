# Evolution smoke on the local default (2026-11-15)

First run through the new default: `localModel()` = LFM3 (`lfm3-1.7b`) on LM Studio at `http://localhost:1234/v1`, through the default AI SDK plugin (no `providers`, no key).
Run: `LOCAL=1 npx tsx evals/scripts/brain-evolution-smoke.ts`. `evolve()` called by hand, batches of 3.
Raw: `evals/.data/brain-evolution-smoke/2026-11-15T16-33-34.896Z/result.json`. 1003 s, 54 calls. No LLM judge.

## A: only a coding neuron; food and noise inputs come in

| Expected | Result |
|---|---|
| One food neuron created | ✓ `food` created (then updated) |
| No neuron for weather, trains, movies | ✓ none |
| Food neuron holds ramen, vegetarian, oats, sushi after the gap retry | ✓ all four |

## B: coding, typescript-style (overlap) and food

| Expected | Result |
|---|---|
| coding and typescript-style merged, or nothing changes | ✓ nothing changed |
| Food not removed | ✓ kept |

Tools, structured output and the evolution loop all work against LM Studio with the default config. Slow on this Mac (about 17 min for both scenarios, vs 90 s on OpenRouter).
