# Narrative output-mode comparison — 2026-10-10

Status: accepted as a diagnostic delivery, not as support for general rollout. Root manually reviewed all 36 response bodies, recipe results, and reopened SQLite understandings across both models. The per-model and cross-model mechanical audits are clean.

## Question

For three small memory updates, how does the existing edit-action contract compare with a new complete-memory rewrite contract inside the same production narrative recipe and SQLite commit path?

This is a comparison of two prompt and output contracts:

- `edit-action` asks for structured `append`, `replace`, `unchanged`, or `defer` fields.
- `plain-text` asks for the complete updated understanding as unstructured text.

The prompts necessarily differ. This experiment does not isolate JSON encoding from plain-text encoding.

## Method

The eval reuses the three frozen cases and the exact lens, current memory, observation, and 2000-character recipe limits from stage 9 of [`model-capability-ladder.json`](../datasets/model-capability-ladder.json):

1. Correct the launch date from 12 November 2026 to 19 November 2026 while preserving Mira Vale's Delft studio.
2. Reverse routine status updates from email to Signal while preserving the unrelated Tuesday planning preference.
3. Add Mira Vale's Delft studio to empty memory.

Each model runs both output modes for every case with three fresh-state repetitions: 18 independent provider requests per model. Configured generation settings are temperature `0`, `maxOutputTokens: 2048`, `maxRetries: 0`, and timeout 180 seconds. No seed or reasoning override is supplied. There are no repairs or semantic graders.

Both arms register, plan, and execute the production narrative recipe. The edit-action arm injects structured AI SDK generation. The plain-text arm injects unstructured AI SDK generation and passes the provider finish reason through the production capability. Only `stop` is accepted as a complete plain-text response; non-stop completion, blank output, and provider failure remain pending, while an understanding beyond the configured character bound fails validation.

The plain-text system prompt retains the lens purpose and developer constraints but removes the action-selection task. The raw recipe input still captures the complete lens and schema snapshot.

For each independent case, arm, and repetition, the runner uses a fresh SQLite database:

1. Seed nonempty current memory through a setup learning enqueue and commit.
2. Enqueue and commit the frozen observation as a derived pending observation without invoking an observer or setup model.
3. Enqueue synthesis, run the production narrative recipe once, and translate an accepted recipe result into the same SQLite commit shape used by the text DAG.
4. Dispose the store, reopen the database, and capture every store collection and revision.

Deferred, failed, and rejected outputs remain recorded with their queued work and unchanged memory. Raw artifacts retain request and response bodies, SDK output or error, recipe input and result, enqueue and commit inputs and results, SQLite database, before-close and after-reopen snapshots, and source/config/dataset hashes. Artifact metadata keeps `grading: null`.

This boundary is the isolated production narrative recipe plus the production SQLite transaction and reopen path. It does not run Brain orchestration, the observer, cleanup, or the full text learner delivery pipeline. The translation from recipe result to commit is eval-owned and follows the current text DAG implementation.

## Runs

| Model | Config | Raw run |
|---|---|---|
| `liquid/lfm2.5-1.2b` | [`narrative-output-mode-lfm.json`](../config/narrative-output-mode-lfm.json) | [`2026-10-10T16-06-47.749Z`](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z) |
| `qwen/qwen3.5-2b` | [`narrative-output-mode-qwen.json`](../config/narrative-output-mode-qwen.json) | [`2026-10-10T16-08-16.402Z`](../.data/narrative-output-mode-qwen/2026-10-10T16-08-16.402Z) |

The LFM source/config/dataset fingerprint is preserved in [`source-identifiers.json`](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z/source-identifiers.json), with the pre-run source freeze in [`source-freeze.json`](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z/audit-metadata/source-freeze/source-freeze.json).

The mechanical evidence is in the [LFM audit](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z/mechanical-audit.json), [Qwen audit](../.data/narrative-output-mode-qwen/2026-10-10T16-08-16.402Z/mechanical-audit.json), and [cross-model control audit](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z/cross-model-wire-audit.json).

## LFM 1.2B manual review

All three repetitions produced the same substantive result for every case and arm.

| Case | Edit-action contract | Complete-memory rewrite contract |
|---|---|---|
| Launch correction | Appended 19 November while retaining 12 November, then committed contradictory current dates. | Returned 19 November but dropped the Delft fact entirely and included commentary about what changed; that text was committed as the complete memory. |
| Channel reversal | Proposed appending already represented old memory. The recipe rejected the action; reopened memory retained email and the observation remained pending. | Stated the switch to Signal and preserved Tuesday, but included change commentary instead of a clean current-preference memory; that text was committed. |
| Empty-memory fact | Correctly committed the Delft studio fact. | Correctly committed a clean Delft studio fact. |

The complete-memory rewrite arm is not a full LFM success. It preserved the requested core facts in two cases and produced clean memory only for the empty-memory case. In the launch case it lost an unrelated durable fact; in the channel case it persisted edit commentary as memory.

The earlier capability ladder's minimal stage 4 plain-text prompt produced a semantically correct launch correction while retaining Delft. The new production plain-text prompt also requests complete memory, but its framing, context, instructions, and execution path differ. The prompts are not identical, so this contrast does not isolate which instruction caused LFM to lose Delft. It calls for prompt assessment and does not show that complete-memory rewriting itself caused the regression. See [`model-capability-ladder-2026-10-10.md`](model-capability-ladder-2026-10-10.md).

## Qwen 2B manual review

All three repetitions produced the same substantive result for every case and arm.

| Case | Edit-action contract | Complete-memory rewrite contract |
|---|---|---|
| Launch correction | Correctly preserved Delft and changed the launch date to 19 November 2026. | Committed a clean, grounded complete memory with Delft and 19 November 2026. |
| Channel reversal | Targeted the Tuesday sentence for replacement, leaving both email and Signal as current while losing Tuesday. | Committed a clean, grounded complete memory with Signal instead of email and the Tuesday preference preserved. |
| Empty-memory fact | Hallucinated Amsterdam and selected `replace` with an empty target. The recipe rejected the action; reopened memory remained empty and the observation remained pending. | Committed a clean, grounded Delft studio fact. |

Qwen's complete-memory rewrite behavior is accepted for these three frozen cases only. All nine Qwen plain-text executions produced clean, grounded, complete persisted memory. This does not establish behavior for uncertainty, deliberate clearing, larger memories, or other inputs.

## Verification

- Production-focused tests: 39 passed: 30 narrative recipe, 4 provider adapter, and 5 text DAG tests.
- Eval harness tests: 6 passed: 3 new output-mode tests and 3 retained capability-ladder tests.
- Project TypeScript check: passed.
- Eval TypeScript check: passed.
- Transport: all 36 requests returned HTTP 200 with `stop`; no transport, completion, settings, or output-format mismatches.
- Recipe and storage: the plain-text arm committed all 18 results. The edit-action arm committed 12 results; 6 rejected actions were not committed and retained one pending work item, input, and observation each. All 36 before-close snapshots exactly matched their reopened SQLite snapshots.
- Input parity: each model's 9 paired underlying inputs, 12 repeated inputs, and 12 repeated wire requests matched. There were no mismatches.
- Cross-model controls: all 18 provider requests matched after removing only the model identifier. All 18 edit-action requests matched the prior stage-09 controls exactly, and configs matched after removing model and output-root fields.
- Source freeze: all 33 files remained unchanged; run-start source, current source, and input hashes had no mismatches.
- Completion bounds: LFM's maximum prompt/completion/total token counts were 391/58/447; Qwen's were 402/240/604, within the configured 2048 output-token limit and loaded 4096-token context.
- Runtime restoration: LFM was restored to context 4096, parallelism 4, and idle state after inference; evidence is in [`runtime-restored`](../.data/narrative-output-mode-lfm/2026-10-10T16-06-47.749Z/audit-metadata/runtime-restored).

## Limits

- These three tiny cases are a capability floor. They provide no evidence about large memories, context exhaustion, multilingual input, noisy evidence, or broad reliability.
- The complete-memory contract cannot explicitly encode uncertainty or `defer`. Blank output is treated as pending, and exact repetition represents no change.
- An intentional update to an empty understanding cannot be represented by blank output because blank is treated as incomplete. Memory-clearing behavior is not tested here.
- Persistence proves what the isolated recipe accepted or rejected and what SQLite retained after reopen. It does not prove full observer, Brain, or learner behavior.
- The comparison changes prompt instructions and output contract together. It cannot attribute differences to structured output alone.
- The prior minimal plain-text result and current production plain-text result differ. More prompt-specific evidence is required before changing architecture.

## Assessment

The evidence collection is accepted as a diagnostic delivery, not as support for general rollout.

Qwen's complete-memory rewrite behavior is accepted only for these three frozen cases. LFM's complete-memory rewrite behavior is not accepted as reliable: it dropped Delft in one case and persisted change commentary in two cases. The edit-action arm retained the previously observed model-specific failures.

This result supports a focused next review of the complete-memory prompt and its uncertainty, no-change, clearing, and larger-memory behavior before broad adoption. It does not support a personalized-DAG or general architecture verdict.

The complete-memory mode remains opt-in, and the existing edit-action mode remains the default. The test results above verify the implementation and eval mechanics; they do not grade model response quality.
