# Original v1 tasks on local Qwen models — 3 November 2026

Status: 20 runs collected and manually reviewed. The user authorized judgment against learning quality over time. See [full judgment](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-2026-11-03.md).

## Question and scope

Does the current v2 text-learning path preserve and improve the abilities covered by the original v1 task corpus when both versions use the same local Qwen models?

Five tasks: the original seven coffee inputs and instruction change; 24 preference-change events; 85 personal-behavior events; 150 developer-memory events; and 120 therapist-profile events. The latter four use their original dataset metadata questions and the first generic learner lens. The complete Brain behavior test is not replaced by this standalone lens comparison.

Models: `qwen/qwen3.5-2b` and `qwen/qwen3.5-9b`, installed GGUF Q4_K_M variants through LM Studio and Adapt's AI SDK plugin. One model is loaded at a time, context 8192, parallelism 1, thinking already disabled in each model's existing configuration. Each arm uses temperature 0, an output cap of 2048, no provider retries, and a 120-second call timeout. Other sampling defaults are the installed model's existing defaults, shared between arms of that model.

V1 is the unchanged source at `e2150ed3970d41125cb36d5c46f65e981ad2f088` in `adapt-memory-v1-baseline`. V2 is the uncommitted adaptive public TextNeuron with fixed `adapt.text-procedure.line-revision` version 2. This does not test automatic procedure selection.

## Evidence and review

Raw suite: [2026-11-03T13-20-27.943Z](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z).

- [Frozen task definitions, settings, disclosures and source hashes](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z/suite.json).
- [Review status: judgment complete](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z/review-status.json).
- [Process records](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z/processes.json).
- [Runner](/Users/amir/projects/adapt/adapt-memory-v2/evals/scripts/original-v1-qwen-comparison.ts) and [serial model orchestration](/Users/amir/projects/adapt/adapt-memory-v2/evals/scripts/run-original-v1-qwen.py).

Each job saves exact wire requests/responses, plugin requests, public neuron events, learning outcomes, checkpoint understanding, complete final queries, and SQLite databases. Stores are closed and reopened at the middle and final checkpoints. Token counts and runtime are measured separately from semantic review.

**The user subsequently authorized judgment against one high-level principle: learning quality over time.** The [manual review](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-2026-11-03.md) evaluates whether understanding becomes more useful and is meaningfully revised as evidence arrives. No numerical score, acceptance threshold, or new model run was introduced. Historical task objectives remain reference material.

Common dataset input text follows the actual v1 behavior formatter: `[timestamp] [type] [source: source]\ncontent`. Source tags are omitted when absent; the preference dataset retains its author as an author tag. Both arms receive exactly the same dated text. Event IDs remain in delivery metadata. The v2 delivery envelope supplies the same event ID and the same timestamp instant normalized to ISO with milliseconds. Both arms receive groups of eight, forced to synthesize/flush at the same boundaries. Coffee preserves the original groups of three and four, original questions, and espresso-only instruction change. V1 alone can exercise the original legacy importance-threshold update; v2 has no equivalent setting. Both can switch governance strategy. Public query implementations differ between versions; this is a pipeline comparison, not an isolated learner-only experiment.

Internal memory policies also differ: v1 keeps its existing text schema and cumulative governance configuration, while v2 uses the existing line-revision profile's 10,000-character narrative cap and compaction settings. Job inputs record the complete configurations. Results cannot isolate procedure effects from these policy differences. Runtime measurements are observational: run order, prompt caching and warm-up are not controlled.

## Diagnostic runs excluded from the comparison

[Earlier JSON-format runs](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T12-59-52.470Z) are preserved and marked `DIAGNOSTIC-ONLY.json`. All premature semantic notes are withdrawn; they are not current judgments or approved criteria. Inspection of the actual v1 behavior runner showed it used dated plain text, not the adapter’s JSON text. Input representation can affect small models, so those outcomes do not support an original-format comparison conclusion. No prompts or production code were tuned using those outcomes. The current suite restarts with the source-derived input representation, canonical delivery-envelope timestamps, and the supported native configuration of each public API.

## Results

Raw outputs for all 20 runs are saved. The authorized [full judgment](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-2026-11-03.md) finds useful, task-dependent v2 gains, but no consistent improvement over v1 in learning quality over time on either Qwen model. V1 also has substantial failures. Separate [2B](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-2b-2026-11-03.md) and [9B](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-9b-2026-11-03.md) reviews link the raw evidence. Earlier premature judgments remain withdrawn; this fresh review follows the user's later instruction. Successful process completion alone only establishes execution completion.

The [collection inventory](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z/collection-completion.json) lists all final run folders and raw-file counts. `processes.json` records initial attempts; [transport-retries.json](/Users/amir/projects/adapt/adapt-memory-v2/evals/.data/original-v1-qwen/2026-11-03T13-20-27.943Z/transport-retries.json) records the repeated cases and locations of interrupted attempts. Four 2B cases were repeated after API connection refusal. The 9B v1 behavior case retained its initial timeout and laptop-sleep interruption before the completed run. Inputs, model settings and production source were unchanged for those repetitions.

## Remaining coverage gaps

- No equivalent current public v2 ListNeuron path for the original restaurant schema, item tracking and deduplication task.
- No assembled v2 Brain path for automatic decomposition, cross-neuron synthesis, network coverage, internal awareness or evolution.
- No evaluation of automatic learning-procedure selection here.
- One run per arm and model cannot establish stability or universal model support.

## Verification

The full source and eval TypeScript project passes. Production source, original v1 datasets, and original baseline source remain unchanged. No commit, push, deployment or publication is part of this work.

Judgment scope clarified: quality is assessed from committed learners' understanding over time. Query answers are excluded. The [current memory-only judgment](/Users/amir/projects/adapt/adapt-memory-v2/evals/baselines/original-v1-qwen-judgment-2026-11-03.md) supersedes earlier combined comparisons.
