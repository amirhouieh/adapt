# What has changed: does rewritten memory keep "used to X, now Y"? (LFM3, 2026-11-15)

## Setup

- Model: `lfm3-1.7b` on LM Studio, `http://localhost:1234/v1`, this Mac, on-device. Same model for neuron setup, learning and `ask`. No cloud fallback was needed.
- Wiring: `createOpenAICompatible` with `supportsStructuredOutputs: true`, passed to `createAiSdkLLM({ providers })`, as in `brain-two-step-smoke.ts`. Evolution off, `MemoryBrainStore`.
- Script: `evals/scripts/what-has-changed-eval.ts`. Raw logs: `evals/.data/what-has-changed/2026-11-15T21-10-37.588Z/` (one JSON per case and run, plus events). About 51 minutes (3057 s) for 10 runs.
- Per run: `Brain.create` with a one-sentence prompt (`autoSetup: true`), three `inject` calls (before the change, the change, after), then every neuron's final understanding and `ask('What changed about <topic>?')`.
- Measurement, no LLM judge: substring check for the old and new value (from the case data) in the neurons' final memory text. I then read every memory and answer.

## Cases

| Case | Old | New | Topic asked |
|---|---|---|---|
| editor | Vim | Zed | my code editor |
| diet | vegetarian | fish | my diet |
| owner | Sara | Tom | who owns the billing project |
| meeting | Monday | Thursday | the weekly planning meeting day |
| language | Python | Rust | my preferred programming language |

Each stream has 7 to 8 inputs; the change is stated once in the second inject, with unrelated inputs mixed in.

## Results

| Case | Run | Old in memory | New in memory | Both | Memory says it changed |
|---|---|---|---|---|---|
| editor | 1 | yes | yes | yes | yes |
| editor | 2 | yes | yes | yes | yes |
| diet | 1 | yes | yes | yes | yes |
| diet | 2 | yes | yes | yes | yes (one neuron; the other lists both with no change) |
| owner | 1 | no | yes | no | no |
| owner | 2 | no | yes | no | no |
| meeting | 1 | yes | yes | yes | yes |
| meeting | 2 | yes | yes | yes | yes |
| language | 1 | yes | yes | yes | yes, weakly |
| language | 2 | yes | yes | yes | yes, with a contradiction |

Substring "both": 8 of 10. After reading the text: old value, new value and the fact of change are all present in 8 of 10. The two misses are the same case.

## Quoted examples

Kept (editor, run 1, neuron `coding-tools`): "I previously spent ten years with Vim ... This week I switched from Vim to Zed ... my old Vim keybindings are no longer in use."

Kept (meeting, run 1): "Weekly planning meeting is every Thursday at 10:00, starting next week (moved from Monday)."

Kept, one neuron only (diet, run 2). `health-tracking`: "You have been vegetarian for three years; your doctor suggested more protein, so you now eat fish again". Neuron `eating-habits` in the same run: "I have been vegetarian for three years now. ... Salmon twice a week." Both values, no change marker, so the neuron contradicts itself.

Weak (language, run 2): "Python is my go-to language for everything, scripts and services. I now prefer Rust over Python for anything serious." The change is there, next to a stale "go-to for everything" line. Run 1 keeps "now prefer Rust over Python" but adds invented lines ("Frameworks: None", "Debugging tools: Compile errors").

Lost (owner, run 1): "Tom owns the billing project and runs the weekly sync." Sara is gone. Run 2: "Tom is the owner of the billing project (billing launch on December 3)." The input said "Sara moved to the mobile team. Tom is now the owner"; the rewrite kept only the new state. After the "after" inject, the neuron had nothing to say about Sara.

## What `ask` returned for "what changed"

- editor, meeting, language: the answer states old and new. Editor run 1: "You switched your code editor from Vim to Zed this week". Meeting: "changed from Monday to Thursday". Language run 2: "Python as your primary/go-to language ... now favor Rust".
- Editor run 2 added an error: "Your existing Vim keybindings remain unchanged". The memory did not say that.
- diet: run 1 reports the shift to fish after being vegetarian. Run 2 answers "vegetarian three years ago; you recently added two servings of salmon per week", and says nothing about eating fish again being a reversal.
- owner run 1: the answer says "ownership moved from Tom to Sara", which is backwards. The neuron said Tom; the answer took Sara from "global context" and described the neuron's Tom as the old value. Owner run 2: "two different statements ... I can't give a single definitive answer"; its gaps field notes the global context says Tom is now the owner, "previously owned by Sara".
- So for owner the only place the history survived was the brain's internal global context, which `ask` read, and which this eval did not capture. `ask` then mixed it up with the neuron's text.

## Conclusion

Sometimes: rewritten understanding kept "used to X, now Y" in 8 of 10 runs (4 of 5 cases, both runs each). It dropped the old value in both runs of the owner case (0 of 2).

This is retention of the sentence the input contained ("moved from Monday", "switched from Vim to Zed"), not a designed property. Nothing in the rewrite keeps history when the input states only the new state, and nothing in the memory format preserves old values. With two runs per case this says history survives when the input narrates the change and can vanish when a later rewrite compresses it. Do not document it as a guarantee. History needs an explicit store (dated snapshots, the user's own messages), which strategy section 8 already plans.
