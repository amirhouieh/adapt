# Model capability ladder — 2026-10-10

Status: accepted as a diagnostic delivery. Root manually read all 270 raw answer contents and all production-recipe results. The independent mechanical audit passed. All three runner processes exited successfully.

Reviewed follow-up: [GitHub issue #30 comment](https://github.com/amirhouieh/adapt/issues/30#issuecomment-6099166472).

## Question

Can each candidate model handle three small memory operations before failures are attributed to the surrounding Adapt workflow?

The candidates under acceptance review are `liquid/lfm2.5-1.2b` and `qwen/qwen3.5-2b`. `gemini-3.8-flash` is diagnostic-only: it provides a stronger-model comparison, not a local-model acceptance candidate.

The frozen synthetic cases are:

1. Correct Mira Vale's launch date from 12 November 2026 to 19 November 2026 while preserving that Mira Vale's studio is in Delft.
2. Reverse the routine-status preference from email to Signal while preserving the unrelated Tuesday planning preference.
3. Add the initial fact that Mira Vale's studio is in Delft to an empty memory.

The human review objective is stored in each case description. It is metadata and is never included in a model request.

## Method

Each model receives 10 stages for each of the three cases, repeated three times: 90 independent stage executions per model. Stages 1–3 receive only the frozen observation and extraction question. Stages 4–10 receive the same frozen current memory and observation for their case. No model output becomes input to another stage.

All configurations use temperature `0`, `maxOutputTokens: 2048`, `maxRetries: 0`, and a 180-second timeout. No seed or reasoning override is configured. Requests run one at a time, and the two local models were loaded separately. Direct stages call the provider through the AI SDK. Prompt-only JSON stages receive no output schema and are not parsed as structured output. Enforced direct stages request provider-enforced JSON through AI SDK `Output.object`; the wire evidence records the resulting `response_format`, and the SDK parses the returned JSON. The runner does not invoke a separate local schema validator for direct outputs. The direct path does not apply the narrative recipe's Zod schema or its action-tuple validation.

Recipe stages create a fresh learning registry, register the production `adapt.learning.narrative` recipe, plan it, and execute it for one observation. These stages apply the production Zod action schema, tuple validation, exact-target replacement rules, and memory update rules. The recipe observation ID is case-specific and intentionally identical between stages 9 and 10, so the model messages in that pair are identical.

Every wire request and response, SDK result or error, supplied config and dataset, source digest, recipe input, and recipe execution result is retained as raw evidence. The harness writes `grading: null`; there is no expected-output comparison, automated semantic grader, or pass/fail score. The semantic findings below come from root's manual reading of the raw artifacts.

## Stages

| Stage | Request | Controlled comparison |
|---|---|---|
| 1 | Extract the new factual value as plain text. | Baseline factual extraction. |
| 2 | Perform the same extraction, prompted to return one-field JSON. | Prompt-only JSON formatting. |
| 3 | Exact stage 2 messages with provider-enforced one-field JSON. | Stage 2↔3 isolates schema enforcement. |
| 4 | Update the frozen memory from the observation as plain text. | Baseline synthesis with preservation. |
| 5 | Perform the same update, prompted to return `{ "memory": string }`. | Prompt-only JSON synthesis. |
| 6 | Exact stage 5 messages with provider-enforced JSON. | Stage 5↔6 isolates schema enforcement. |
| 7 | Exact stage 6 request with only the original scenario developer constraints appended. | Stage 6↔7 isolates those constraints. |
| 8 | Return `append`, `replace`, `unchanged`, or `defer` with `target`, `text`, and `reason`, under enforced JSON. | Tests the production action contract without running the recipe. |
| 9 | Run the production narrative recipe with `maxMemoryCharacters: 2000`. | Full narrative-recipe behavior at the evaluation's configured 2000-character bound. |
| 10 | Run the same recipe with `maxMemoryCharacters: 8000`. | Stage 9↔10 changes only the memory bound; model request messages remain identical. |

These stages are controlled pairs, not one causal chain with a shared output contract.

## Runs and evidence

| Role | Model | Config | Raw run |
|---|---|---|---|
| Acceptance candidate | `liquid/lfm2.5-1.2b` | [`model-capability-ladder-lfm.json`](../config/model-capability-ladder-lfm.json) | [`2026-10-10T15-29-20.434Z`](../.data/model-capability-ladder-lfm/2026-10-10T15-29-20.434Z) |
| Acceptance candidate | `qwen/qwen3.5-2b` | [`model-capability-ladder-qwen.json`](../config/model-capability-ladder-qwen.json) | [`2026-10-10T15-30-57.207Z`](../.data/model-capability-ladder-qwen/2026-10-10T15-30-57.207Z) |
| Diagnostic comparison | `gemini-3.8-flash` | [`model-capability-ladder-gemini.json`](../config/model-capability-ladder-gemini.json) | [`2026-10-10T15-29-20.436Z`](../.data/model-capability-ladder-gemini/2026-10-10T15-29-20.436Z) |

Frozen dataset: [`model-capability-ladder.json`](../datasets/model-capability-ladder.json).

## Manual semantic review

### LFM 1.2B

Root manually read all 90 raw contents and execution results. All three repetitions produced the same substantive result at every stage.

| Stage | Launch correction | Channel reversal | Empty-memory fact |
|---|---|---|---|
| 1–3 | Correct fact in all repetitions. | Correct fact in all repetitions. | Correct fact in all repetitions. |
| 4 | Correct updated memory in all repetitions. | Correct facts in all repetitions. | Correct fact in all repetitions. |
| 5–7 | Incorrectly copied the old memory, leaving 12 November current. JSON was valid. | Incorrectly copied the old memory, leaving email current. JSON was valid. | Correct memory in all repetitions. |
| 8 | Invalid `replace`: target was the new 19 November date, which is absent from current memory. | Invalid `append`: target was nonempty (`Signal`). | Invalid `append`: target was nonempty and contained the entire fact. |
| 9–10 | Appended the new date and left the old date, producing contradictory current dates. | Proposed appending already represented old memory; the production recipe rejected the update. | Correctly appended the fact to empty memory. |

Formatting observations are separate from factual correctness:

- Stage 1 returned sentences rather than bare values.
- Stage 4 returned semantically correct but meta-level prose for the channel-reversal and empty-memory cases, rather than clean maintained-memory text.

Changing `maxMemoryCharacters` from 2000 to 8000 produced no substantive difference in any of the nine stage 9↔10 repetition pairs.

### Qwen 2B

All three repetitions produced the same substantive result at every stage.

| Stage | Launch correction | Channel reversal | Empty-memory fact |
|---|---|---|---|
| 1–3 | Correct fact in all repetitions. | Correct fact in all repetitions. | Correct fact in all repetitions. |
| 4 | Correct complete memory in all repetitions. | Correct complete memory in all repetitions. | Correct complete memory in all repetitions. |
| 5–7 | Corrected the date and preserved Delft, but added the unsupported pronoun `her`. | Switched email to Signal but dropped the unrelated Tuesday planning preference. | Correct memory in all repetitions. |
| 8 | Invalid `replace` with an empty target. | Valid, correct replacement. | Invalid `replace` with an empty target and a reason that contradicted the requested action. |
| 9–10 | Correct memory. | Replaced the Tuesday sentence with Signal, leaving both email and Signal as current preferences. | Invented Amsterdam, selected `replace` with an empty target, and was rejected by the production recipe. |

The JSON date result retained the requested core facts but was not fully grounded because it introduced `her`. It is therefore not counted as an unqualified correct memory. Changing `maxMemoryCharacters` from 2000 to 8000 did not change any Qwen result.

### Gemini Flash

All 90 core factual outcomes were correct, and no production-recipe execution failed. In the production recipe's channel-reversal case, Gemini used a valid full-sentence replacement target; that target was larger than the instruction's requested smallest exact passage.

## Scope limits

- The dataset contains three small synthetic cases. It does not establish broad reasoning, long-context, safety, multilingual, or general memory quality.
- Direct stages measure provider and SDK behavior on frozen prompts. They bypass Adapt's learning registry, planner, executor, Brain, observation intake, cleanup, and stores.
- Recipe stages cover the production narrative recipe, registry, planner, and executor for one observation. They still bypass Brain orchestration, persistent stores, cleanup, and end-to-end observation delivery.
- Provider-enforced JSON demonstrates transport-level structured output. For direct stages, it does not demonstrate that action tuples satisfy production semantics such as an empty append target or an exact existing replacement target.
- The stage 9↔10 pair tests only whether the configured memory bound changes behavior for these short inputs. Both inputs are far below either bound.
- Temperature zero did not remove the need for repetitions, and deterministic-looking repetitions for one runtime do not establish determinism across runtimes or provider versions.
- Gemini is a diagnostic reference only. Its results cannot accept either local model.
- Model availability and runtime-state captures are preserved with the raw artifacts; they describe this run, not future deployments.

## Mechanical verification

- `npx vitest run tests/model-capability-ladder-eval.test.ts`: 3 of 3 passed. The tests parse all configs and the 3×10 dataset, verify direct-pair message identity and schema presence, and verify production request parity for stages 9 and 10.
- `npx tsc --noEmit -p evals/tsconfig.json`: exited 0.
- Each model recorded 90 requests and 90 responses, all HTTP 200 with finish reason `stop`. The audits found no transport errors, truncation, skipped requests, or settings mismatch.
- Each model passed 36 within-run controlled-pair checks. Across models, all 180 pairwise stage comparisons had identical raw inputs and identical wire requests after removing only the model field.
- The production recipe recorded 6 failed executions for LFM, 6 for Qwen, and 0 for Gemini. These counts cover rejected executions only; semantically wrong accepted memories are reported in the manual review instead.
- Maximum observed input/output tokens were 391/60 for LFM, 402/240 for Qwen, and 381/81 visible completion tokens for Gemini. Gemini's total-token accounting can include thinking tokens.
- Recipe inputs remained far below configured limits: at most 93 memory characters, 81 observation characters, 1828 request characters, and 6 of 32 available budget claims.
- Mechanical audits: [LFM](../.data/model-capability-ladder-lfm/2026-10-10T15-29-20.434Z/mechanical-audit.json), [Qwen](../.data/model-capability-ladder-qwen/2026-10-10T15-30-57.207Z/mechanical-audit.json), and [Gemini](../.data/model-capability-ladder-gemini/2026-10-10T15-29-20.436Z/mechanical-audit.json). Cross-model parity: [wire audit](../.data/model-capability-ladder-lfm/2026-10-10T15-29-20.434Z/cross-model-wire-audit.json).
- After evaluation, LM Studio was restored to LFM idle with context length 4096 and parallelism 4: [runtime capture](../.data/model-capability-ladder-lfm/2026-10-10T15-29-20.434Z/audit-metadata/runtime-restored/lms-ps.json).

## Assessment

The semantic and mechanical evidence collection is accepted as a diagnostic delivery.

Both local models demonstrated plain-text extraction and full-memory updating on these three tiny cases. Failures appeared before the full recipe: the current JSON full-memory and edit-action prompts produced stale memory, dropped facts, unsupported wording, invalid targets, and incorrect edit selection. Valid JSON did not imply a correct memory update.

Provider schema enforcement changed none of the local-model answers in the stage 2↔3 or 5↔6 pairs. Appending the scenario constraints changed none in the stage 6↔7 pair. This demonstrates a mismatch between the current prompts/output requirements and reliable local-model behavior on these cases; it does not prove one underlying model cause.

The 2000→8000 memory-bound change did not alter any local-model result. These short inputs were below both bounds, so this run provides no evidence that memory or context exhaustion caused the failures.

This run does not provide a verdict on personalized DAG generation or broad model reliability. Gemini is a diagnostic reference and is not an acceptance result for either local model.
