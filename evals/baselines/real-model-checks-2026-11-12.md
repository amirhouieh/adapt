# Real-model checks before release (2026-11-12)

## Doc examples (`npm run test:docs`)

All `tests/docs-code/*` files on `google/gemini-2.5-flash` (OpenRouter). The old default model `google/gemini-2.0-flash-001` is no longer on OpenRouter; the default in `evals/helpers/provider.ts` is now `gemini-2.5-flash`.

- First run: 10/11 files passed. `04-neurons.ts` failed on the `TextInput` example: `observedAt: '2026-11-10T09:00:00Z'` is refused; it must be exactly what `Date.toISOString()` gives (`...T09:00:00.000Z`). Docs and example fixed; `04-neurons.ts` then passed (31/31).

## Brain auto-setup on LFM3

[brain-auto-setup-smoke.ts](../scripts/brain-auto-setup-smoke.ts), `liquid/lfm-3-1.7b`, prompt "Track my coding preferences and my food habits.", same 12 inputs as `brain-two-step-smoke.ts`, evolution off. Data: [run](../.data/brain-auto-setup-smoke/2026-11-12T22-15-38.186Z).

- Decomposition with the smaller neuron schema works: 2 neurons, `coding-preferences` and `food-habits`, with clear "Watch for / Track answers to" instructions.
- Learning works: the off-topic batch (weather, train, movie) was dismissed by both neurons, stored, and fed to the gap neuron. Both memories are correct, including Prettier → Biome.
- `brain.ask()` crashed the first run: one neuron's query reply had no `gaps` field, the parse error was thrown, and `Promise.all` failed the whole ask. Fixed: a failed neuron query is now skipped (the neuron still emits `neuron:query:failed`). Second run answered correctly ("Biome", "mostly vegetarian").
- But in the second run the only queried neuron failed the same way (no `gaps`), so the answer came from the global-understanding neuron alone. **On LFM3 the neuron query reply leaves out `gaps` in both runs.** Making `gaps` optional is not a one-line fix: validation uses the same schema that is sent to the model, and OpenAI strict mode rejects optional fields.
- Neuron selection for the question "Which formatter does my team use now, and what do I eat?" picked only `food-habits`, not `coding-preferences`.

## After the fix: missing `gaps`

`generate()` now checks a reply against `repairSchema` when given (all callers passed the same schema as `output.schema`, so nothing else changes). The neuron query passes a copy where a missing `gaps` counts as `[]`; the model is still sent the strict schema with `gaps` required. Unit test: [neuron-query-gaps.test.ts](../../tests/neuron-query-gaps.test.ts).

- Probe, one neuron on LFM3, 3 questions: `gaps` present 3/3. So leaving it out is intermittent.
- Third auto-setup run ([run](../.data/brain-auto-setup-smoke/2026-11-12T22-21-14.957Z)): both neurons were selected and answered (`gaps` present in both), and the answer was correct ("Biome", oats). The lenient check was not needed in this run.
