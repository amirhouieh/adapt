# Evolution loop smoke on LFM3 (2026-11-13)

First real-model run of the simplified evolution loop (`src/brain/evolution.ts`).
Script `evals/scripts/brain-evolution-smoke.ts`, OpenRouter `liquid/lfm-3-1.7b`, `evolve()` called by hand, batches of 3.
Raw: `evals/.data/brain-evolution-smoke/2026-11-13T14-40-34.380Z/result.json`. 90 s, 41 calls. No LLM judge.

## A: only a coding neuron; food and noise inputs come in

| Expected | Result |
|---|---|
| One food neuron created | ✓ `food-habits` created |
| No neuron for weather, trains, movies | ✓ none |
| Food neuron holds ramen, vegetarian, oats, sushi after the gap retry | ✗ **empty** |

Why empty: no batch was a gap. Every batch of 3 had one coding line, so the coding neuron took each batch and only extracted the coding part. The food lines were dropped, never stored as dismissed batches (`signalCount: 0`). The loop created the food neuron from the brain prompt alone, then had nothing to retry.

**Finding: inputs are lost when they arrive in a batch that some neuron takes for another reason.** Gaps are counted per batch, not per input.

## B: coding and typescript-style overlap, plus food

| Expected | Result |
|---|---|
| Merge coding + typescript-style, or no change | ~ no merge; "updated" all three neurons with the same configs (no real change) |
| Food not removed | ✓ |

The loop calls `updateNeuron` on every neuron even when nothing changes. Harmless, but each one shows up as a change.

## Other

- LFM3 memories add things that were not said ("every variable must be explicitly annotated", "never use optional chaining"). That's the learn step, not evolution.

## Open

1. Per-input gaps: how should Brain notice lines no neuron kept when the batch was taken? Design decision.
2. Count an update as a change only when the config really changed.

## Rerun after leftover gaps (eccc250)

Raw: `evals/.data/brain-evolution-smoke/2026-11-13T16-48-33.320Z/` (`calls.json` has every call).

- **Gap detection works.** The leftover call listed all food and noise lines from the 3 mixed batches, and no kept line (`signalCount: 1`).
- **A ✗: the food neuron is created, then removed in the same run.** Inside the run, `readMemory` on the new neuron says "(empty)", because gap inputs are fed only after the run. LFM3 then removes it as useless. Seen in 2 of 2 runs.
- **Bug:** after `removeNeuron`, creating the same id fails with "Neuron already exists in this store" (its store is not cleared).
- **B ✓:** no change, and no fake updates reported.

## After fixes (2144e46 + instructions wording)

1. 2144e46: `readMemory`/`createNeuron` tell the model a new neuron learns the gap inputs when the run ends; `removeNeuron` clears the neuron's data.
   Rerun: food neuron kept and filled, but its `instructions` held the gap lines word for word (weather, train), so it learned them too. In B the model pasted facts into all three neurons' instructions.
2. Instructions wording (schema + evolution prompt): "name the topic only, never copy facts, inputs or memory into it".
   Rerun `evals/.data/brain-evolution-smoke/2026-11-13T16-54-43.391Z/`:
   - **A ✓** `food_habits` created and kept; instructions name the topic; memory holds oats, ramen, sushi, less meat; no weather or train. Coding unchanged.
   - **B ✓** no change.
   One run each.

## 3 more runs at edd3079

Raw: `evals/.data/brain-evolution-smoke/2026-11-13T17-22-05.591Z/`, `…17-25-07.439Z/`, `…17-27-22.460Z/`.

| Run | A (create from gaps) | B (overlap) |
|---|---|---|
| 1 | ✓ `food` created, 4 food facts, no noise neurons | ✓ no change |
| 2 | ✓ `food` created, 4 food facts | ✓ no change |
| 3 | ✓ `food-habits` created, 4 food facts | ~ `typescript-style` removed (not merged); `coding` already held its facts, so nothing lost |

- Evolution itself held up: 3/3 A, 3/3 B with no data loss. No neuron for weather, trains or movies.
- Run 2: `food` instructions copied facts again ("breakfast (oats with banana), dinner (vegetarian ramen)…"). The topic-only rule is not always followed.
- Run 3 B: the model's reasoning says "merged" but it called `removeNeuron`, and claims `food` holds the integration-tests fact (it does not). Its reasoning text can't be trusted; read `changes`.
- Learn step adds things not said, every run: "avoids any other languages, frameworks" (runs 1, 3), "full type annotations" (run 2), "you previously mentioned wanting to try sushi with salmon" (run 2).
- Kebab-case ids in all 3 runs (`food`, `food-habits`).
