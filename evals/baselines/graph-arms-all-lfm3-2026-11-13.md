# Graph arms: all four arms on LFM3 (2026-11-13)

Question: do we need graph, and where? Dataset `evals/datasets/graph-arms.json` (30 inputs, 14 questions).
Script `evals/scripts/graph-arms-eval.ts`, OpenRouter `liquid/lfm-3-1.7b`, one run.
Raw: `evals/.data/graph-arms/all-2026-11-13T13-29-42.988Z/` (`answers.md`, `result.json` with every call).
Scored by hand. No LLM judge.

## Setup

One Brain run, two text neurons (kitchen, household), batches of 3. Three graph prototypes built from the same run:

- **Arm 0**: text neurons only.
- **Arm 1**: graph neuron. Its own graph, fed the raw input batches.
- **Arm 2**: text + graph in one neuron. Each neuron also keeps a graph, fed by its own extract output.
- **Arm 3**: Brain-level graph. One shared graph, fed by both neurons' extracts.

A graph is plain text, one fact per line: `Subject (who) | relation | Object (who) | date`. Same update prompt in all arms.
All arms answer the same way: one call with that arm's memories. So only where the graph lives changes.
Note: this answer path is not `brain.ask`. Arm 0 here scored 11/14; with `brain.ask` it scored 9/14 (`graph-arms-arm0-lfm3-2026-11-13.md`).
The old graph code (`src/neurons/graph/`) was not used: it passed 1 of 4 stages on LFM3.

## Results

| Q | Scen. | Arm 0 | Arm 1 | Arm 2 | Arm 3 |
|---|---|---|---|---|---|
| q01 spare key now | 1, 2 | ✗ Alex Rowan | ✓ | ✗ Alex Rowan | ✓ |
| q02 loan approver, still advisor | 1, 2 | ✓ | ✓ | ✓ | ✓ |
| q03 electrician's phone | 1, 3 | ✗ coach's | ✗ coach's | ✗ coach's | ✗ coach's |
| q04 coach = electrician? | 1, 3 | ✗ yes | ✗ yes | ✗ yes | ✗ yes |
| q05 water damage repair | 2 | ✓ | ✓ | ✓ | ✓ |
| q06 on leave in March | 2 | ✓ | ✓ | ✓ | ✓ |
| q07 contact now | 2 | ✓ | ✓ | ✓ | ✓ |
| q08 countertop + cost | 2 | ✓ | ✓ | ✓ | ✓ |
| q09 sockets | 2 | ✓ | ✗ six | ✓ | ✗ six |
| q10 cabinet maker's phone | 3 | ✓ | ✓ | ✓ | ✓ |
| q11 tap fixer in kitchen | 3 | ✓ | ✓ | ✓ | ✓ |
| q12 plumber's phone | 3, 4 | ✓ | ✓ | ✓ | ✓ |
| q13 tiles + contact now | 4 | ✓ | ✓ | ✓ | ✓ |
| q14 who to call about tile | 3, 4 | ✓ | ✓ | ✓ | ✓ |
| **Total** | | **11** | **11** | **11** | **11** |
| Same name (q01–q04) | | 1/4 | 2/4 | 1/4 | 2/4 |

Cost:

| | Arm 0 | Arm 1 | Arm 2 | Arm 3 |
|---|---|---|---|---|
| Extra learn calls (on top of 53) | 0 | +10 | +18 | +18 |
| Memory (~tokens) | 1,389 | 1,623 | 2,040 | 1,790 |

## What the graphs actually hold

- **Mo Haddad** is one person in every graph (arm 2 household: `Mo Haddad | role | electrician` and `Mo Haddad | role | football coach`). The kitchen text notes even call the electrician "son's football coach".
- **Morgan Lee**: arm 3 merged them in the graph (`Morgan Lee (12) | mortgage advisor`). Arm 1 kept no "returned" fact. Arm 2 household kept them apart, but arm 2 still answered q01 wrong.
- So the q01 wins in arms 1 and 3 are not from the graph keeping people apart.

## Conclusion

On LFM3, none of the three ideas fixes same-name people. All tie at 11/14. The merge happens when the model writes the facts, and a graph written by the same model makes the same merge, wherever it lives.
Graph adds 10–18 calls and 17–47% memory for no gain here.

Limits: one run; the graph is a plain-text prototype, not the old graph code with ids and identity rules (which does not run on LFM3).
