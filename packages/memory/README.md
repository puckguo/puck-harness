# @puckguo123/memory

`agent.md` context loading, idle tasks, daily summaries, and experience distillation.

## Install

```bash
npm install @puckguo123/memory @puckguo123/core @puckguo123/store
```

## Features

- **`agent.md` loader** — pulls project memory (like `CLAUDE.md` for Claude Code or `AGENTS.md` for pi) into the system prompt
- **Idle tasks** — background hooks that can be triggered between user turns
- **Daily summaries** — append-only log of each day's sessions
- **Experience distillation** — extracts reusable patterns from completed sessions

## Quick start

```ts
import { MemoryStore } from "@puckguo123/memory";
import { ConversationIndex } from "@puckguo123/store";

const memory = new MemoryStore({
  index: new ConversationIndex(),
  cwd: process.cwd(),
});

const systemPrompt = await memory.composeSystemPrompt();
// includes any agent.md found in cwd or ~/.puck/agent.md
```

## License

MIT — see [LICENSE](../../LICENSE).
