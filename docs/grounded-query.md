# Learned-memory query boundary

`src/brain/query/` is the isolated query portion of Adapt v2 module 8. It reads a supplied committed registry snapshot, matching learned-memory revisions, and current pending-learning metadata. It returns a bounded answer, knowledge gap, deferral, or failure. It has no store access and performs no writes.

This follows Adapt's original product contract: queries answer from learned neuron understanding rather than original input. The snapshot contains no source records, copied excerpts, or support IDs. Learned memory remains queryable after source input is disposed.

The runner copies and freezes its inputs before asynchronous work. Every registry entry must match one learned-memory snapshot exactly. This rejects half-committed state before a provider call. An answer lists `usedMemoryIds`; code rejects any ID outside the selected current snapshots. The existing revision pins let callers resolve the exact registry, memory, and configuration revisions used.

Candidate selection is a narrow injected capability. The included selector uses the existing Adapt structured-generation boundary and local scheduler. Candidate count, individual learned-memory content, total context, full request, and response prose are bounded by supplied policy. User constraints and policy instructions remain intact; when they cannot fit, the runner defers. Omitted memory and pending learning remain explicit in the result.

After bounded selection, the answer stage uses a v1-shaped specialist contract.
It reports relevance separately from sufficiency. An insufficient result must
leave `answer` empty and explain the missing fact; a sufficient result must be
relevant, contain a direct answer, and cite at least one selected memory ID.
Code rejects contradictory shapes and unknown IDs. The model receives selected
learned memory only; pending and omitted-state metadata are handled by code and
are not answer-generation inputs.

Pending learning does not replace committed understanding. The runner adds a pending-state gap only when pending work targets a memory the answer actually used. Unrelated pending or omitted memory does not mechanically suppress an answer established by selected committed memory.

Legacy `DirectMethod` and Brain direct synthesis remain outside this isolated contract because they do not pin registry and memory revisions. The reusable parts are Adapt's direct learned-memory semantics, structured-generation interface, local provider scheduler, and retry owner.

The same-model diagnostic at
`evals/.data/v2/diagnostics/v1-direct-airline/2026-09-30T21-30-28.460Z`
showed why relevance alone is insufficient: v1 produced a useful refusal but
also returned `relevant: true` and an invalid numeric relevance later clamped by
core repair. The repaired contract makes sufficiency the answer gate. This was
a single-specialist prompt/schema diagnostic, not a historical transport or
whole-Brain comparison.

The corrected fixed synthetic corpus is `evals/datasets/v2-grounded-query.json`. It contains committed learned memory and pending metadata only, with no original source inputs or excerpts. The formal corrected run is preserved at `evals/.data/v2/grounded-query/2026-09-30T19-53-01.246Z`. It is rejected semantic evidence: the unrelated airline question returned an answer grounded in deployment-policy memory; the positive answer omitted the linked audit-record-before-approval and tested-rollback requirements; and cases with no pending learning invented pending-learning gaps. The region-uncertainty, bounded Atlas, and adversarial cases behaved as intended. The earlier support-based run at `evals/.data/v2/grounded-query/2026-09-30T17-17-05.296Z` also remains unchanged as rejected historical evidence. No tuning or rerun followed either result.

This boundary does not implement module 8 signal persistence, cross-lens assessment, optional wait/flush orchestration, or Brain lifecycle wiring.
