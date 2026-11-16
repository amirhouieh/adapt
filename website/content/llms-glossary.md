## Glossary

Terms in reading order; after the first, each definition uses only terms above it. API names are in code font. Terms marked *(next)* are reserved for later releases and never describe current behavior.

- **adapt**: a TypeScript library, `@unbody-io/adapt`, that learns from your data as it arrives, on your device. It isn't a store of chunks you search: it forms understanding, revises it when things change, and reorganizes itself around what matters, using small local models.
- **neuron**: one topic, its `instructions`, and a plain-text account of that topic, called its understanding.
- **understanding**: a neuron's plain-text account of its topic, rewritten whole when new input fits the topic. Read it with `neuron.getUnderstanding()`. The API also calls it the memory. A neuron keeps no past versions of its understanding.
- **brain**: today, your goal, written as one prompt, plus its neurons. `Brain.create` designs the first neurons from the prompt. You can also write them yourself.
- **inject**: `brain.inject(data)`. Learn from this data. In this release every active neuron reads the whole batch and keeps what fits its topic. Inputs are 2000 characters or shorter.
- **gap**: input that no neuron kept, or a question that no neuron could answer. The brain records both.
- **ask**: `brain.ask(question)`. Ask what the brain understands. Returns `{ insight, sources, gaps }`: the answer, the neurons it came from, and the answering model's own list of what it could not answer. That `gaps` field is a report, not the brain's gap records.
- **attention**: deciding what deserves effort. Not transformer attention. Today it decides only what each neuron keeps: every neuron reads every batch, keeps what fits its topic, and what none keeps is a gap. Next (#25), the brain spends effort on bursts (sudden spikes in how often something appears) and drift (slow change in what the data is about). Then (#26), on whatever broke its expectations.
- **signal**: a short note that something is missing or changed. Every gap sends one. Neuron health (how often a neuron dismisses input, and how relevant and confident its answers are), `brain.signal` and `brain.update` send them too.
- **evolution**: the brain creating, updating, merging or removing its own neurons, run by one agent that needs tool calling. Starts at 5 signals (`evolution.evaluatorSignalThreshold`) or with `brain.evolve()`.
- **self-evolving**: the pillar that the set of neurons changes through evolution, mainly from gaps.
- **background neuron**: one of four ordinary neurons the brain keeps about itself (also called internal neurons): global understanding, global query understanding, injection gaps, query gaps.
- **proactive**: the pillar that the brain knows what didn't fit its topics without being asked. In this release it is passive: gaps are recorded, sent as signals and fed to the gap background neurons, and your app reads them with `brain.consult` or the `brain:signal:received` event. No insight is pushed to your app.
- **local model**: a model served by a local OpenAI-compatible endpoint. `localModel()` is the default: `lfm3-1.7b` at `http://localhost:1234/v1`. Its id and address are saved with the brain.
- **local-first**: the pillar that adapt runs on a small model on your machine by default, because each neuron's job is narrow. Hosted models also work.
- **direct** and **deep**: the two `ask` modes. `direct` picks neurons with one call and needs JSON output. `deep` runs an agent loop and needs tool calling too.
- **relevance** and **confidence**: two scores from 0 to 1 that each neuron returns for a question. Relevance is how well its understanding fits. Confidence is how sure it is.
- **governance**: how a neuron keeps its understanding within a size cap. Three strategies: `cumulative` shortens when the cap is reached, `decay` shortens earlier and favours recent detail, `continuous` never shortens and stops learning when full.
- **store**: where a brain is kept. `MemoryBrainStore` is lost on exit. `SQLiteBrainStore` is saved to disk and restored with `Brain.restore(path)`.
- **expect** *(next)*: what the brain will anticipate from your data: a statistical baseline (#25) or a learned expectation (#26). Not in this release.
- **surprise** *(next)*: input that differs from a baseline or an expectation: a burst or drift (#25), or a miss against what the brain expected (#26). Not in this release. A gap is not a surprise: a gap is what fits no neuron.
- **predict** *(next)*: answering from what the brain expects, such as "what would I reply to Alex?" (#26). It will arrive as a new verb next to inject and ask. Not in this release.
