# @puckguo123/core

The agent loop, message model, tool interface, and event stream. **Zero dependencies.**

This is the lowest level of the puck stack — if you want to embed an agent loop into your own runtime (game engine, browser, daemon) without dragging in any HTTP / fs / child_process machinery, start here.

## Install

```bash
npm install @puckguo123/core
```

## Quick start

```ts
import { Agent } from "@puckguo123/core";
import type { Tool, AgentEvent } from "@puckguo123/core";

const agent = new Agent({
  systemPrompt: "You are a careful code reviewer.",
  // your StreamFn from @puckguo123/llm
  stream: async (messages, signal) => {
    // yield AgentEvents (message_start / message_update / message_end / turn_end)
  },
  tools: myTools,
});

for await (const ev of agent.iterate("review src/foo.ts")) {
  if (ev.type === "message_update" && ev.message.role === "assistant") {
    process.stdout.write(ev.message.text ?? "");
  }
}
```

## What's in the box

- `Agent` — the main class; iterate over events, call `.run()` for convenience
- `Message` / `ContentPart` — the data model (matches Anthropic / OpenAI shape, but provider-agnostic)
- `Tool` / `ToolContext` — the tool contract; `execute(args, ctx)` is your hook
- `AgentEvent` discriminated union — `turn_start`, `message_start/update/end`, `tool_start/end`, `turn_end`, `compaction`
- Compaction helpers (token-bucketed, lossless)
- Token accounting

## What's NOT in this package

- LLM HTTP calls (see `@puckguo123/llm`)
- Tool implementations like `bash` / `read` / `write` (see `@puckguo123/tools`)
- Session persistence (see `@puckguo123/session`)

## License

MIT — see [LICENSE](../../LICENSE).
