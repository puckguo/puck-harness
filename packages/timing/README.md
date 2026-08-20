# @puckguo123/timing

Per-turn model latency metrics, JSONL store, HTML dashboard, and LLM-based sanity analysis. **Zero dependencies.**

## Install

```bash
npm install @puckguo123/timing @puckguo123/core
```

## What it records

- `ttftMs` — time to first token
- `llmMs` — full LLM call duration
- `toolMs` — tool execution time
- `inputTokens` / `outputTokens` — usage from the provider

## Quick start

```ts
import { TimingRecorder } from "@puckguo123/timing";

const rec = new TimingRecorder(".puck/timings.jsonl");
rec.record({
  sessionId: "abc-123",
  turn: 1,
  ttftMs: 230,
  llmMs: 1200,
  toolMs: 50,
  inputTokens: 1024,
  outputTokens: 256,
});
```

## Dashboard

Run the bundled HTML report generator:

```bash
npx puck-timing-report .puck/timings.jsonl > report.html
```

## License

MIT — see [LICENSE](../../LICENSE).
