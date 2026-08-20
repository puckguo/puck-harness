# @puck-agent/llm

LLM adapters for OpenAI-compatible endpoints, Anthropic, and a scripted mock. **Zero dependencies.**

The single `StreamFn` seam lets you swap providers without touching your agent code.

## Install

```bash
npm install @puck-agent/llm @puck-agent/core
```

## Subpaths

| Subpath | Use when |
|---|---|
| `@puck-agent/llm` | High-level `getModel()` / `createStreamFn()` registry (uses your login keys) |
| `@puck-agent/llm/openai` | Direct OpenAI-compatible client (e.g. DeepSeek, Moonshot, Ollama) |
| `@puck-agent/llm/anthropic` | Anthropic native client |
| `@puck-agent/llm/mock` | Deterministic scripted responses for tests |

## Quick start

```ts
import { Agent } from "@puck-agent/core";
import { createStreamFn, getModel } from "@puck-agent/llm";

const model = getModel("deepseek-chat");
const agent = new Agent({
  stream: createStreamFn(model),
  systemPrompt: "You are a careful assistant.",
});

const { text } = await agent.run("Summarize the news today");
```

## Mock for tests

```ts
import { createMockStreamFn } from "@puck-agent/llm/mock";

const stream = createMockStreamFn([{ text: "hello" }, { text: " world" }]);
```

The mock yields a deterministic script — perfect for CI without any network.

## Provider discovery

`@puck-agent/llm` re-exports the credential store and live `GET /models` discovery from [`@puck-agent/llm/auth`](./src/auth.ts). After `puck /login anthropic`, calling `discoverUsableModels(store)` returns one entry per provider with valid credentials plus their live model lists.

## License

MIT — see [LICENSE](../../LICENSE).
