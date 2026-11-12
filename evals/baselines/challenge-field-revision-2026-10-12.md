# Challenge: is the field-revision gap the implementation or the model?

Written 2026-10-12, before any run in this document.

## Pass criteria

- **Target:** at least 95% of dimension ratings within the reviewer's acceptable ranges on a fresh held-out stream, written with its reviewer key before any run, with the procedure source and configuration frozen. Reported separately for Qwen3.5 2B and Qwen3.5 9B, both local. An unset dimension counts as not observed.
- **Hard limits on that stream:** no dimension reaches integrated, instruction-like input has no effect, and no checkpoint has a dimension two or more levels away from its range.
- **v1 comparison:** the same streams and keys run through what v1 offers for this neuron in Seren today, on the same local models.
- Cloud models are not used.

## Method

1. **Perfect-answer test.** Correct answers to every question the procedure asks are written by hand for every note, answering each question literally rather than to fit the reviewer key. These replace the model in the real procedure. The score is the ceiling of the design: misses here belong to the implementation, the indicator questions, or the keys.
2. **Fix design faults** found by step 1, using the development stream and the first held-out stream only.
3. **Improve model answers** where the model is the remaining cause.
4. **v1 versus v2** on all streams.
5. **Fresh held-out stream** with everything frozen. Its result stands as measured.

## Step 1: perfect-answer test

Hand-written literal answers ([development](../datasets/structured-text-learning/oracle-answers-clinical-dimensions.json), [held-out](../datasets/structured-text-learning/oracle-answers-clinical-dimensions-heldout.json)) replaced the model through `field-revision-eval.ts --oracle`. The labels were written after earlier model runs on these two streams had been seen.

| Confirmations | Development | Held-out | Total |
|---|---|---|---|
| 2 | 17 of 20 | 15 of 15 | 32 of 35 (91%) |
| 1 | 15 of 20 | 13 of 15 | 28 of 35 (80%) |

With perfect answers the design reaches 100% on the held-out stream, so every held-out miss in earlier runs was a model error. On the development stream the design misses agency at input 37 and somatic processing at 37 and 49. Several notes literally answer the established questions for those capacities, while that key, written before the indicator questions existed, judges them developing. This is a calibration disagreement between that key and the configured questions. The key was not edited. The earlier 9B development run missed exactly these three ratings, so those were not model errors either.

Two confirmations beat one under perfect answers too, so the rule stays.

## Step 2: where the models go wrong

Each model's answers in the earlier runs were compared with the literal labels, by the level each indicated per note and dimension:

| Run | Exact level per note | Too high | Too low |
|---|---|---|---|
| 2B, held-out | 84% | 4 | 8 |
| 9B, held-out | 77% | 16 | 2 |

The dimension-selection step says yes too often for both models, which costs calls but almost never hides a real level. 2B mostly misses levels that are there. 9B mostly credits a moment to the wrong capacity, for example eating breakfast before an interview as agency.

## Step 3: prompt changes tested against labels

Every indicator question was asked for every dimension of every relevant note, against the labels. Variants: V0 current; V1 names the capacity; V2 names the capacity and tells the model to answer NO when the note shows a different capacity; V3 strict literal reading; suffix n uses gender-neutral questions.

| Model and stream | V0 | V1 | V2 | V3 | V2n |
|---|---|---|---|---|---|
| 2B, development | 79% | 77% | 77% | 78% | 75% |
| 9B, development | 79% | | 82% | | 82% |
| 2B, held-out | 90% | | | | 88% |
| 9B, held-out | 86% | | | | 88% |

Combining two phrasings, counting a level when either detects it, did not help 2B: its misses are the same whichever way it is asked. V2n halves 9B's false credits on the development stream and costs 2B two to four points. One prompt is kept for both models. V2n is adopted because only 9B has a realistic chance at the target. The indicator prompt now names the capacity and its description, and the challenge configs use gender-neutral questions. The perfect-answer results are unchanged with V2n: 17 of 20 and 15 of 15.

## Fresh held-out stream

[Stream](../datasets/structured-text-learning/stream-clinical-dimensions-heldout-2.json), [reviewer key](../datasets/structured-text-learning/reviewer-key-clinical-dimensions-heldout-2.json), and [literal labels](../datasets/structured-text-learning/oracle-answers-clinical-dimensions-heldout-2.json) were written together before any run on them. Their hashes were recorded at writing time and verified before the frozen runs. It is a different client (a man with burnout after a breakup), in a different note style, with five checkpoints giving 25 checks, so 95% allows one miss. Somatic processing should stay low, and one note has the therapist, not the client, noticing body tension.

## Step 4 and 5: frozen runs

Source, configs, streams, keys, and labels were hashed before the chain and verified unchanged after it. The Mac was kept awake. v2 runs use the [challenge configs](../config/structured-text-learning/) (`challenge-*.json`). v1 runs use [clinical-list-v1-eval.ts](../scripts/clinical-list-v1-eval.ts) with Seren's own clinical-dimensions neuron config, copied read-only into [seren-v1-clinical-dimensions.json](../config/structured-text-learning/seren-v1-clinical-dimensions.json). v1 is scored by the most recent item per dimension.

| Run | Development | Held-out 1 | Fresh held-out |
|---|---|---|---|
| Perfect answers | 17 of 20 | 15 of 15 | 25 of 25 |
| v2, Qwen3.5 9B | 18 of 20 | 14 of 15 | **23 of 25 (92%)** |
| v2, Qwen3.5 2B | 9 of 20 | 12 of 15 | 15 of 25 (60%) |
| v1, Qwen3.5 9B | 13 of 20 | 14 of 15 | 14 of 25 (56%) |
| v1, Qwen3.5 2B | 9 of 20 | 6 of 15 | 8 of 25 (32%) |

Run folders: `evals/.data/challenge-{dev,heldout,heldout-2}-{qwen,qwen9b}/`, `evals/.data/challenge-heldout-2-qwen-oracle/`, and `evals/.data/clinical-list-v1/`.

**Target not met.** The best frozen result on the fresh stream is 9B at 23 of 25, one miss short of 95%. Both misses are somatic processing at emerging at inputs 12 and 18, caused by one note: 9B counted tearing up as noticing a body sensation, and a first rating needs no confirmation. The therapist-noticed distractor was correctly ignored. Hard limits held for every v2 run: nothing reached integrated, the forwarded system note had no effect, and nothing was two levels off.

**v2 against v1.** v2 scored higher than or equal to v1 on every stream for both models, and much higher on the fresh stream. v1 on 2B dismissed most inputs and kept at most one item on the fresh stream, and on held-out 1 it rated emotional regulation and self-awareness integrated from the first checkpoint. v1 on 9B over-rated somatic processing and took 38 to 54 minutes per stream against 10 to 17 for v2.

**The prompt choice broke 2B.** A post-hoc check, run after the frozen results were known and not counted toward the target, restored the earlier indicator prompt while keeping the gender-neutral questions. The frozen source was restored afterwards and its hash verified. Runs are in `evals/.data/challenge-posthoc-old-prompt-qwen/`.

| 2B indicator prompt | Development | Fresh held-out |
|---|---|---|
| Frozen: names the capacity, strict | 9 of 20 | 15 of 25 |
| Post-hoc: earlier plain prompt | 18 of 20 | 22 of 25 (88%) |

The strict prompt made 2B miss even more levels, and with two sessions needed to confirm a move, missed levels compound into lag. The per-note probe predicted a small loss for 2B, two to four points, and underestimated this badly. The indicator prompt suits 9B and the plain prompt suits 2B, so the prompt should follow the model rather than be one fixed text.

## Conclusion

- The implementation is not the bottleneck on held-out data: with perfect answers the design scores 100% on both held-out streams.
- The remaining gap is model judgment. On the fresh stream it is one note for 9B and three checkpoints for 2B with its better prompt.
- 95% was not reached. Best frozen result 92% (9B); best 2B result 88%, post-hoc.
- v2 beats v1 on these streams for both local models, by 36 points on the fresh stream with 9B.
- On the development stream, three misses that remain even with perfect answers come from a key written before the indicator questions, which judges somatic processing and agency more strictly than the questions do.
