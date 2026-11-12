# Field revision: fixed-structure memory on a local model — 2026-10-11

Status: mechanics working; learning of clinical ratings rejected on Qwen 3.5 2B. Nothing committed.

## What was built

A new registered procedure, `adapt.text-procedure.field-revision` version 1, in [field-revision.ts](../../src/learning/text-procedures/field-revision.ts). It keeps one JSON object whose fields are fixed by a developer schema: leaf fields or one level of grouped leaf fields, typed as text, enum, number, boolean, or list of text. It runs inside the existing executor, coordinator, and SQLite path, configured by a typed `fieldRevision` profile section.

Per input the model answers small questions: is the input relevant, does it try to control the memory (optional), does it directly show something about each field group, and what each affected field's value is now. For an ordered rating that already has a value, the model only answers BETTER, WORSE, or SAME for this one input, and code moves the rating by one step. Code validates every value against the schema, skips a field whose answer hits the output limit, and records each change with the input's own date in the change history, beside the current object.

Tests: [adaptive-text-field-revision.test.ts](../../tests/adaptive-text-field-revision.test.ts), 11 cases. Full Vitest 529 passed; the one failing file needs a cloud API key.

## Evaluation

A new synthetic stream modelled on Seren's clinical-dimensions neuron: one client over 16 sessions, 49 inputs including scheduling noise, one duplicate delivery, and one planted instruction, with a regression during a hospitalization and gradual recovery. The reviewer key, written before any run, gives acceptable rating ranges per dimension at four checkpoints.

- Stream: [stream-clinical-dimensions.json](../datasets/structured-text-learning/stream-clinical-dimensions.json)
- Reviewer key: [reviewer-key-clinical-dimensions.json](../datasets/structured-text-learning/reviewer-key-clinical-dimensions.json)
- Runner: [field-revision-eval.ts](../scripts/field-revision-eval.ts), production procedure through the real Adapt AI SDK provider, memory carried forward across batches of 4, every call saved.
- Config: [clinical-dimensions-qwen.json](../config/structured-text-learning/clinical-dimensions-qwen.json), Qwen 3.5 2B, context 4096, temperature 0.

Three diagnostic runs, each changing one thing:

| Run | Change | Result |
|---|---|---|
| [19-28-05](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T19-28-05.420Z) | First version: current value shown, conservative wording | All ratings stuck at emerging; Qwen copied the current value in 146 of 146 rating answers. Evidence text was echoed prompt. |
| [19-34-23](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T19-34-23.425Z) | Model rates the moment only, code moves one step | Qwen rated 138 of 141 moments "emerging" regardless of content. Evidence became the literal field name. One answer hit the output limit and failed a batch. |
| [19-42-22](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T19-42-22.578Z) | BETTER / WORSE / SAME once a rating exists; level descriptions; description-based evidence | 131 of 135 direction answers were SAME. All 4 BETTER answers credited emotional regulation for notes about other capacities, which pushed it to integrated by the end. The other dimensions stayed at emerging. Evidence was grounded but the same sentence went into several dimensions. |

The evidence cross-contamination came from the prompt naming only the shared evidence description, not the capacity. It is fixed in code and covered by a test, but not yet re-run.

## Assessment

The mechanics work: every batch committed, changes are dated, the step guard holds, and irrelevant and instruction-like inputs are skipped. Learning clinical ratings does not work on a 2B model. In isolated probes Qwen judged direction correctly for clear single-capacity notes, 7 of 8, but in the real stream each note touches several capacities, and the model neither attributes the moment to the right capacity nor judges change. Asking it for an absolute level on an abstract scale fails outright, with or without level descriptions.

Fixed structure itself is not the problem: field selection, enum validation, history, and grounded evidence sentences all behave. The failure is asking a small model for an abstract clinical judgment. Possible directions are in the session summary; none is implemented.

---

## Update: indicator questions

The user accepted roughly 70% accuracy and ruled out a larger local model for memory reasons. Ordered ratings can now be driven by optional `fieldRevision.indicators`: one concrete yes/no question per level above the lowest, written by the developer. The model only answers those questions. Code takes the highest level answered yes as what the input shows and moves the stored rating one step toward it. Covered by two new tests; 13 field-revision tests pass.

In direct probes the yes/no answers were right for about 65% of single notes, with errors in both directions; wording changes moved this between 9 and 13 of 19.

Run: [19-59-45](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T19-59-45.386Z), same stream, key, and settings as before, plus indicators. 1,074 calls, about 6.6 minutes for 48 inputs, every batch committed.

| Checkpoint | Within acceptable range | Misses |
|---|---|---|
| 12 | 4 of 5 | Relational flexibility not yet set; the key accepts not observed or emerging |
| 24 | 5 of 5 | |
| 37 | 4 of 5 | Somatic processing emerging, expected developing |
| 49 | 4 of 5 | Somatic processing emerging, expected developing |
| Total | 17 of 20 | |

No rating reached integrated, and the planted instruction to rate everything integrated had no effect. The change history shows flapping: somatic processing moved between emerging and developing five times, and emotional regulation dropped back once after a session where she handled a bad presentation well. Evidence sentences are grounded in real notes but sometimes describe a moment that belongs to another capacity, and often open with "The note describes".

Assessment: indicator-driven ratings meet the agreed bar on this one development stream and one run. The main weakness is single-note noise, which the planned two-notes-in-a-row rule would address. Repetitions and a held-out stream have not run.

---

## Update: confirmation rule, repetitions, held-out

Changes, covered by two new tests (15 field-revision tests pass):

- `fieldRevision.confirmations`: an ordered rating moves one step only after that many distinct sessions point the same way. Notes from one session count once. A note pointing the other way resets the count; a note at the current level does not. Waiting counts live under a reserved `_pending` key in the understanding, which apps should ignore. The schema may not define `_pending`.
- Evidence follows the rating: when a group has indicator questions and none was answered yes for a note, the group's other fields are not revised for that note.
- The evidence prompt asks for a sentence that starts with what the person did and stays inside the named field.

Scoring: an unset dimension now counts as not observed, matching how code treats it. Under that rule the indicator run above scores 18 of 20, not 17.

### Development stream

| Run | Rule | Score | Level moves |
|---|---|---|---|
| [19-59-45](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T19-59-45.386Z) | No confirmation | 18 of 20 | 15, including 7 reversals |
| [20-21-03](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T20-21-03.829Z), [20-25-34](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T20-25-34.520Z), [20-30-03](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T20-30-03.263Z) | Two sessions, reset on same level | 15 of 20, all three identical | 4, no reversals |
| [20-35-57](../.data/field-revision-clinical-dimensions-qwen/2026-10-11T20-35-57.446Z) | Two sessions, reset only on opposite direction | 16 of 20 | |

The confirmation rule removes flapping but adds lag. Every remaining development miss is a dimension still at emerging when the key expects developing, mostly at input 37. Somatic processing never reaches developing.

### Held-out stream

Written with its reviewer key before any run, for a different client (anger at work, a redundancy, an instruction-like message, admin noise). Source, config, and stream hashes were frozen and verified unchanged after the runs. Three repetitions: [20-41-01](../.data/field-revision-clinical-dimensions-heldout-qwen/2026-10-11T20-41-01.342Z), [20-44-00](../.data/field-revision-clinical-dimensions-heldout-qwen/2026-10-11T20-44-00.039Z), [20-46-40](../.data/field-revision-clinical-dimensions-heldout-qwen/2026-10-11T20-46-40.199Z). 529 calls and under 3 minutes each; all three identical.

| Checkpoint | Within range | Misses |
|---|---|---|
| 12 | 4 of 5 | Agency not observed, expected emerging or developing |
| 21 | 4 of 5 | Agency not observed |
| 30 | 4 of 5 | Agency emerging, expected developing or established |
| Total | 12 of 15 | |

Critical items all pass: nothing reached integrated, the practice manager message had no effect, and somatic processing stayed at emerging. Ratings only moved up, one step at a time.

The agency misses are model answers, not mechanics. Qwen answered NO to all four agency questions for every agency note on this client, including "setting a clear boundary" for a note where she refused a Saturday shift. Questions were not reworded, to keep the held-out result clean.

Evidence is grounded in real notes and never copied the instruction-like message, but Qwen mostly ignores the opener rule ("The client demonstrated X by...") and sometimes files a moment under the wrong capacity, for example being "snappy" as somatic evidence.

### Assessment

Fixed-structure field revision on Qwen 2B lands at about 80% of ratings within range on both streams, with no runaway ratings, no obeyed instructions, and stable runs. Accuracy is uneven by dimension: one dimension can fail completely for one client because the model misreads its questions. The mechanics hold; the ceiling is the 2B model's yes/no judgment.

---

## Update: Qwen3.5 9B (2026-10-12)

Same frozen procedure source, streams, keys, and settings; only the model changed. The model is `qwen/qwen3.5-9b` GGUF Q4_K_M (checksum verified), loaded at 4096 context with 1 parallel slot. LM Studio's catalog entry turns thinking on by default for 9B and off for 2B; with thinking on, every answer came back empty, so it was set to off to match the 2B runs. The original entry is kept as `model.yaml.orig`.

With 9B loaded, about 1.4 GB of the 16 GB was left free. Calls took a median of about 0.94 s. One held-out repetition shows 19 hours of wall time because the machine slept mid-run. Its answers match the other repetition exactly.

Runs: development [22-36-36](../.data/field-revision-clinical-dimensions-qwen9b/2026-10-11T22-36-36.608Z); held-out [22-54-09](../.data/field-revision-clinical-dimensions-heldout-qwen9b/2026-10-11T22-54-09.602Z) and [23-05-24](../.data/field-revision-clinical-dimensions-heldout-qwen9b/2026-10-11T23-05-24.474Z), both identical.

| | Qwen3.5 2B | Qwen3.5 9B |
|---|---|---|
| Development | 16 of 20 | 17 of 20 |
| Held-out | 12 of 15 | 14 of 15 |
| Total | 28 of 35 (80%) | 31 of 35 (89%) |
| Development run time | about 5 min | about 17.5 min |
| Held-out run time | about 3 min | about 11 min |
| Held-out critical items | All pass | Somatic processing reached developing at input 21, then dropped back |

9B's misses: on the development stream somatic processing was rated established at inputs 37 and 49 and agency established at 37, where the key expects developing. On held-out, somatic processing was developing at input 21. 2B's errors were ratings stuck too low. 9B's are ratings too high, mostly somatic processing. It fixed the held-out agency failure completely.

9B moves faster and reverses more often. On the development stream it made 16 level moves, including 2 reversals: emotional regulation went established and back, and self-awareness dipped once.

Evidence from 9B reads better and opens with what she did, as the prompt asks. It still sometimes files one moment under several capacities. On held-out, eating breakfast before the interview became the evidence for agency, self-awareness, and somatic processing.

Neither model obeyed the instruction-like message, and neither rated anything integrated.

### Assessment

9B is about 9 points better overall and removes the one complete dimension failure, at roughly 3.5 times the run time. It leaves little memory for other apps on a 16 GB machine. Its typical error is over-rating, the reverse of 2B's.
