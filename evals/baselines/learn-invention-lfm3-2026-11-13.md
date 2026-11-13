# Learn step: claims nobody said (LFM3, 2026-11-13)

Model `liquid/lfm-3-1.7b` on OpenRouter, temperature 0. Script: `evals/scripts/learn-invention-lfm3.ts`.
Raw: `evals/.data/learn-invention-lfm3/2026-11-13T17-*/report.md` (every extract and update output, per batch).

Two neurons, 3 batches each, one noise line per batch. 10 known facts:

- coding ("Track how I like to write code."): strict TypeScript, avoid `any`, vitest, pnpm not npm, kebab-case files, stopped classes → plain functions.
- food ("Track what I like to eat."): oats with banana for breakfast, trying to eat less meat, dinner was vegetarian ramen, want to try sushi this week, don't like spicy food.

Scored by hand on the final memory. **Invented** = a claim no input says. **Kept** = a fact still there with its meaning (e.g. "want to try sushi" written as "enjoys sushi" is not kept, and is invented).

## Where it happens

Both steps, in a chain:

1. **Extract** shrinks lines to nouns: "Dinner was vegetarian ramen. I want to try sushi" → `vegetarian ramen, sushi`. The meaning is gone. It also drops facts ("less meat", "don't like spicy" → `NONE`).
2. **Update** fills the gap with a guess: "enjoys vegetarian ramen and sushi", "sushi (plant-based, fits the goal of limiting meat)". It also adds general knowledge (what ramen is, "regularly", "exclusively", "full type system"), and misreads "avoid any." as cut off: "avoid any other languages".

## Change (src/learning/text-procedures/two-step.ts)

- Extract: "Reply with the extracted information only, in plain text**, keeping what the data says about each piece**."
- Update: "Update the understanding accordingly**, keeping their wording. Add nothing that neither of them says.**"

Tried on the way (3–6 runs each):

| Arm | Invented / run | Kept / 10 | Note |
|---|---|---|---|
| extract wording "as the data says it" only | — | — | no better; update still invented ("avoid other language features", what ramen is). Dropped. |
| update "Add nothing…" only | 1.7 | 6.8 | extract still gives nouns, update still guesses "likes sushi" |
| + extract "keeping what the data says about each piece" | 0.8 | 9.0 | food clean; "avoid other languages" 4 of 6 |
| + update "keeping their wording" (final) | 0.7 | 9.3 | "avoid any" misread 2 of 6 |

## Before vs after (6 runs each)

| Run | Before: invented | Before: kept | After: invented | After: kept |
|---|---|---|---|---|
| 1 | "like to eat oats and bananas"; "enjoy vegetarian ramen and sushi" | 4 | — | 10 |
| 2 | "likes: sushi"; "sushi … plant-based options that fit the goal" | 7 | — | 9 (spicy lost) |
| 3 | "enjoy or try vegetarian ramen and sushi" | 8 | "avoid any other type systems/languages"; "reduce or avoid meat" | 9 |
| 4 | "work exclusively in strict TypeScript" | 8 | — | 9 (spicy lost) |
| 5 | "normally have oats"; "enjoy or consume ramen and sushi" | 6 | "enjoy oatmeal with banana" | 10 |
| 6 | "usual breakfast"; "enjoy vegetarian ramen and sushi" | 7 | "avoid any non-strict features" | 9 |
| **Total** | **10** | **40/60** | **4** | **56/60** |

After, food memory reads like the inputs: "Breakfast: oats with banana. Goal: eating less meat. Dinner: vegetarian ramen. Plan: try sushi this week. I don't like spicy food."

## Still open

- "avoid any." (no backticks) is still read as "avoid any other …" in 2 of 6. Same case as the brain smoke run. Prompt wording only halves it.
- Extract still says `NONE` for "I don't like spicy food." + a noise line, 2 of 6 (before: 3 of 6). Extract miss, not invention.
- 6 runs per arm, one small input set. LFM3 varies run to run.
