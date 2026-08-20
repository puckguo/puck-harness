# @puckguo123/store

Local conversation index — a single sqlite file in the system dir (`PUCK_HOME` or `~/.puck`).

## Install

```bash
npm install @puckguo123/store @puckguo123/core
```

## Quick start

```ts
import { ConversationIndex } from "@puckguo123/store";

const index = new ConversationIndex();
index.upsert({
  id: "abc-123",
  cwd: "/path/to/project",
  title: "Refactor src/foo.ts",
  startedAt: Date.now(),
  lastActivity: Date.now(),
  messageCount: 42,
  toolCallCount: 17,
});

const recent = index.list({ cwd: "/path/to/project", limit: 20 });
```

## What it does

- Single sqlite file (`puck.db`) for fast local queries
- Indexed by `cwd` so the CLI can show "recent sessions in this project"
- Compacted write path (batched, not per-event)
- Replaces the old JSON-on-disk index that the CLI used to do

## License

MIT — see [LICENSE](../../LICENSE).
