# Local v1 text learning: 8 October 2026

The local execution path works. Reliable basic learning is still unresolved.
This is a diagnosis of unchanged v1 on two local models, not a DAG comparison.

## What ran

- Original committed TextNeuron and BaseNeuron from `e2150ed3970d41125cb36d5c46f65e981ad2f088`, loaded from the isolated v1 baseline checkout. Both manifests selected only `direct`; the current v2 BaseNeuron was not executed.
- Vercel AI SDK through LM Studio on localhost. No cloud inference.
- LFM2.5 1.2B MLX 8-bit, then Qwen3.5 2B GGUF Q4_K_M, one loaded model and one request at a time on the 16 GiB MacBook Pro. Context: 4096. Server parallel capacity: LFM 4, Qwen 1; actual requests were sequential.
- Native v1 request settings: observer temperature 0.2; initialization and synthesis omitted temperature. No seed or output-token override. Server defaults therefore still apply when a field is absent.
- The same eight frozen synthetic scenarios: 26 short English inputs, 1,672 characters, 288 space-separated words. A fresh neuron per scenario; forced synthesis and close/reopen after every delivery. One additional interruption/recovery sequence per model.
- Raw requests, responses, failures, and store snapshots remain untouched. This assessment is separate from them.

## Mechanical result

| Check | LFM | Qwen |
| --- | --- | --- |
| Completed model calls | 66 | 57 |
| Normal `stop` responses | 66 | 57 |
| Transport, model, or parsing errors | 0 | 0 |
| Matching ordinary/initialization store reopen checks | 36/36 | 36/36 |
| Recovery store reopen match | Yes | Yes |
| Pending observation survives SIGKILL, then is consumed | Yes | Yes |
| Frozen dataset byte matches | 8/8 | 8/8 |

Both had 19 successful worker exits and one intended SIGKILL. Both resumed synthesis in a fresh process. Source fingerprints stayed unchanged during each run. These checks establish execution and persistence, not correct knowledge.

The orchestrator inspected all 123 response contents, learned memory after every ordinary delivery, and recovery outputs. The eval infrastructure is accepted for this diagnostic; the learning behavior is not accepted as a reliable local baseline.

## Learning findings

| Case | LFM | Qwen |
| --- | --- | --- |
| Correct a date; retain studio location | Corrected the date but turned the studio's location into the launch venue. | Ordinary run kept location and corrected date, with an imprecise change from launch to announcement. Recovery repeat dismissed the studio fact and later retained the wrong old date. |
| Change email preference to Signal | Final memory drifted into an unsupported statement about timely alerts. | Observer dropped Signal from the correction; final memory retained both email and Signal. |
| Repeat the same weekly meeting | Observer lost timing in two inputs; final memory retained Tuesday 09:30 but shortened the identity. | First synthesis omitted all specific details from stored memory; later repetition restored the meeting details. |
| Resolve a tentative date | Treated the tentative date as scheduled before confirmation; eventually kept the confirmed date with unsupported significance claims. | Dismissed tentative information; retained the final confirmed date. |
| Two different people with the same name | Merged them and lost badge/start-date details. | Dropped the first badge, merged the people, then invented a transition/probation explanation. |
| Relevant project facts plus unrelated cafeteria text | Admitted cafeteria text, invented a connection, and lost the exact region/backup time. | Dismissed the unrelated text and retained both operational facts. |
| Repeated high-cache build failures and a later success | Invented causality and lost the grounded pattern. | Dismissed all four inputs; memory stayed empty. |
| General preference plus a changing scoped exception | Lost the general before-noon preference. | Dismissed the general preference; retained only the exception. |

Two failure locations are verified: the observer drops or rejects relevant content, and synthesis sometimes changes correct input into incorrect retained memory. SQLite faithfully stores those model outputs. The Qwen recovery repeat also shows that one successful ordinary example is insufficient to claim reliable learning.

## Controlled LFM settings check

Replayed the exact old case-1/delivery-2 observe and synthesis requests twice per condition: recorded settings (temperature 0, seed 7, output limit 768) versus native v1 request settings. Messages, generated skills, model, and strict response schema stayed unchanged. All eight calls returned normally.

Both conditions retained the observation correctly. Both synthesis conditions incorrectly turned a person's Delft location into a launch venue, on both repetitions. Removing the comparison's sampling/output overrides did not fix this specific error. This does not establish a universal model limitation or identify which prompt element is responsible.

## Interpretation and remaining work

- The saved older local v1 evidence includes coarse, reusable topic learning. It does not demonstrate reliable performance on this particular correction/retention suite. This is an evidence gap, not a claim that other unsaved successes never happened. See the [historical inventory](../.data/text-v1-execution-direct-local-lfm/2026-10-08T18-12-07.109Z/historical-local-v1-assessment.md).
- The mechanical gate passes for these two installed local models and this small workload. Basic semantic reliability does not.
- Generated cognitive skills, synthesis cadence, prompt/output-contract complexity, and runtime/model behavior remain possible contributors. They have not been individually isolated here. No neuron prompt or production learning code was changed.
- The earlier fixed-DAG Gemini experiment cannot support a recommendation to abandon personalized DAGs. It tested a fixed execution wrapper on tiny inputs, not user-specific capability evolution. Gemini remains diagnostic only, not Adapt acceptance evidence.
- Before a fair personalization comparison, resolve the observed local reading/writing failures and repeat the unchanged basic cases. A later comparison must exercise evolving user histories and capability needs against v1's existing personalization; that experiment has not run.

## Reproduction and artifacts

- [LFM suite config](../config/text-v1-execution-direct-local-lfm.json), [raw run](../.data/text-v1-execution-direct-local-lfm/2026-10-08T18-12-07.109Z/), [mechanical audit](../.data/text-v1-execution-direct-local-lfm/2026-10-08T18-12-07.109Z/mechanical-audit.json).
- [Qwen suite config](../config/text-v1-execution-direct-local-qwen.json), [raw run](../.data/text-v1-execution-direct-local-qwen/2026-10-08T18-17-44.170Z/), [mechanical audit](../.data/text-v1-execution-direct-local-qwen/2026-10-08T18-17-44.170Z/mechanical-audit.json).
- [Settings diagnostic config](../config/lfm-v1-sampling-causal.json), [raw run](../.data/v1/diagnostics/lfm-v1-sampling-causal/2026-10-08T18-23-13.351Z/).

Run the suite with `node --import tsx evals/scripts/text-v1-execution-dag-suite.ts <suite-config>`. Run the diagnostic with `node --import tsx evals/scripts/response-format-causal-eval.ts evals/config/lfm-v1-sampling-causal.json`. Load only the intended local model first.

Validation: eval TypeScript typecheck passed; five focused configuration/replay tests passed. Changes are confined to eval harnesses, configs, mechanical auditing, tests, and this report. The original user checkout and production neuron code were not edited by this work. No commit or push was made. Qwen was unloaded and the original LFM context/parallel configuration restored after the run.
