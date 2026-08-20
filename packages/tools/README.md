# @puck-agent/tools

Built-in tools for coding agents: `bash`, `read`, `write`, `edit`, `truncate`. **Zero dependencies.**

Each tool is a standalone module that you can import directly (or use the bundled default set via the SDK).

## Install

```bash
npm install @puck-agent/tools @puck-agent/core
```

## Subpaths

| Subpath | What it does |
|---|---|
| `@puck-agent/tools` | The default set: bash + read + write + edit + truncate |
| `@puck-agent/tools/bash` | Just `bash` |
| `@puck-agent/tools/read` | Just `read` |
| `@puck-agent/tools/write` | Just `write` |
| `@puck-agent/tools/edit` | Just `edit` (string-replace) |
| `@puck-agent/tools/truncate` | Truncate a tool result mid-stream |

## Quick start

```ts
import { Agent } from "@puck-agent/core";
import { codingTools } from "@puck-agent/tools";
// or: import { bashTool, readTool, writeTool, editTool } from "@puck-agent/tools";

const agent = new Agent({
  stream: myStreamFn,
  systemPrompt: "...",
  tools: codingTools, // array of Tool
});
```

## Customizing

Each tool is a plain object that implements the `Tool` interface from `@puck-agent/core`:

```ts
import { bashTool } from "@puck-agent/tools/bash";

const myBash = {
  ...bashTool,
  execute: async (args, ctx) => {
    if (!isAllowed(args.command)) throw new Error("command not allowed");
    return bashTool.execute(args, ctx);
  },
};
```

## License

MIT — see [LICENSE](../../LICENSE).
