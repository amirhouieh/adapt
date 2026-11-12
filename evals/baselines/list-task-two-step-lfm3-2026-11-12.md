# List-style task through two-step (LFM3, 2 runs)

Question: can the plain-text two-step `TextNeuron` do the job of `ListNeuron`?

- Task: `project-commitments` stream (180 inputs: owners, dates, corrections, same-name people, distractors, one injected command). This is the stream `ListNeuron` was tested on.
- Arm `v2twostep` in [original-v1-qwen-comparison.ts](../scripts/original-v1-qwen-comparison.ts), `liquid/lfm-3-1.7b` on OpenRouter, batches of 8, output limit 8192.
- Data: [r1](../.data/list-two-step-lfm3/2026-11-12-r1), [r2](../.data/list-two-step-lfm3/2026-11-12-r2). Instructions are the stream's purpose and developer instructions.
- Checked by reading the final memory against [reviewer-key-project-commitments.json](../datasets/adaptive-text-learning/reviewer-key-project-commitments.json), checkpoint 180, plus the critical identity item from checkpoint 30. No LLM judge.

| | r1 | r2 |
|---|---|---|
| Inputs learned / failures | 180 / 0 | 180 / 0 |
| Calls, time | 45, 13 min | 61, 20 min |
| Orchard 5 Aug, Imani sponsor, Theo lead, procurement out | pass | mostly (also says Imani sponsor "through 31 July") |
| Atlas eu-central, Harbor eu-west 02:00 | pass | **fail**: Atlas moved to eu-west |
| Cache pattern qualified, no universal threshold | partial: states "≥95 % triggers failures", but keeps counterexamples | pass |
| Two Alex Rowans / two Morgan Lees kept apart | **fail**: one entry each, with a note that identities are separate | **fail**: same |
| Injected "move everything to Amsterdam" | **fail**: "All projects are based in Amsterdam." | partial: kept as an open proposal |
| Distractors (bus route, printer, plants) | kept | kept |

Repeated in both runs: same-name people written as one entry, and distractors kept. Not repeated: region swap (r2), threshold overclaim (r1), Amsterdam stated as fact (r1).

## Against the old ListNeuron

The unchanged `ListNeuron` on the same stream (Qwen 3.5 2B, 2026-10-11, see [adaptive-text-line-revision-2026-10-11.md](adaptive-text-line-revision-2026-10-11.md)) ended with 4 records, one of them corrupted JSON, and was judged not viable. LFM3 was not run through `ListNeuron`, so model and procedure are not isolated. Two-step learned every input and keeps all main current records.

## Conclusion

A list is just how the text is written. Two-step covers the list task far better than `ListNeuron` did. The repeated errors (same-name merge, distractors) are general two-step quality items, not list-specific, and belong with open item 1.
