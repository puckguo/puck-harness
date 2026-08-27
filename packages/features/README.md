# @puckguo123/features

Optional, independently-deletable agent features. Each subpath is a self-contained module — if you don't need `compaction`, don't import `./compaction`, and `npm prune` won't keep it.

## Install

```bash
npm install @puckguo123/features @puckguo123/core
```

## Subpaths

| Subpath | What it does |
|---|---|
| `@puckguo123/features/compaction` | Token-budgeted message compaction (lossless; preserves tool calls and decisions) |
| `@puckguo123/features/subagent` | Spawn child agents (for "use opus to refactor this file" patterns) |
| `@puckguo123/features/skills` | Markdown skill loading — `agent.md` files in cwd or `~/.puck/skills/` |
| `@puckguo123/features/approval` | Pre-tool-execution approval prompt (for high-risk bash commands) |
| `@puckguo123/features/rewind` | Claude-Code-style double-ESC checkpoints — rewind conversation and/or code to any earlier user prompt |

## Quick start

```ts
import { Agent } from "@puckguo123/core";
import { createPuck } from "@puckguo123/sdk";
import { applyCompaction } from "@puckguo123/features/compaction";

const puck = createPuck({
  model: "deepseek-chat",
  tools: "coding",
  // Compaction hooks into the agent event stream
  hooks: { onTurnEnd: applyCompaction },
});
```

## Trimming

The whole point of this package is that each subpath is independent. If you only want the agent loop + a single tool, you can:

1. Skip this package entirely
2. Or just import the one subpath you need

```ts
// minimal: only compaction
import { applyCompaction } from "@puckguo123/features/compaction";
```

The other features won't be in your `node_modules` if you don't import them.

## License

MIT — see [LICENSE](../../LICENSE).
