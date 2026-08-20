# @puckguo123/llm

LLM adapters for OpenAI-compatible endpoints, Anthropic, and a scripted mock. **Zero dependencies.**

The single `StreamFn` seam lets you swap providers without touching your agent code.

## Install

```bash
npm install @puckguo123/llm @puckguo123/core
```

## Subpaths

| Subpath | Use when |
|---|---|
| `@puckguo123/llm` | High-level `getModel()` / `createStreamFn()` registry (uses your login keys) |
| `@puckguo123/llm/openai` | Direct OpenAI-compatible client (e.g. DeepSeek, Moonshot, Ollama) |
| `@puckguo123/llm/anthropic` | Anthropic native client |
| `@puckguo123/llm/mock` | Deterministic scripted responses for tests |

## Quick start

```ts
import { Agent } from "@puckguo123/core";
import { createStreamFn, getModel } from "@puckguo123/llm";

const model = getModel("deepseek-chat");
const agent = new Agent({
  stream: createStreamFn(model),
  systemPrompt: "You are a careful assistant.",
});

const { text } = await agent.run("Summarize the news today");
```

## Mock for tests

```ts
import { createMockStreamFn } from "@puckguo123/llm/mock";

const stream = createMockStreamFn([{ text: "hello" }, { text: " world" }]);
```

The mock yields a deterministic script — perfect for CI without any network.

## Provider discovery

`@puckguo123/llm` re-exports the credential store and live `GET /models` discovery from [`@puckguo123/llm/auth`](./src/auth.ts). After `puck /login anthropic`, calling `discoverUsableModels(store)` returns one entry per provider with valid credentials plus their live model lists.

## License

MIT — see [LICENSE](../../LICENSE).
