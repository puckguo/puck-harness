# Security Policy

## Supported versions

| Version range | Supported |
|---|---|
| `0.1.x` (current) | ✅ Active development |
| `< 0.1.0` | ❌ Not supported |

## Reporting a vulnerability

**Please do not file a public issue for security bugs.**

Email: **<security@puck-harness.example>** (replace with real address when known; until then, contact the maintainer via GitHub DM)

Include:
- A clear description of the vulnerability and its impact
- A minimal reproduction (code snippet, CLI command, or test case)
- The version(s) of `@puckguo123/*` / `puck` affected
- Your assessment of severity (e.g. RCE / data leak / DoS / info disclosure)

## Response SLAs

| Severity | First response | Fix target |
|---|---|---|
| **Critical** (RCE, key leak, arbitrary fs write) | 48 hours | 7 days |
| **High** (data exposure, sandbox escape) | 5 days | 30 days |
| **Medium** (info disclosure, DoS) | 14 days | Next minor release |
| **Low** (UX, edge case) | Best effort | Best effort |

We will acknowledge receipt within the SLA window and keep you updated on progress. Once a fix lands, we will credit you in the release notes (unless you ask to remain anonymous).

## Scope

`@puckguo123/*` packages and the `puck` CLI. The `puck-demo` examples in this repo are out of scope (they're documentation, not shipped code).

## Out of scope

- Vulnerabilities in third-party model providers (Anthropic, OpenAI, etc.) — please report those to the vendor
- Issues in your own integrations built on top of `@puckguo123/*` SDK
- "Bug-as-feature" reports about the harness being too minimal or too unopinionated (file an issue instead)

## Authentication & credentials

puck stores API keys in `~/.puck/auth.json` with `0600` permissions (best-effort on Windows). The repo never contains real credentials:

- `auth.json` is always `.gitignore`d
- `auth.json.example` is the only committed file in that family (placeholders only)
- The benchmark harness in `bench/` writes isolated copies under `bench/home/` which is also `.gitignore`d

If you accidentally committed a real key, **rotate it immediately** at the provider and then scrub git history (`git filter-repo` or BFG).
