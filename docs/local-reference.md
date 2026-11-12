# Local provider reference

Adapt v2's reference provider uses LM Studio's OpenAI-compatible chat
completion endpoint through `createLocalLLM`. It implements the existing
`AdaptLLMPlugin` generation contract and a narrow bounded-decision contract.
The scheduler is a separate dependency so every Brain, neuron, and recipe can
share one physical device budget.

```ts
import {
	createBoundedDeviceScheduler,
	createLocalLLM,
} from '../src/llm/local'

const scheduler = createBoundedDeviceScheduler({
	maxConcurrent: 1,
	maxQueued: 8,
})

const llm = createLocalLLM({
	chatCompletionsUrl: 'http://127.0.0.1:1234/v1/chat/completions',
	providerId: 'lm-studio',
	scheduler,
	retry: {
		maxAttempts: 2,
		maxAttemptsCeiling: 2,
		initialDelayMs: 100,
		maxDelayMs: 500,
		backoff: 'fixed',
	},
	requestTimeoutMs: 60_000,
	defaultMaxOutputTokens: 256,
	defaultPriority: 'foreground',
})
```

The endpoint must use `127.0.0.1`, `[::1]`, or `localhost`. Credentials,
queries, fragments, redirects, unresolved hostnames, and remote endpoints are
rejected. The adapter has no remote fallback. It owns the only retry loop and
rejects a nonzero call-level `maxRetries` value.

The shared scheduler accepts `query`, `foreground`, and `background` priority.
It preserves FIFO ordering within a priority, bounds both active and waiting
work, removes cancelled queued work, and gives queued query work precedence.
The host supplies every queue, retry, timeout, token, endpoint, provider, and
model setting through typed configuration.

`llm.decisions.decide` receives supplied state, one question, and a nonempty
set of permitted answers. The wire answer is a constrained enum or `null`.
Code deterministically maps `null` to `status: 'abstained'` and a permitted
value to `status: 'answered'`. A returned probability is optional and is
identified as `generated_self_report` with `calibrated: false`; missing
probability stays unknown.

Every physical attempt retains its exact serialized request body and exact HTTP
response body. `exchangeObserver` can write those bodies as they arrive. A
transport failure retains the original error object. Provider metadata records
the requested model ID and the model ID returned by the runtime separately.

Streaming and tool calls are currently unsupported and fail explicitly. The
v2 recipe path uses structured generation and bounded decisions. Supporting a
new capability requires a dedicated contract and evaluation rather than an
implicit fallback through another provider.

## Reference runtime inspected on 30 September 2026

- Hardware: MacBook Pro 14-inch (MacBookPro18,3), Apple M1 Pro with 8 CPU
  cores and 16 GB unified memory.
- OS: macOS 15.6.1 (24G90), arm64.
- LM Studio application: 0.4.6+1. CLI commit: `0b2a176`.
- Loaded generative artifact: `liquid/lfm2.5-1.2b`, 1,248,488,982 bytes,
  1.2B parameters, 8-bit selected variant `liquid/lfm2.5-1.2b@8bit`.
  `lms ps` reports the artifact format as safetensors; the LM Studio server's
  `/api/v1/models` view reports the loaded runtime format as MLX.
- Loaded instance settings: 4,096-token context and runtime parallelism 4.
  The artifact advertises a 128,000-token maximum context and tool training;
  those advertised capabilities are not Adapt support claims.
- Immutable local artifact identity (SHA-256):
  - `model.safetensors` (1,243,645,837 bytes):
    `8c3f09f8d1d5739464d8c6b8a321f68f7fa7fe51f8fb11adf104ff637b50a58f`
  - `config.json`: `07f8d0fa634323c35c91978f38fa7ffe9bc50439a92a57dadcd81e0e69aaa501`
  - `tokenizer.json`: `2221c71b5dce048a8abae62843b92bd7deec13cc153f95fa6e3327a47b79a7da`
  - `tokenizer_config.json`:
    `d511168753c052d39b5562d6d615fb5fb1a65638d81b5fff0c9cd99fbc87da67`
- The installed Nomic embedding artifact was not loaded or used by this
  module.

The accepted dedicated run is under
`evals/.data/v2/local-provider/2026-09-30T14-03-19.443Z`. It used the production
adapter with exact repository fixture text and saved raw bodies separately from
metadata and assessment. The child eval process ran under a macOS sandbox that
allowed localhost and denied other outbound traffic. LM Studio itself ran
outside that child-process sandbox. `network-probes.json` records a successful
localhost model-list request and an `EPERM` denial for an external IP.

## Thro reuse record

The source baseline is committed Thro revision
`07b4545d9397463f4e86d4a8c454c22c39022cd8`, file
`packages/primitives/src/provider-io.ts`.

| Source symbol | Adapt target | Treatment |
|---|---|---|
| `BoundedProviderScheduler` | `BoundedDeviceScheduler` | Retained shared concurrency and queued cancellation. Added a queue bound, immutable copied configuration, and stable query/foreground/background priority. |
| `callWithBoundedRetries` | private local adapter retry boundary | Retained bounded attempts, delayed retry, observer acknowledgement before physical I/O, cancellation, and one retry owner. Adapted to supplied full retry budgets and the shared priority scheduler. |
| `ProviderCallObserver` lifecycle | `LocalProviderObserver` | Retained start acknowledgement and attempt lifecycle. Kept raw HTTP exchange capture separate through `exchangeObserver`. |

Transferred mechanical cases cover the shared concurrency ceiling, queued
cancellation, retry counting, abort during backoff, observer refusal before
physical I/O, and immutable budgets. Adapt-specific cases cover priority,
queue overflow, loopback-only endpoints, redirect rejection, timeout through
body consumption, exact raw bodies, runtime-returned model identity, structured
failure behavior, explicit abstention, and probability provenance.

The eval TypeScript gate initially also reported unrelated pre-existing script
errors: missing `focus` fields in two older eval fixtures and AI SDK v3 types
imported from `ai` instead of `@ai-sdk/provider`. Those narrow fixture/import
repairs are included without changing their scenarios. Concurrent v2 store
work temporarily produced additional repository errors while this module was
being developed; they were outside the provider module.
