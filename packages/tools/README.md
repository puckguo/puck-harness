# @puckguo123/tools

Built-in tools for coding agents: `bash`, `read`, `write`, `edit`, `truncate`. **Zero dependencies.**

Each tool is a standalone module that you can import directly (or use the bundled default set via the SDK).

## Install

```bash
npm install @puckguo123/tools @puckguo123/core
```

## Subpaths

| Subpath | What it does |
|---|---|
| `@puckguo123/tools` | The default set: bash + read + write + edit + truncate |
| `@puckguo123/tools/bash` | Just `bash` |
| `@puckguo123/tools/read` | Just `read` |
| `@puckguo123/tools/write` | Just `write` |
| `@puckguo123/tools/edit` | Just `edit` (string-replace) |
| `@puckguo123/tools/truncate` | Truncate a tool result mid-stream |

## Quick start

```ts
import { Agent } from "@puckguo123/core";
import { codingTools } from "@puckguo123/tools";
// or: import { bashTool, readTool, writeTool, editTool } from "@puckguo123/tools";

const agent = new Agent({
  stream: myStreamFn,
  systemPrompt: "...",
  tools: codingTools, // array of Tool
});
```

## Customizing

Each tool is a plain object that implements the `Tool` interface from `@puckguo123/core`:

```ts
import { bashTool } from "@puckguo123/tools/bash";

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
