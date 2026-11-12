# Original v1 versus redesigned TextDagLearner across three models

Status: **Complete diagnostic report. Quality is not accepted.** Runs started on 8 October 2026; the interrupted Qwen run, isolated repeat, manual review, and mechanical audits completed on 10 October 2026.

## Scope and method

This comparison combines mechanical checks with manual semantic inspection of original v1 and the redesigned v2 `TextDagLearner` narrative path. It tests a small fixed DAG, not a large, evolving personalization system. The v1 arm loads the committed baseline at `e2150ed3970d41125cb36d5c46f65e981ad2f088`; the v2 arm runs `createTextDagLearner` from `src/neurons/text/dag.ts` with the narrative recipe. It does not use the v1 phase-wrapper experiment.

Each model received the same eight frozen scenarios: 26 inputs containing 1,672 characters and 288 space-delimited words. Each scenario was a standalone run with one fresh neuron per arm. Every arm processed its deliveries sequentially in one pass, then closed, reopened, and read its store after each delivery. This did not exercise brain routing or query behavior. Raw request bodies, response bodies, model-call records, state snapshots, failures, source fingerprints, and process output remain in the run directories. This report does not alter those artifacts and assigns no numeric semantic scores.

The prompts and output contracts differ between v1 and v2. These runs therefore compare the complete behaviors as implemented; they do not isolate a causal effect from DAG structure, model weights, prompting, or output schema alone. Gemini is diagnostic context only and is not a valid Adapt acceptance evaluation.

## Runs and settings

| Model | Provider settings | Request controls | Run |
|---|---|---|---|
| Liquid LFM 2.5 1.2B | `liquid/lfm2.5-1.2b`; observer temperature `0.2`; initialization, synthesis, and assessment temperature omitted; seed and output cap omitted | 180 s timeout; zero retries; one concurrent request | [artifacts](../.data/text-dag-comparison-suite-local-lfm/2026-10-08T20-57-34.130Z/) · [process summary](../.data/text-dag-comparison-suite-local-lfm/2026-10-08T20-57-34.130Z/process-summary.json) · [audit](../.data/text-dag-comparison-suite-local-lfm/2026-10-08T20-57-34.130Z/mechanical-audit.json) |
| Gemini 3.8 Flash | temperature `0`; maximum output `4096` tokens | 60 s timeout; one retry; one concurrent request | [artifacts](../.data/text-dag-comparison-suite-gemini/2026-10-08T20-57-11.115Z/) · [process summary](../.data/text-dag-comparison-suite-gemini/2026-10-08T20-57-11.115Z/process-summary.json) · [audit](../.data/text-dag-comparison-suite-gemini/2026-10-08T20-57-11.115Z/mechanical-audit.json) |
| Qwen 3.5 2B | `qwen/qwen3.5-2b`; observer temperature `0.2`; initialization, synthesis, and assessment temperature omitted; seed and output cap omitted | 180 s timeout; zero retries; one concurrent request | [artifacts](../.data/text-dag-comparison-suite-local-qwen/2026-10-08T21-03-23.607Z/) · [process summary](../.data/text-dag-comparison-suite-local-qwen/2026-10-08T21-03-23.607Z/process-summary.json) · [audit](../.data/text-dag-comparison-suite-local-qwen/2026-10-08T21-03-23.607Z/mechanical-audit.json) |
| Qwen case-1 repeat | Same Qwen configuration; fresh v1 and v2 arms | Same request controls | [artifacts](../.data/text-dag-comparison-suite-local-qwen-interruption-repeat/2026-10-10T14-15-50.573Z/) · [process summary](../.data/text-dag-comparison-suite-local-qwen-interruption-repeat/2026-10-10T14-15-50.573Z/process-summary.json) · [audit](../.data/text-dag-comparison-suite-local-qwen-interruption-repeat/2026-10-10T14-15-50.573Z/mechanical-audit.json) |

The numeric configuration is shared, but some units differ by implementation. V1 uses limits of 4 observations, 1,600 observation tokens, and 2,000 memory tokens. V2 uses 400 observation characters, 2,000 memory characters, and 8,000 context characters, plus limits of 10 nodes, 4 collection items, 12 operations, and 32 claims. Minimum importance is `0`.

| Run | Processes | Model transport | Store reopen | Application state |
|---|---|---|---:|---|
| LFM | v1 8/8 and v2 8/8 exited zero | 112 calls, 112 responses, 0 transport errors | 52/52 matched | Three v2 duplicate appends failed. |
| Gemini | v1 8/8 and v2 8/8 exited zero | 110 calls, 110 responses, 0 transport errors | 52/52 matched | No action-application failure noted; one deferred item remained pending in case 4. |
| Qwen | v1 8/8 and v2 8/8 exited zero | 96 attempts, 95 responses, 1 timeout | 52/52 matched | Eight non-interruption v2 actions failed. |
| Qwen case-1 repeat | v1 1/1 and v2 1/1 exited zero | 13 calls: 7 v1 and 6 v2; all HTTP 200 with stop; 0 errors or truncations | 6/6 matched | v1 synthesized 3/3; v2 failed 3/3 applications and retained 3 pending-work plus 3 pending-input records. |

All audited source hashes were unchanged. After the runs, LFM was restored and verified idle with context length 4,096 and parallelism 4.

## Current findings

| Scenario | LFM original v1 | LFM redesigned v2 | Gemini original v1 | Gemini redesigned v2 | Qwen original v1 | Qwen redesigned v2 |
|---|---|---|---|---|---|---|
| 1. Factual correction | Changed “studio in Delft” into a launch location in Delft. | All decisions appended. Duplicate append validation failed on deliveries 2 and 3; the final state omitted the launch. | Preserved the main facts. | Applied the correction and retained independent facts. | **Fresh repeat, primary:** correctly retained the Delft studio and final 19 November date. **Original full-suite v1:** invented a user association, turned Mira into a studio, and retained a stale 12 November assertion before the corrected date. This arm completed before the later v2 interruption. | **Fresh repeat, primary:** all three replacements had invalid targets, leaving final memory empty. The first response invented an Amsterdam studio and prior Paris context despite empty understanding; later responses targeted nonexistent provisional text. **Interrupted original:** lost the studio fact after the timeout and is retained only as contaminated evidence. |
| 2. Preference reversal | Ended with “timely alerts,” rather than the actual preference. | Kept the obsolete email preference, the new Signal preference, and a redundant third entry. | Preserved the main facts. | Applied the preference reversal. | The observer dropped the direction of the change; synthesis insisted on email. The final memory remained wrong about email despite an explicit third Signal preference. | All three updates failed because replace targets were empty or nonexistent, leaving final memory empty. The second observation invented an operator instruction and lost user-entity binding. |
| 3. Paraphrased duplicates | Retained Tuesday at 09:30 but lost the Keel surname; an earlier state invented goal alignment. | Created three overlapping entries; the schedule appeared only in the middle entry. | Preserved the main facts. | Deduplicated the paraphrases. | Retained Tuesday at 09:30, but invented mandatory attendance, Nora as leader, and a 10:00 end time. Duplicate inputs reinforced those inventions. | Stored the correct schedule first. Two duplicate appends then failed; the correct schedule remained, with two pending items. |
| 4. Tentative resolution | Prematurely called the 16 December date scheduled, then ended at 17 December while inventing timeline importance. | Ignored the confirmed 17 December date. | Preserved the main facts. | Deferred the tentative statement, recorded it as pending, then replaced it with the confirmed 17 December date. The original deferred observation remained in pending work and pending input. | Dismissed the first two tentative observations as irrelevant. It retained the final 17 December date, but added claims about a formal process and invented commencement. | Dismissed the first two tentative observations and retained the final confirmed 17 December date. |
| 5. Same-name entities | Merged the two identities. | Duplicate append validation failed on delivery 2. | Kept the entities separate. | Kept the entities separate. | Merged Cedar Labs' and Cedar Clinic's Alex Rowan into one person with dual roles. The final memory retained both badge colors and the 5 October 2026 Cedar Labs start, but described the 8 October 2026 Cedar Clinic start as that person's tenure extending to 8 October. | The first two empty-target replacements failed. The final memory was: “The date for the start of Cedar Labs' Alex Rowan is set to October 8, 2026.” It transferred Cedar Clinic's date to Cedar Labs and lost both badge facts and the Cedar Clinic identity. |
| 6. Relevance with noise | Lost the region and time, then invented a European-market link. | Ignored the 02:00 UTC backup fact and included noise. | Preserved the main facts. | Filtered the noise and retained relevant facts. | Retained the region and 02:00 UTC time and excluded noise, but invented an exclusive AWS constraint. | Retained the region and 02:00 UTC backup time and excluded noise, but duplicated the region. |
| 7. Recurring pattern | Ended with only a vague causal statement linking cache management, stability, and recent maintenance. It dropped the 95–97% readings, dates, and clear-pass evidence. | Produced an event list instead of learning the recurring pattern. | Retained the main facts. Saved memory suggested that one successful cleanup was an effective mitigation, while the response reasoning said it prevented failure; the final caveat partially qualified that causal overstatement. | Retained all four experiences, but produced an event list rather than a pattern summary. | Dismissed all four inputs and stored no memory. | Dismissed all four inputs and stored no memory. |
| 8. Changing scoped exception | Lost the general before-noon preference. | Kept the general preference, but appended both the old 14:00 and new 16:00 times. | Preserved the main facts. | Preserved the general before-noon preference and replaced 14:00 with 16:00. | The observer dismissed the general before-noon preference. The final memory correctly retained Vega at 16:00, but omitted the general preference. | Dismissed the before-noon preference, deferred Vega at 14:00, then failed the 16:00 replacement because its target was invalid. Final memory was empty. |

Across all 26 LFM v2 decisions, the action was append. Three append operations failed duplicate validation: scenario 1 deliveries 2 and 3, and scenario 5 delivery 2. This makes the LFM result both a semantic and an execution-level warning for the redesigned path. Original v1 also produced incorrect memory with LFM in this run.

The Gemini results are materially stronger on correction, deduplication, entity separation, relevance filtering, and the scoped time change in both implementations. The redesigned path still did not turn scenario 7 into a recurring-pattern summary. In scenario 4 it reached the correct final 17 December date, but left one old observation in pending work and one pending input. The current DAG roots each run in the current delivery's observations and does not automatically revisit old pending items, so this is an unresolved lifecycle limitation observed in the run rather than a transport failure.

Outside the interrupted Qwen case 1, eight v2 actions failed validation or application in the original full suite. The fresh case-1 repeat added three separate invalid replacements; these counts are reported separately rather than silently aggregated across runs. The clean repeat also differed semantically from the interrupted case, confirming that the interrupted result cannot stand in for a normal run. The redesigned path is not reliable with either local model in these runs; original v1 also produced incorrect or empty memory with both local models, although its fresh Qwen case-1 repeat was correct. Gemini shows that the v2 action path can execute correction, deduplication, separation, and filtering, while still exposing recurring-pattern and pending-work lifecycle gaps. These short fixed-DAG runs do not settle the viability of an evolving personalized DAG.

The current implementation does not meet a quality acceptance bar from this diagnostic evidence.

## Mechanical verification

The configuration and implementation checks completed before these runs were:

```text
npx tsc -p evals/tsconfig.json --noEmit
npx vitest run tests/text-dag.test.ts tests/learning-recipes.test.ts tests/learning-executor.test.ts tests/learning-planner.test.ts
npx vitest run tests/text-dag.test.ts tests/learning-recipes.test.ts tests/text-v1-direct-eval-config.test.ts
```

The first focused test command passed 36 tests. The separate configuration-focused command passed 28 tests; these sets overlap and must not be added together. The eval TypeScript check passed. Semantic acceptance requires direct inspection of the raw artifacts; process exit alone is not acceptance.

## Limits

- Eight short, synthetic scenarios and one pass per model do not cover long-horizon personalization, evolving graphs, retrieval quality, migration, concurrency, brain routing, query behavior, or sustained recovery behavior.
- The models used different generation settings. LFM and Qwen used explicit observer temperature `0.2`, native temperature elsewhere, and native seed and output limits; Gemini used explicit temperature and output-token settings.
- Different v1 and v2 prompts and contracts prevent attributing differences to DAG execution or model weights alone.
- The Qwen run was interrupted when the laptop slept and the clock advanced from 8 October to 10 October before v2 continued. Scenario 1 v2 delivery 2 request 004 recorded a `TimeoutError` after 147,545,659 ms. Its final memory replaced the independent studio fact with the corrected 19 November launch after missing the 12 November launch input, so that result is contaminated by the interrupted transport. The interrupted artifacts remain preserved, while the fresh isolated replay is the primary Qwen case-1 comparison. Qwen wall-clock duration is not comparable with the other runs, and this report does not claim that all Qwen full-suite transports succeeded.
- The current table records the reviewer's supplied semantic judgments. The interrupted and repeated Qwen case-1 outcomes are both shown because their semantic results differ.
