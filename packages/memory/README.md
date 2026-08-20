# @puck-agent/memory

`agent.md` context loading, idle tasks, daily summaries, and experience distillation.

## Install

```bash
npm install @puck-agent/memory @puck-agent/core @puck-agent/store
```

## Features

- **`agent.md` loader** — pulls project memory (like `CLAUDE.md` for Claude Code or `AGENTS.md` for pi) into the system prompt
- **Idle tasks** — background hooks that can be triggered between user turns
- **Daily summaries** — append-only log of each day's sessions
- **Experience distillation** — extracts reusable patterns from completed sessions

## Quick start

```ts
import { MemoryStore } from "@puck-agent/memory";
import { ConversationIndex } from "@puck-agent/store";

const memory = new MemoryStore({
  index: new ConversationIndex(),
  cwd: process.cwd(),
});

const systemPrompt = await memory.composeSystemPrompt();
// includes any agent.md found in cwd or ~/.puck/agent.md
```

## License

MIT — see [LICENSE](../../LICENSE).
