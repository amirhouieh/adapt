# Bounded signals

`src/brain/signals/` separates semantic assessment from durable signal state.
Neither part reads original inputs or source excerpts. The assessment sees only
supplied committed change identities, current learned-memory views, prior
accepted signal summaries, and a versioned developer policy.

## Assessment boundary

`assessSignals` makes one bounded call through the injected learning model. A
signal may concern one lens or a shared implication across lenses. Change and
memory identities remain scoped by lens; matching bare IDs across lenses is not
treated as semantic identity.

Code validates every returned lens, memory, revision, and scoped change. A
signal or silent result must explicitly settle every supplied change exactly
once. If any change remains uncertain, the whole assessment is deferred and
all changes remain pending. Cancellation and request-bound overflow also
defer without consuming work.

The semantic assessor is not accepted for the required local model yet. Its
formal real-model evaluation remains blocked by the model decision-quality
review. Mechanical tests cover bounds, cancellation, result partitions,
identifier validation, revisions, and input detachment.

## Durable state boundary

`createSignalStateStore` uses one supplied, versioned `BrainStore.state` record
and existing `runAtomic` transactions. It stores:

- pending assessments containing only policy and scoped committed-change IDs;
- terminal assessment receipts;
- accepted derived signal meaning and referenced learned-memory IDs;
- exact change-set deduplication and declared-scope cooldown records;
- leased delivery records.

Accepted signal, receipt, exact-dedup record, cooldown record, and initial
delivery are written atomically. Reusing an assessment ID with a different
intent is a conflict. Exact deduplication and cooldown are independent: the
first keys a canonical scoped change set, while the second can suppress a new
change only within the configured scope and policy version.

Every write enforces the serialized state bound, including caller-supplied
lease and error strings. Capacity pressure leaves prior state unchanged and
returns backpressure where the operation contract supports it. Pending
assessments and undelivered accepted signals are never removed by metadata
pruning. Expired terminal metadata may be pruned only after live references no
longer require it.

The state document is intentionally bounded by supplied counts, character
limits, and retention durations. It is not a second general persistence
framework or a raw-input archive.

## Verification status

Focused mechanical tests currently pass for Memory and Node SQLite (28 tests)
and Bun SQLite (9 tests). The dedicated no-model eval corpus and harness are:

- `evals/datasets/signal-store.json`
- `evals/config/signal-store.json`
- `evals/scripts/signal-store-eval.ts`

The accepted scoped store run is preserved at
`evals/.data/v2/signal-store/module-signals-store-2026-10-01/`. The parent
inspected the complete Memory result and full Memory/Node/Bun diffs. It accepted
enqueue replay/conflict, atomic accepted-signal and delivery state, exact dedup
versus cooldown, lease reclaim/retry, reopen, explicit backpressure, and
preservation of pending and undelivered work through metadata expiry. This is
store-mechanics evidence only; it does not accept semantic `assessSignals`,
public Brain integration, process-crash recovery, or external delivery.

Brain lifecycle wiring, originating change-outbox settlement, and outward
delivery effects remain outside this isolated module.
