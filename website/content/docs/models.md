---
title: Models
description: Tested models and providers.
---

Adapt requires models that support tool calling and structured JSON output. The table below lists models we've tested. The list will be updated as we go.

The **Compatible** column reflects the non-streaming path (`brain.ask`, `neuron.query`, `brain.evolve`). Streaming (`brain.askStream`, `neuron.queryStream`) has its own caveats — see the **Streaming** column. Where the two diverge it usually comes down to weaker structured-output enforcement on the provider's streaming endpoint.

| Provider    | Model                                                | Compatible | Streaming   | Notes                                                                                                          |
|-------------|------------------------------------------------------|------------|-------------|----------------------------------------------------------------------------------------------------------------|
| OpenAI      | `gpt-4o-mini`                                        | ✓          | ✓           |                                                                                                                |
| Google      | `gemini-2.5-flash`                                   | ✓          | ✓           |                                                                                                                |
| Anthropic   | `claude-haiku-4-5`                                   | ✓          | ✓           |                                                                                                                |
| OpenRouter  | `google/gemini-2.0-flash-001`                        | ✓          | ✓           |                                                                                                                |
| OpenRouter  | `google/gemma-4-31b-it`                              | ✓          | ✓           |                                                                                                                |
| OpenRouter  | `x-ai/grok-4.3`                                      | ✓          | ✓ (slow)    | Streaming size-scaled output ~1 min on a 3 KB schema; works, but plan for higher latency.                      |
| OpenRouter  | `~openai/gpt-mini-latest`                            | ✓          | ✓           |                                                                                                                |
| OpenRouter  | `~moonshotai/kimi-latest`                            | ✓          | ✓ (very slow) | Streaming size-scaled output took **8 minutes** on a ~6 KB schema — usable but document the latency for users. |
| OpenRouter  | `mistralai/ministral-3b-2512`                        | ✓          | ✓           |                                                                                                                |
| OpenRouter  | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | ✗          | ✗           | No endpoint supports `tool_choice`.                                                                            |
| OpenRouter  | `~anthropic/claude-haiku-latest`                     | ✗          | ✗           | Provider error on structured output.                                                                           |
| OpenRouter  | `qwen/qwen3.6-flash`                                 | ✗          | ✗           | Provider error on both calls.                                                                                  |
| Together.ai | `deepseek-ai/DeepSeek-V3.1`                          | ✗          | ✗           | Together doesn't enforce structured output — model truncates large JSON. Same failure in streaming.            |
| Together.ai | `Qwen/Qwen3.5-397B-A17B`                             | ✓          | ✗           | **Streaming-only regression:** size-scaled structured output fails to parse on the streaming endpoint.         |
| Together.ai | `LiquidAI/LFM2-24B-A2B`                              | ✓          | ✗           | **Streaming-only regression:** size-scaled structured output schema mismatch on the streaming endpoint.        |
| Together.ai | `Qwen/Qwen3.5-9B`                                    | ✓          | ✗           | **Streaming-only regression:** size-scaled structured output fails to parse on the streaming endpoint.         |
| Together.ai | `google/gemma-4-31B-it`                              | ✓          | ✗           | **Streaming-only regression:** stream terminates mid-response on the size-scaled schema.                       |
| LM Studio   | `liquid/lfm2.5-1.2b`                                 | ✓          | ⚠ unstable  | Disable the "Structured Output" toggle — server forces json-mode otherwise. Streaming risks runaway generation on the stateful tool flow (eval blew Node's heap on this model). Document a wall-clock guard for users running tiny local models. |
| llama.cpp   | `LiquidAI/LFM2.5-1.2B-Instruct-GGUF`                 | ✗          | ?           | Tool calling works; default `llama-server` doesn't constrain JSON to the schema. Streaming not yet verified.   |
