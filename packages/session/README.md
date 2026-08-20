# @puckguo123/session

Append-only JSONL session transcripts with crash-safe append and a streaming reader. **Zero dependencies.**

Sessions are stored as one file per id (UUID or import-prefixed slug), each containing newline-delimited JSON events: `header`, `message`, `compaction`, etc.

## Install

```bash
npm install @puckguo123/session
```

## Quick start

```ts
import { SessionStore } from "@puckguo123/session";

const store = new SessionStore(".puck/sessions");
store.append(sessionId, { type: "header", id: sessionId, createdAt: Date.now() });
store.append(sessionId, { type: "message", message: { role: "user", content: "hi" } });

const list = store.list();          // string[] of session ids, newest first
const sess = store.load(sessionId); // { id, messages, compactions, ... }
```

## Cross-harness import

Already have sessions from `pi`, `claude-code`, or `codex`? Use the `import` subpath to convert them into puck format:

```ts
import { importExternalSession, scanExternalSessions } from "@puckguo123/session/import";

const pi = scanExternalSessions({ sources: ["pi"] });
for (const info of pi) {
  importExternalSession(info.path, ".puck/sessions", { id: `import-pi-${info.slug}` });
}
```

Imported sessions are tagged with an `importedFrom` header so the picker can render them differently.

## API surface

- `new SessionStore(dir)` — directory of `*.jsonl` files
- `.append(id, event)` — atomic append (writes a single `fsync`d line)
- `.load(id)` — full session: messages + compactions + meta
- `.list()` — ids sorted by mtime desc
- `.stats(id)` — `{ turns, assistantMessages, toolCalls, compactions }`
- `.projectCwd` — derived project dir (for the `header.cwd`-less legacy files)
- `importExternalSession` / `scanExternalSessions` (subpath `./import`)

## License

MIT — see [LICENSE](../../LICENSE).
