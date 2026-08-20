# puck-harness (CLI)

The `puck` command — a minimal coding agent built on the `@puck-agent/*` SDK.

> npm package name is `puck-harness` (the bare name `puck` was already taken); the installed binary is still `puck`.

## Install

```bash
npm install -g puck-harness
# or, for one-off use:
npx puck-harness
```

## Usage

```bash
puck "解释一下这个仓库的结构"
puck --mock "在 README 里加一段 Quick Start"   # 离线 deterministic，零网络
puck --model deepseek-chat                     # 指定模型
puck /login anthropic                          # 存 API key 到 ~/.puck/auth.json
puck /resume                                   # 列出历史会话
puck /status                                   # 看当前会话元信息
puck /clear                                    # 清空当前会话（标记而非删除）
puck /help                                     # 所有命令
puck /quit
```

## Try it without an API key

```bash
npm install -g puck-harness
puck --mock
```

The mock provider replays a deterministic script — no network, no key, deterministic for tests.

## What's inside

- Thin wrapper around [`@puck-agent/sdk`](../sdk/README.md)
- Slash-command parsing (`/login`, `/resume`, `/clear`, `/status`, `/help`, `/quit`)
- TUI: spinner, streaming text, ANSI colors
- Cross-harness session history (`/resume` reads from `~/.pi`, `~/.claude`, `~/.codex`)

## Configuration

`~/.puck/auth.json` — API keys, written by `/login` (chmod 600 best-effort). See [examples/auth.json.example](../../examples/auth.json.example).

## License

MIT — see [LICENSE](../../LICENSE).
