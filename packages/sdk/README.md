# @puck-agent/sdk

The high-level entry point. One call — `createPuck({ ... })` — wires up the agent loop, an LLM stream function, tools, and optional session persistence.

## Install

```bash
npm install @puck-agent/sdk
```

## Quick start

```ts
import { createPuck } from "@puck-agent/sdk";

const puck = createPuck({
  model: "deepseek-chat",        // or any model id from `puck /login`
  tools: "coding",               // "coding" (bash+read+write+edit) | "none" | Tool[]
  session: { dir: ".puck/sessions" },
});

const { text } = await puck.run("读一下 package.json，总结这个项目");
```

## Streaming events

```ts
for await (const ev of puck.iterate("重构 src/utils.ts")) {
  if (ev.type === "tool_start") console.log("▶", ev.toolName);
  if (ev.type === "message_update" && ev.message.role === "assistant") {
    process.stdout.write(ev.message.text ?? "");
  }
}
```

## Lower level

If you only need a piece (e.g. the agent loop without sessions), use the individual packages:

- `@puck-agent/core` — agent loop + message model
- `@puck-agent/llm` — OpenAI / Anthropic / mock adapters
- `@puck-agent/session` — JSONL persistence
- `@puck-agent/tools` — bash / read / write / edit

## CLI

The `puck` command (separate npm package) is a thin wrapper around this SDK.

## License

MIT — see [LICENSE](../../LICENSE).
