# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.0.6] - 2026-05-18

### Changed

- **Honest instructions.** Developer `instructions` now reach the runtime observe and understand prompts **verbatim**, instead of being LLM-compressed into a short identity blurb. Runtime prompts are assembled deterministically in three layers — a static framework role frame, the verbatim developer instructions, and framework mechanics (JSON envelope, importance scale, cognitive skills) last — with no LLM call. Observe identity generation and list-neuron understand identity generation are removed; text neurons keep a slimmed cognitive-skill customization call. The derived `domain` dismissal gate is dropped — relevance now rests on the verbatim instructions. Closes [#17](https://github.com/unbody-io/adapt/issues/17) and [#18](https://github.com/unbody-io/adapt/issues/18).
- Neurons restored from a pre-0.0.6 store recompute their observe/understand prompts from structured state on restore, so legacy persisted prompts are replaced with the new 3-layer prompts deterministically (no LLM call).

### Added

- Optional per-phase instruction overrides — `observeInstructions` and `understandInstructions` on neuron configs and generated neuron configs. The shared `instructions` field remains the fallback when a phase-specific field is omitted; `focus` stays observe-only.
- `skipUnderstand` — observer-only neurons. A neuron created with `skipUnderstand: true` runs the observe phase and retains observations but never synthesizes understanding, even under `forceSynthesize`. Symmetric to `skipObservation`. Closes [#20](https://github.com/unbody-io/adapt/issues/20).
- `onEvent` pre-init subscription hook on `Brain.create` / `Brain.restore` and `TextNeuron` / `ListNeuron` `create` / `restore`. The handler is attached before initialization runs, so `init` events are observable through the public API without bypassing private constructors. Closes [#19](https://github.com/unbody-io/adapt/issues/19).

### Fixed

- `skipUnderstand` neurons no longer rebuild an understand prompt when `update()` changes `instructions` in the same call.

## [0.0.5] - 2026-05-06

### Changed

- **Breaking:** `Brain.create(config)` / `Brain.restore(pathOrStore)` replace `new Brain(...) + initialize()`. Constructors are private.
- **Breaking:** Standalone neurons get the same shape: `TextNeuron.create(config)` / `TextNeuron.restore(pathOrStore, {id?})` and `ListNeuron.create(config)` / `ListNeuron.restore(pathOrStore, {id?})` replace `new TextNeuron(...) + init()` / `new ListNeuron(...) + init()`. Constructors are private.
- **Breaking:** Per-neuron persistence resolves through `BrainStore.getNeuronStore(neuronId)`. The `BrainConfig.learning.store` factory is removed. Stores from prior versions are not compatible.
- Models persist as `{provider, modelId}` refs and rehydrate through a per-instance LLM plugin — no more Gateway-string fallback. The default AI SDK plugin (`createAiSdkLLM`) ships with Adapt; pass a custom `llm` to `Brain.create` / `Brain.restore` (and the equivalent `TextNeuron` / `ListNeuron` factories) to use a different runtime.
- **Breaking:** Streaming is now plugin-symmetric. `brain.askStream` / `neuron.queryStream` / `brain.evaluateEvolutionStream` return `Promise<AdaptStreamResult>` instead of AI SDK's `StreamTextResult`. The plugin contract gains a fully-typed `streamCall(request) → Promise<AdaptStreamResult>` mirror of `call`. AI SDK is no longer privileged on the streaming path; any plugin implementing `streamCall` works for streaming. Common consumer surface (`textStream`, `fullStream`, `text`, `usage`, `toolCalls`, `steps`) preserved 1:1.
- **Plugin contract formalized.** `AdaptLLMPlugin` now documents an explicit error contract: structured-output failures (malformed JSON, missing fields, raw text) must be returned as `{ text, json: undefined, finishReason: 'error' }` — *not* thrown. Throws are reserved for transport / auth / system errors. Adapt's core runs the repair pipeline whenever `json` is undefined and the request asked for structured output. The default AI SDK plugin now follows this contract internally (catches `NoObjectGeneratedError`, surfaces `error.text`); core no longer references AI-SDK-specific error types.
- Deep-mode synthesis split into two phases (gather → synthesize) to avoid the Gemini Flash strict-schema tool-call loop.
- Runtime `'ai'` imports consolidated into `src/llm/index.ts`.
- Internal Zod schemas use `.nullable()` instead of `.optional()` so structured output works on OpenAI's strict mode. List-neuron `addItem` / `updateItem` falls back to a relaxed schema when no user `understandingSchema` is provided (OpenAI's strict mode rejects `z.record(...)`).
- JSON repair pipeline replaced with a layered approach: Adapt's envelope-cleaning steps (chain-of-thought preamble stripping, double-brace fix) run first, then [`jsonrepair`](https://github.com/josdejong/jsonrepair) handles syntactic recovery (single quotes, trailing commas, missing braces, comments, markdown fences, raw newlines in strings). Coverage went from 8/19 → 18/19 on a representative sample (see `evals/scripts/json-repair-comparison.ts`); ~80 lines of bespoke regex/state-machine code replaced by one library call.

### Added

- BYO LLM runtime via the `AdaptLLMPlugin` contract — pass `llm` to `Brain.create` / `Brain.restore` / `TextNeuron.*` / `ListNeuron.*` to swap the runtime. Closes [#9](https://github.com/unbody-io/adapt/issues/9).
- Public types `AdaptStreamResult` and `AdaptModelStreamEvent` exported from the package root — typed surface for streaming consumers, regardless of which plugin is active.
- `AdaptStreamResult` gains an optional `output: Promise<TJson>` field, populated by core when the request specified a structured output schema. Resolves *after* the stream finalizes, by running the repair pipeline on the resolved `text` and validating against the schema. Mid-stream JSON is left untouched (partial JSON is unrepairable). Plugins do not need to populate this field — core wraps the result.
- Opt-in structured-output retry with feedback: pass `repairWithFeedback` (and optionally `maxRepairAttempts`, default 1, capped at 3) on a `generate()` / `streamText()` request, `Brain.create()` config, or restore runtime options. Core still runs the layered repair pipeline first; the hook only fires after repaired JSON fails Zod validation, receives the raw text plus the validation error/schema/model request context, and returns replacement text for one more repair + validation pass. Streaming applies this after the stream finalizes via `AdaptStreamResult.output`.
- CJS build for Electron and CommonJS consumers.
- Observation API on `BaseNeuron`: `getObservations`, `setObservations`, `updateObservation`, `removeObservation`.
- Neuron pause/resume: `brain.pauseNeuron(id)`, `brain.resumeNeuron(id)`, `brain.getNeuronStatus(id)`, `brain:neuron:status:changed` event. Inactive neurons are skipped during inject; query path unaffected.
- New runtime dependency: [`jsonrepair`](https://github.com/josdejong/jsonrepair) (~26 KB minified). Used internally by the JSON repair pipeline.

### Fixed

- Heal orphan neuron rows on init retry; mid-init failures no longer poison subsequent `Brain.create()` attempts.
- Prevent empty insights from deep-mode synthesis loop on weak models.

## [0.0.4] - 2026-04-21

### Changed

- Refactor store internals to make persistent storage modular and extensible.
- Keep SQLite as the persistent backend while isolating runtime-specific adapters.

### Added

- Runtime-specific SQLite adapters for Node.js and Bun.
- Store release checks covering persistence, restore, and packaged-install smoke tests.

## [0.0.3] - 2026-04-14

- Baseline tagged release before formal changelog tracking started in-repo.
