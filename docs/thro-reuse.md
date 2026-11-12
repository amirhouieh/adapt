# Thro reuse record for Adapt v2 learning execution

Source baseline: Thro commit `07b4545d9397463f4e86d4a8c454c22c39022cd8`. Only committed files read through `git show` were assessed. Thro's dirty working tree was excluded.

## Extracted boundary

Adapt owns a small, pure recipe runner in `src/learning/`. It accepts a registered recipe version, registered operation versions, supplied root values, a memory type, revision pins, capabilities, a budget controller, and cancellation. It returns per-node raw outputs, bounded pending collection items, and a proposed `change`, `no_change`, `defer`, or `failure` result. It has no store, service, queue, database, or external-action dependency.

| Thro source symbol | Decision | Adapt target and reason |
|---|---|---|
| `VersionedEnhancerRegistry.register` and `get` in `packages/planner/src/index.ts` | Adapt | `LearningRegistry` retains immutable `(id, version)` registration. JSON tuple keys remove delimiter collisions. Recipes and operations replace Enhancers and primitives; installation/backfill state is excluded because it belongs to Adapt scheduling and persistence. |
| `Planner.create`, `flattenNode`, input binding, and ordering logic in `packages/planner/src/index.ts` | Adapt | `planRecipe` resolves exact operation versions, named root/node bindings, joins, and ordering. It removes Thro Enhancer selection, canonical snapshots, and storage-specific producer lookup. It adds memory/capability checks, numeric memory/configuration pins, bounded collection work, and a frozen root/configuration snapshot. |
| `validateTypedDag` in `packages/contracts/src/enhancer-design.ts` | Reuse mechanic | Adapt retains unique-node, missing-dependency, self-dependency, and Kahn cycle validation. Thro `TypeExpression` equality is replaced because Adapt must validate actual portable schemas. A consumer accepts the identical registered schema object or supplies an explicit structural acceptance function. Different shapes with the same textual identity are rejected. |
| `Executor.run` ready-batch loop in `packages/executor/src/index.ts` | Adapt | `runRecipe` retains dependency-ready parallel branches, ordered joins, output validation, failure isolation, and gate settlement. Thro Evidence, Observation, coverage, provenance, stored-input, and provider-write contracts are excluded. Adapt adds injected budget/cancellation, exact per-node raw output, explicit terminal learning outcomes, and pending overflow. |
| `Executor.run` gate behavior | Adapt | A false gate is `not_applicable` and blocks required descendants. A join may explicitly mark a skipped data input optional; failures remain failures. A missing or non-boolean gate output is a failure rather than empty success. |
| `boundedConcurrentMap`, `BoundedProviderScheduler`, and `callWithBoundedRetries` in `packages/primitives/src/provider-io.ts` | Reuse in module 2, not here | Provider scheduling and retry ownership belong to the injected local provider. Copying them into the executor would create two retry owners and two device queues. The recipe runner only validates declared capability names and supplies the shared cancellation/budget context. |
| `retrieveEntityNamespace`, `retrieveEntityCandidatesByMention`, and `resolveEntityJudgments` in `packages/primitives/src/meaning.ts` | Adapt later in List/Graph operations | Candidate bounding and explicit resolved/ambiguous/unresolved decisions fit Adapt. Thro's canonical Evidence/Observation/KbDefinition types do not. `normalizedEntityText` also uses regex, which is forbidden for this delivery. An Adapt operation must use lens-scoped inputs and explicit string or structured parsing. |
| `normalizeDateMentionCandidates` and `normalizeDateMention` in `packages/primitives/src/meaning.ts` | Adapt later | Partial-date validation and no-guessed-year behavior fit structured state tracking. The Thro Observation payload and stable-ID output do not fit Adapt's proposed-patch boundary. |
| `constructEntityRelations`, `constructCapturedNearRelation`, `constructSameTopicRelation`, and `resolveReferenceJudgments` in `packages/primitives/src/meaning.ts` | Adapt later in Graph operations | Relation construction and identity-resolution checks are useful, but endpoints and relation types must be lens-scoped Adapt values. Thro's source-reference graph and canonical store are excluded: Adapt retains learned relationships, not copies of original input. |
| `M4PrimitiveRegistry` in `packages/primitives/src/meaning-registry.ts` | Replace integration only | Its registry wiring depends on Thro contracts, provider instructions, broad content processing, and emitted canonical outputs. Adapt is text-only and registers small operations directly after type adaptation. |

## Transferred test behavior

The following Thro behaviors were carried into focused Adapt tests rather than copied verbatim:

- Planner: deterministic immutable versions, named producer/input binding, ordering, missing operations, incompatible port types, duplicate IDs, and cycles.
- Executor: dependency order, independent ready branches, named joins, false gates, blocked required descendants, failures that do not fabricate output, and runtime output validation.
- Provider control: not duplicated here. Module 2 owns the shared queue, queued cancellation, retry ceiling, and usage evidence.

Adapt-specific cases add revision/configuration pins, schema collisions with equal labels, memory/capability validation, maximum work, optional skipped-branch joins, limited collection overflow, budget deferral, cancellation after awaited work, aggregate validation failure, and exact invalid raw output retention.

The focused transferred/adapted tests are `tests/learning-planner.test.ts` and `tests/learning-executor.test.ts`. The dedicated mechanical eval is `evals/scripts/learning-executor-eval.ts`.

## Demonstrated gaps and exclusions

- The corrected Narrative run at `evals/.data/v2/learning-recipes/2026-09-30T19-55-41.600Z` was rejected after raw review. It predates the mechanical rename from `evidenceInputIds` to transient `usedObservationIds` and the explicit ban on writing IDs or citation language into maintained memory. That wording cleanup has focused test coverage only and is not semantic acceptance.

- Thro's planner schema equality serializes type expressions. That is insufficient for caller-defined Adapt schemas with the same labels and different behavior. Adapt uses schema object identity plus explicit consumer acceptance.
- Thro's executor has no Adapt memory/configuration revision pin or `change | no_change | defer | failure` contract.
- Thro does not provide the required limited-collection pending-overflow result at this boundary.
- Thro's provider utilities use Thro-specific stages and retry events. The local adapter must own one shared scheduler/retry path; the executor must not retry model calls.
- Thro's semantic utilities are coupled to canonical Evidence, Observation, Relation, and KbDefinition contracts. They are not copied wholesale. Current text observations may inform one learning run, but Adapt persists learned memory rather than a source-fragment archive.
- No Adapt runtime requires a sibling Thro checkout, Thro service, Postgres, pg-boss, or non-text Thro dependency.
