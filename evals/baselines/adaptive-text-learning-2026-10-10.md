# Adaptive text learning — 2026-10-10

Status: implementation is partial and blocked on learning quality. The current code passes its final mechanical checks, and the adaptive text state eval is accepted for its tested SQLite state and store mechanics only. The new learning path is rejected for both local models on the evaluated stream; the original Arm A pipeline also failed retention on this scenario.

## Current delivery

The current implementation contains:

- A typed adaptive text procedure module with four immutable version 2 procedures: direct rewrite, compare then rewrite, pattern then rewrite, and independent compare plus pattern then rewrite. The exact original version 1 writer and direct recipe are also registered as immutable definitions after causal replay identified a Qwen regression in the version 2 prompt bundle.
- An AI SDK-backed local provider adapter, bounded request preflight, exact control handling, injected token accounting, and procedure selection over an approved catalogue.
- Durable adaptive text state and coordination for pending input, batching, retries, recovery, candidate commit, source disposal, profile activation, and bounded retention.
- Public `TextNeuron` adaptive-mode wiring for create, learn, flush, resume, restore, state inspection, and disposal.
- A synthetic fixture set with four 180-input streams: three development streams and one sealed held-out stream. Reviewer keys remain separate from model inputs.

These modules being present does not accept their assembled behavior. Mechanical tests and model semantics are separate gates.

Arm naming is separate from operation versioning. Arm A is the pinned original Adapt v1 observe-then-synthesize pipeline. Arm B is the newly implemented adaptive `TextNeuron` direct-DAG writer. The new module's writer operation version 1 means its first prompt revision; it does not reuse original Adapt v1 neuron learning.

## Remaining work

### Implementation gaps

- Semantic learned-change summaries are absent, so the selector receives an empty learned-changes collection.
- New Brain adaptive routing, discovery, split, and merge wiring is not implemented.
- Legacy-to-adaptive migration for the new path is not implemented.

### Evaluation gates

- The completed coverage is one 180-input synthetic development stream across two arms, two models, and one repetition. All four runs failed semantic review.
- Three other streams, additional repetitions, Arms C and D, and the sealed held-out stream have not run.
- Full public standalone and Brain close/reopen, timer, query, and crash/replay behavior has not passed assembled real-model evaluation.
- The complete Arms A–D comparison has not run.
- No procedure has earned automatic-selection eligibility from these results.

## Mechanical evidence

The final checks passed:

- Vitest: 102/102 across procedures (12), public adaptive neuron (13), state (14), fixtures (7), longitudinal runner (5), store (22), activation (7), legacy restore (10), and version 1 phases (12).
- Bun SQLite: 11/11.
- `npm run build`: ESM and CJS builds passed again after the final coordinator race fixes.
- Git diff check passed.
- Strict TypeScript checks for the procedure eval units passed.
- All 16 development module cases fit the configured complete requests at context 16384, including the conservative reservation for two 512-character analytical notes and a 4096-token writer output.
- The module dataset retained SHA-256 `10ffe46e04ab6c80507a8d9d70ce27935d8a99f49a4f6a34574ba49eff7505a4`.

The accepted state-only evidence is preserved in:

- [State eval metadata](../artifacts/adaptive-text-state-2026-10-10-r3/run.metadata.json)
- [Exact state operations output](../artifacts/adaptive-text-state-2026-10-10-r3/operations.output.raw.json)
- [State input config](../artifacts/adaptive-text-state-2026-10-10-r3/config.input.raw.json)
- [State input dataset](../artifacts/adaptive-text-state-2026-10-10-r3/dataset.input.raw.json)
- [Reopenable SQLite artifact](../artifacts/adaptive-text-state-2026-10-10-r3/adaptive-text-state.sqlite)

Root accepted this eval for its real SQLite state and store mechanics only. The script did not instantiate `LearningCoordinator`. Public Arm B demonstrates real coordinator wiring, while timer, batching, disposal races, and crash behavior have mechanical test coverage but no assembled real-model crash run. The state eval contains no model-semantic evidence.

The frozen fixture inventory and hashes are in the [fixture manifest](../config/adaptive-text-learning/fixture-manifest.json). Fixture validity establishes shapes, identities, chronology, and reviewer separation. It does not establish learning quality.

## Procedure eval method

The development module dataset has 16 cases:

- 4 direct writer cases.
- 3 compare then rewrite cases.
- 3 pattern then rewrite cases.
- 3 compare plus pattern then rewrite cases.
- 3 selector cases.

The runner used the production Adapt AI SDK plugin path through the local OpenAI-compatible provider. Every case retained its constructed input, exact SDK input and result or error, exact wire request and response, raw module output, supplied config, and supplied dataset. Reviewer expectations were not included in model requests. Root manually read all outputs and request bodies.

The first profile used context 8192, output reserve 1792, and a 240-character analytical-note bound. The revised profile used context 16384, output reserve and maximum output 4096, a 512-character note bound, maximum narrative 4096 tokens, and maximum memory 4000 characters. Temperature was 0 and provider retries were disabled.

Because the revised run changed both the prompt contract and multiple capacity settings, the first and revised runs alone are not a causal prompt comparison. The dedicated saved-request replay below held the runtime settings constant.

## Raw procedure runs

| Profile | Model | Config | Raw artifact |
|---|---|---|---|
| First | `qwen/qwen3.5-2b` | [Saved config](../artifacts/adaptive-text-procedures-qwen/2026-10-10T17-39-39.768Z/supplied-config.raw.json) | [2026-10-10T17-39-39.768Z](../artifacts/adaptive-text-procedures-qwen/2026-10-10T17-39-39.768Z) |
| First | `liquid/lfm2.5-1.2b` | [Saved config](../artifacts/adaptive-text-procedures-lfm/2026-10-10T17-38-32.343Z/supplied-config.raw.json) | [2026-10-10T17-38-32.343Z](../artifacts/adaptive-text-procedures-lfm/2026-10-10T17-38-32.343Z) |
| Revised | `qwen/qwen3.5-2b` | [Saved config](../artifacts/adaptive-text-procedures-qwen/2026-10-10T17-48-04.161Z/supplied-config.raw.json) | [2026-10-10T17-48-04.161Z](../artifacts/adaptive-text-procedures-qwen/2026-10-10T17-48-04.161Z) |
| Revised | `liquid/lfm2.5-1.2b` | [Saved config](../artifacts/adaptive-text-procedures-lfm/2026-10-10T17-50-12.670Z/supplied-config.raw.json) | [2026-10-10T17-50-12.670Z](../artifacts/adaptive-text-procedures-lfm/2026-10-10T17-50-12.670Z) |

The links above are directories containing the untouched raw evidence. Each root includes the exact supplied config and dataset plus per-case constructed, SDK, wire, and module artifacts.

## Manual semantic review

### First profile

Qwen produced acceptable complete memories for all four direct writer cases. LFM produced an acceptable direct result only for the location-correction case.

Neither model's nine richer recipe cases were accepted. They lost material details, introduced unsupported interpretations, mishandled scope or patterns, or persisted editorial text instead of a clean current narrative.

Six Qwen richer recipes stopped because their analytical note exceeded the configured 240-character bound. Those six are capacity-policy deferrals, not six demonstrated semantic reasoning failures. One duplicate-event note, for example, correctly identified the duplicate but was rejected by the note-length gate. The remaining inspected richer outputs still do not establish accepted recipe behavior.

The selectors did not produce an accepted switch to a different procedure.

### Revised profile

Qwen returned `ADAPT_NO_CHANGE` in all four direct writer cases. That response was wrong for the three cases containing legitimate updates and correct for the hostile incoming-command case.

LFM applied the location correction and retained the unrelated delivery fact, but added editorial wording. It returned no change for the captions/accessibility update and the tentative-date update. In the hostile-input case it retained the protected facts but again produced editorial framing.

The revised richer recipes remained unaccepted for both models because final narratives dropped facts, asserted false patterns, mishandled scope, or included editorial text. Qwen also echoed source payload content in two cases. The revised selectors produced no activated procedure proposal.

All inspected revised responses ended with `stop`. Observed prompt sizes were approximately 413–800 tokens, and no result was rejected for output-token or context truncation. This removes truncation as an explanation for these particular outputs. It does not identify a single underlying cause for the semantic failures.

## Causal replay

The [writer prompt replay harness](../scripts/adaptive-text-writer-prompt-replay.ts) reads the exact saved SDK system and user messages for the four direct cases from both prompt profiles. It replays them through `createAiSdkLLM` and `createOpenAICompatible` with the same model, context 16384, maximum output 4096, temperature 0, and no retries.

Its [LFM config](../config/adaptive-text-writer-prompt-replay-lfm.json) and [Qwen config](../config/adaptive-text-writer-prompt-replay-qwen.json) each define eight requests: four cases times two immutable prompt profiles. The exact raw replay artifacts are preserved in the [LFM replay](../artifacts/adaptive-text-writer-prompt-replay-lfm/2026-10-10T17-52-44.980Z) and [Qwen replay](../artifacts/adaptive-text-writer-prompt-replay-qwen/2026-10-10T17-53-47.278Z) directories.

At identical context 16384, maximum output 4096, temperature 0, and no retries, Qwen repeated all four acceptable version 1 direct results. With the version 2 prompt bundle it repeated the three false `ADAPT_NO_CHANGE` results for legitimate updates and the correct no-change result for the hostile input. This identifies the prompt bundle as the cause of the Qwen regression; it does not isolate one clause. LFM repeated its earlier failures with both prompt profiles.

The narrow corrective action restores the exact original version 1 writer prompt builder, writer operation, and direct recipe beside the unchanged version 2 definitions. The execution, bounds, budgeting, provider, and persistence contracts remain shared. Four checked synthetic request fixtures preserve the original request strings and their source hashes; mechanical tests prove generated version 1 system and user strings are byte-identical while context and output settings remain supplied configuration. This is a versioned rollback, not another prompt variant.

## Longitudinal run status

The first Qwen version 1 longitudinal attempt is preserved at [2026-10-10T17-55-36.398Z](../.data/adaptive-text-longitudinal-v1-qwen/2026-10-10T17-55-36.398Z), but it is invalid after checkpoint 30. Its version 1 phase overrides omitted the configured purpose, and its restore path constructed `createAiSdkLLM` without the required provider registry. Checkpoint queries and deliveries from 31 onward failed with `Cannot resolve lm-studio.chat`. Later memory flatness in this artifact is a harness failure and provides no evidence about version 1 learning behavior.

The harness now supplies purpose plus constraints to the phase overrides and registers the official providers on restore. The baseline profile did not change. The corrected Qwen Arm A run is preserved at [2026-10-10T18-00-26.087Z](../.data/adaptive-text-longitudinal-v1-qwen/2026-10-10T18-00-26.087Z). Root read all checkpoint memories and queries plus wire calls 089 and 104 and rejected its semantic behavior:

- Checkpoint 30 retained functions, testing, and API facts but invented the ADR acronym expansion `Agreed To/Rejected`.
- Checkpoint 60 dropped API and Rust facts, then incorrectly called a local refactor without an ADR a deviation.
- Checkpoint 90 left memory unchanged. Wire calls 089 and 104 discussed ADRs in other fields while `newUnderstanding` copied the old narrative.
- Checkpoint 120 still lacked the API fact.
- Checkpoint 150 learned provenance, but lost the Rust result and API fact; its query insight was empty.
- The final memory retained functions, the scoped payment-engine detail, provenance, and no Rust expansion. It omitted the 11:30 review, observability, and API facts, and promoted an importer review event into a requirement in query output.

Arm A does not have a valid whole-run source-freeze claim. The runner source changed at 18:00:37 after its worker began at 18:00:27. That edit only added optional `profileLineage` parent read, hash, and copy behavior; Arm A had no profile-lineage config, the worker had already compiled the older source, and the later coordinator edit was unused by Arm A. The baseline and prompt were unchanged and are preserved in exact wire evidence, but the run must retain this source-timing caveat.

Qwen Arm A made 213 model calls, used 131,498 total tokens, and recorded 619.646 seconds wall time. These measurements retain the source-timing caveat above and do not establish a general performance benchmark.

Qwen Arm B is preserved at [2026-10-10T18-10-56.056Z](../.data/adaptive-text-longitudinal-fixed-direct-qwen/2026-10-10T18-10-56.056Z). Root read every query, checkpoint memories at 30, 60, 120, and final, and wire calls 002–005 and 030. Every checkpoint retained only the first input even though the exact requests contained new inputs and the model copied the old memory. The run completed all 180 deliveries with 179 unique IDs and correctly handled the duplicate. Its 26 attempts produced one commit and 25 no-change results. It made 32 provider calls: 26 writer and 6 query calls, using 26,148 input and 2,668 output tokens, 28,816 total. Model time was 100.07209 seconds and wall time was 102.386 seconds. It ended at memory revision 1 and state revision 26 with 179 processed IDs; pending, work, outbox, candidates, running, and capacity counts were all zero. Learning history had five entries, learning revisions one, and memory changes zero. All Arm B source hashes were stable.

Six query SDK results ended with `error` because structured-output validation rejected raw relevance and confidence values of 100 against a 0–1 schema. These were recovered validation failures, not transport failures or public query failures; the existing core clamp repaired the numeric fields to 1 while retaining the SDK error flag. Root inspected raw query result 006.

Arm A used observer temperature 0.2, `understand.maxObservations` 10, `understand.maxTokens` 8000, minimum importance 0.5, and `cumulative.governance.maxTokens` 16000. Arm B had no observer and used writer temperature 0, `maxItems` 8, and `memory.maxCharacters` 4000. Both used `maxOutputTokens` 4096. These are different comparison pipelines, so their difference cannot be attributed to a DAG effect. LFM Arm A completed all 180 attempts and six checkpoints with process status 0, but delivery 102 prevents describing it as 180 clean successful inputs.

The LFM Arm A review rejects the learning state at every checkpoint. Checkpoint 30 lost ordinary-function and typed-API specificity and retained only a generic SQLite error-boundary summary. Checkpoint 60 emphasized errors, schema, and controlled rollout generically while omitting the ordinary-function rule, regulated-policy-engine rule, tentative Rust fact, and separate API-versus-CLI rule. Checkpoint 90 reduced the memory to generic error, schema, token-risk, and unit-driven wording while losing the bounded Rust experiment, request-ID limits, and Sam's identity. Checkpoint 120 retained generic error, schema, CI-traceability, and API-update wording but lacked the ordinary-functions rule, regulated-policy-engine scope, separate typed API-versus-CLI distinction, and qualified race pattern. Checkpoint 150 retained only one sentence about CI provenance and rollback. The final memory reduced the stream to generic CI reliability, provenance, rollback, error boundaries, credential scope, import verification, and automated-versus-manual review. It omitted ordinary functions, the regulated-policy-engine rule, the separate API-versus-CLI rule, production-only provenance, the bounded keep-but-do-not-expand Rust decision, the 11:30 review, complementary observability, and adapter-versus-helper testing.

All six public queries fell back to `Unable to generate response`. Each used three turns with the same missing-complete-sentinel pattern. At checkpoint 30, wire call 035 contained a generated answer and call 036 ended with `stop` prose without the required complete sentinel. `ToolBasedMethod` then discarded the last response because completion was not signaled; the current implementation was byte-identical to the pinned baseline. This is a version 1 query tool-loop protocol failure, not evidence that the model could not answer. Arm B uses a direct query path, so query outputs across A and B are confounded; memory states remain the relevant learning comparison.

Delivery 102 also has an actual transport-timeout confound. Model call 000118 began at `2026-10-10T18:27:56.405Z` and ended at `2026-10-10T22:45:36.037Z` with `TimeoutError`, a recorded duration of 15,459,821.847 ms. Its exact input text was `Decision records: Routine dependency bumps stay in their pull requests.` This sentence is fixture content; repository sources remained stable during the pause. Root inspected the exact input and error. Semantic learning had already failed before the pause, but later checkpoints include this runtime confound. The run cannot be described as 180 clean successful inputs, and its raw wall and model durations are not a speed benchmark.

LFM Arm A recorded 212 model attempts: 211 HTTP 200 results and one timeout. The successful results contained 199 stop completions, 12 tool-call completions, and no length completions. It used 104,548 input and 11,204 output tokens, 115,752 total. Successful model time was 1,570.264683 seconds; wall time was 17,033.571 seconds because the timeout alone occupied 15,459.821847 seconds. The 180 delivery outcomes were 72 dismissed, 1 observe error, 100 observed, and 7 synthesized. Source hashes were stable. These durations are not a speed benchmark.

LFM Arm B is preserved at [2026-10-10T22-57-11.045Z](../.data/adaptive-text-longitudinal-fixed-direct-lfm/2026-10-10T22-57-11.045Z). Root read all six checkpoint memories and queries, final state, and the exact requests and responses for wire calls 001, 002, and 030. The first write partly retained the small-functions fact but added editorial framing. All six checkpoint memories paraphrased the learning instructions while omitting critical source facts. Every query reported confidence 1 after repair despite the memory gaps. The learning behavior is rejected.

LFM Arm B made 32 provider calls: 26 writer and 6 query calls. All 32 transport responses were HTTP 200 with stop completion and there were no transport failures. Six query wrappers retained an error because the model returned out-of-range confidence values such as 85 and 88; the existing core repair clamped them to 1. It used 24,733 input and 2,196 output tokens, 26,929 total. Model time was 56.663505 seconds and wall time was 58.617 seconds. The run processed 180 deliveries with 179 unique IDs and one correctly handled duplicate. It recorded 26 commits/revisions, five history/memory-change records without semantic summaries, and one revision row. Pending input, work, outbox, candidates, and capacity state were empty. All six exact reopen checks passed, and source bytes before and after the run were identical.

## Assessment

The state eval is accepted for its tested mechanics. The procedure eval harness and raw-evidence capture are accepted as diagnostic infrastructure. The new learning path is rejected for both models on this stream. The original Arm A pipeline also failed required retention in this scenario. The full new-path DAG is not accepted, and no procedure has automatic-selection eligibility.

This evidence covers one 180-input synthetic development stream, two arms, two models, and one repetition. It excludes the other three streams, further repetitions, Arms C and D, and held-out evaluation. No conclusion about a personalized DAG follows from pipelines with different observer and capacity settings or from selectors that did not activate a different procedure. No model-incapability conclusion follows from these prompt- and pipeline-specific failures. The controlled replay attributes the observed Qwen direct-writer regression to the version 2 prompt bundle without identifying one causal clause.

Open follow-up tracking remains in [issue #30](https://github.com/amirhouieh/adapt/issues/30) and [issue #31](https://github.com/amirhouieh/adapt/issues/31). This report does not post or modify either issue.
