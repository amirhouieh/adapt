# Attention routing and bounded discovery

## Status

The isolated Attention module is mechanically verified but not semantically
accepted. It is not wired into `Brain.inject`; that lifecycle work belongs to
module 10.

The current Brain broadcasts every batch to every active neuron and invokes
gap handling only when all neurons dismiss the batch. See
`src/brain/class.ts` (`inject` and `handleDismissedBatch`). The isolated router
instead returns per-portion selected work and preserves partial, unknown, and
omitted work explicitly.

## Contract

`routeAttention` accepts:

- supplied stable portion and input identities, plus optional opaque source
  identity used only by explicit developer routing rules;
- compact lens descriptions, verbatim developer routing instructions,
  metadata, revision, and learning status;
- exact developer routing rules with integer priority;
- explicit bounds for inputs, request context, candidates, destinations,
  provider calls, uncovered spans, and follow-up actions;
- an injected candidate selector, learning model capability, and abort signal.

Each bounded candidate lens is assessed independently against the same
canonical portion and its own verbatim developer constraints. The flat result
separates relevance, certainty, and whether that one lens covers the whole
portion. The router derives combined coverage from those independent results;
it does not ask one model response to select multiple lenses and explain spans
at the same time.

It returns selected lens work, per-portion coverage and per-lens raw
provenance, whole-portion retention for partial/unknown work, bounded
discovery/recheck/pending actions, usage, and omitted portion IDs. A paused
lens may be semantically matched but receives no learning work. Candidate
truncation remains unknown and schedules a recheck.

Higher-priority routing directives win per lens. Equal-priority contradictory
directives or coverage rules are rejected. Immutable provider context is never
truncated: an oversized request is deferred with `context_bound` before any
model call.

`retainDiscoveryBuffer` is a pure bounded transition over unfinished discovery
work. The caller supplies the clock and age/count/character policy. Expiry is
anchored to first retention, same-ID canonical portion conflicts are rejected,
and every eviction reports `age`, `count`, or `characters`. Expired and evicted
entries are absent from returned retained state. The function does not persist
anything and is not a source archive; lifecycle persistence may keep only the
bounded entries that remain pending.

## Thro review at the pinned revision

Revision: `07b4545d9397463f4e86d4a8c454c22c39022cd8`.

- `packages/contracts/src/enhancement.ts`:
  `EnhancementInputSchema`, `CoverageStateSchema`, `CoverageRecordSchema`,
  `CoveragePartialitySchema`, and `PrimitiveCallProvenanceSchema` informed the
  explicit input identity, coverage, partiality, and provenance fields.
- `packages/storage/src/routing.ts`: `CoverageInput`,
  `RouteEnhancementResultRequest`, and `RouteEnhancementResultReceipt` show
  transactional publication coverage tied to Thro KB, asset revision,
  enhancer, PostgreSQL, and publication-generation contracts.
- `packages/primitives/src/meaning-registry.ts`: registry operations preserve
  source locators and inject providers, but implement media/entity meaning
  primitives rather than lens attention.

No Thro code was copied. Its coverage storage cannot be reused without Thro's
KB/enhancer/publication model and PostgreSQL transaction layer, and its meaning
registry depends on Thro contracts, executor invocations, media providers,
embeddings, and `sharp`. Adapt uses the shared local learning capability and a
smaller provider-neutral portion/lens boundary. The reusable ideas are explicit
  coverage, explicit opaque routing metadata, provider injection, and bounded
  declared inputs.

## Verification

Focused mechanical gate:

```text
./node_modules/.bin/vitest run tests/attention-routing.test.ts
19 tests passed
```

Before the formal run, both commands passed:

```text
./node_modules/.bin/tsc --noEmit --pretty false
./node_modules/.bin/tsc -p evals/tsconfig.json --noEmit --pretty false
```

The formal real-model run used the production local adapter and
`liquid/lfm2.5-1.2b` under the localhost-only child-process sandbox. LM Studio
itself ran outside that sandbox. Exact artifacts are under:

```text
evals/.data/v2/attention-routing/2026-09-30T17-15-17.462Z/
```

The run made eight successful HTTP exchanges with no transport failure. The
local probe succeeded and the external probe failed with `EPERM`. Raw request
and response bodies, full scenario inputs and outputs, buffer input/output,
network probes, and metadata are retained separately.

## Semantic assessment of the preserved run

This run is rejected for module acceptance.

- Negative unrelated content was left uncovered and retained correctly.
- The single-portion partial case selected preferences and retained the
  canonical portion.
- The longer mixed-content case selected preferences and conservatively
  retained the whole original portion within the request bound.
- Positive multi-lens routing selected both correct lenses, but the model also
  returned a contradictory whole-portion uncovered span. The router preserved
  it as partial instead of claiming completion.
- Ambiguous content was forced into both lenses.
- Large-registry selection recalled `dependencies` but also selected unrelated
  `registry-01`; candidate truncation was reported.
- Adversarial content did not obey the embedded command, but it also missed the
  explicit preference.
- The paused lens was identified and received no learning work, but the model's
  contradictory coverage caused a separate discovery action, which violates
  the fixed expected behavior.

No prompt, schema, corpus, or result was changed after observing this run. A
possible prompt/schema explanation was only a hypothesis and was not tested.
Further semantic work is paused for the model/config decision.

## Remaining integration and acceptance gaps

- Root must inspect and accept a future raw semantic run before module 7 can be
  complete.
- Module 10 must connect the router to Brain scheduling without changing query
  eligibility for paused lenses.
- Persistence of pending discovery entries and delivery/restart behavior remain
  Brain and store integration responsibilities; this module only computes
  bounded transitions and does not replace the learned-observation lifecycle.
