# Contributing to puck

Thanks for your interest in puck — a minimal, trimmable agent harness. This guide covers the day-to-day workflow for contributing code, docs, and bug reports.

## Quick links

- **Source of truth**: this monorepo (root + 11 packages under `packages/`)
- **Issues**: <https://github.com/puckguo/puck-harness/issues>
- **Discussions**: <https://github.com/puckguo/puck-harness/discussions>
- **Security policy**: see [`SECURITY.md`](./SECURITY.md)

## Development setup

```bash
git clone https://github.com/puckguo/puck-harness.git
cd puck-harness
npm install            # installs all 11 workspaces
npm run typecheck      # tsc --noEmit, no side effects
npm test               # 143 offline tests + 5 skipped (real API)
npm run example:mock   # try the CLI without any API keys
```

Required toolchain: **Node ≥ 22.18.0**, npm ≥ 10.

## Layout

```
packages/
├── core/       # agent loop, message model, event stream — zero deps
├── llm/        # OpenAI-compatible + Anthropic + mock — zero deps
├── session/    # JSONL transcripts + cross-harness import — zero deps
├── tools/      # bash, read, write, edit, truncate — zero deps
├── features/   # compaction, subagent, skills, approval — each subpath independent
├── timing/     # per-turn latency metrics, HTML dashboard — zero deps
├── store/      # conversation index over a single sqlite file
├── memory/     # agent.md context, daily summaries, experience distillation
├── sdk/        # high-level createPuck() — composes core+llm+session+tools
├── cli/        # the `puck` command (npm bin)
└── web/        # optional SSE web UI (`puck-web` command)
```

**Trimability is a design goal**: each package should be deletable. If you find an undeclared coupling, please flag it.

## Making a change

1. **Branch** off `main` (`git switch -c fix/short-name`)
2. **Code + tests** — every behavioral change needs a test. Use the existing files in `tests/` as templates; node:test is the runner, no extra deps.
3. **Audit** before pushing:
   ```bash
   npm run typecheck
   npm test
   npm run audit:publish   # checks the package.json hygiene + tarball contents
   ```
4. **Commit** with a descriptive message. Reference the issue if any.
5. **Push + open a PR** against `main`. The CI runs `typecheck` + `test` automatically.

## Adding a new package

1. Create `packages/<name>/` with:
   - `package.json` (use an existing simple one like `core` as a template; **all metadata fields are required**)
   - `tsconfig.json` extending `../../tsconfig.base.json`
   - `src/index.ts` (or `src/<subpath>/index.ts` for multi-entry packages)
2. Add a `references` entry in the root `tsconfig.json`
3. Run `npm run build` to make sure it links

## Adding a new feature (subpath)

For features that should be independently deletable (e.g. a new `approval` flow), prefer adding a subpath under `@puck-agent/features/`:
```jsonc
"exports": {
  "./approval": {
    "types": "./dist/approval/index.d.ts",
    "default": "./dist/approval/index.js"
  }
}
```

## Coding style

- TypeScript strict mode, ESM-only, no CommonJS
- Zero new runtime deps unless absolutely necessary (puck prides itself on being auditable)
- Public API changes go through `@puck-agent/sdk`; lower-level packages (`core`, `llm`, `session`, `tools`) should stay small
- Comments explain *why*, not *what*

## Release process

We use [changesets](https://github.com/changesets/changesets) to manage versions across the 11 packages.

For user-facing changes, add a changeset:
```bash
npx changeset
# pick which packages bumped, semver, write a one-line summary
```

A maintainer will run `npx changeset version` on `main` to bump versions + update CHANGELOG, then `npx changeset publish` to push to npm.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
