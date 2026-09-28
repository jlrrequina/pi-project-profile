# pi-project-profile

Makes the [π coding agent](https://pi.dev) project-aware in any repository, then checks its work.

- **Profile** — at session start, detects the stack, commands, conventions, CI checks and instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …) and injects a stable `<project_profile>` section into the system prompt.
- **Verify** — after every turn that changed files, runs the project's *own* typecheck/lint (tests and builds only after a one-time confirmation), sends failures back to the agent, and stops after a bounded number of repair rounds.

It never writes into the repository. Cache and settings live under `~/.pi/agent/project-profile/`.

## Install

```bash
pi install npm:@lenard9191/pi-project-profile
```

Requires π ≥ 0.87 and Node ≥ 22.18. No runtime dependencies.

## What the agent sees

```
<project_profile>
- Project: zod — ~/projects/zod · remote github.com/colinhacks/zod · ~741 tracked files
- Language/runtime: TypeScript · node 24
- Stack: monorepo: pnpm workspaces (8 packages) · pnpm · Vite · Vitest
- Commands: install `pnpm install` · typecheck `pnpm exec tsc --noEmit -p tsconfig.json` · lint `pnpm run lint` · test `pnpm run test`
- Conventions: ESM · Prettier · Husky git hooks · License: MIT
- CI: GitHub Actions (ci.yml)
- Instruction files: AGENTS.md (loaded) · CONTRIBUTING.md (5 KB — read it when relevant)
- Verification: after each turn that changed files, the harness runs `pnpm exec tsc --noEmit`, `pnpm run lint` automatically; asks once before running tests
</project_profile>
```

The section is identical for every turn of a session, so prompt caching keeps working.

## What gets run

| Tier | Examples | Policy |
|---|---|---|
| syntax | `node --check`, `python -c ast.parse`, `ruby -c`, `bash -n`, JSON parse | automatic, changed files only |
| fast | `tsc --noEmit`, `cargo check`, `go build`/`go vet`, `mypy`/`pyright`, `mix compile`, `dart analyze` | automatic |
| lint | `eslint`, `biome`, `prettier --check`, `ruff`, `cargo fmt --check`/`clippy`, `gofmt`, `rubocop`, `swiftlint` | automatic |
| test | `npm test`, `cargo test`, `pytest`, `go test`, `rspec`, `mix test`, `phpunit`, `swift test`, `./gradlew test` | confirmed once per repo |
| build | `pnpm build`, `./gradlew compile*`, `swift build`, `zig build`, `cmake --build` | confirmed once per repo |

Installs, migrations, deploys and anything network-bound are never run.

Test runs are narrowed to the changed files when the runner allows it — `vitest related`, `jest --findRelatedTests`, `go test ./<pkg>/...`, `cargo test -p <package>`, `pytest <changed test files>` — and fall back to the full run whenever that is not safe (config or manifest changed, unknown file kinds). Files in a monorepo package or workspace member are checked with that package's own commands, in its directory.

Failures come back to the agent pruned (diagnostic lines first, ~40 lines, full log path). The loop stops after `maxRepairRounds` (3), when a round changes no files, or when the same failure repeats — then the agent is asked for a summary instead of stopping silently. Environment failures (missing tool, deps not installed, timeout, database down) go to *you* as a notification and disable that check for the session.

## Commands and tool

| | |
|---|---|
| `/profile` | show the profile, checks, availability and cache path |
| `/profile refresh` | re-detect (also automatic when a manifest changes) |
| `/profile set <key> <cmd>` | override `typecheck`, `lint`, `test`, `build`, … (`-` disables) |
| `/profile note <text>` | persist a per-repo note for the agent |
| `/profile tests allow\|deny\|ask` | test-tier permission (same for `build`) |
| `/profile verify on\|off` | per-repo switch for the gate |
| `/profile forget` | drop cache and user data for this repo |
| `/verify [fast\|lint\|test\|build\|all] [file…]` | run checks now (`/verify cancel` aborts) |
| `run_checks` | the same, as a tool the model can call mid-task |

## Configuration

`~/.pi/agent/project-profile/config.json` — create it with `/profile config`. Main keys:

```jsonc
{
  "verify": { "enabled": true, "maxRepairRounds": 3, "runTests": "ask", "runBuild": "ask", "headless": true, "maxOutputLines": 40 },
  "profile": { "inject": true, "inlineInstructionFiles": true, "maxInstructionFileChars": 3000 }
}
```

`PI_PROJECT_PROFILE_DEBUG=1` writes a JSONL trace of gate decisions to `$TMPDIR/pi-project-profile/`.

## Design rules

- Nothing is hardcoded per project; every capability degrades detected → generic → no-op, never to a wrong action.
- Only read-only checks run unprompted. The gate runs only in projects π reports as trusted.
- Tools are bound late (`node_modules/.bin`, `uv run`/`poetry run`/`.venv`), so the profile stays valid before and after `pnpm install`/`uv sync`.
- Instruction files are inlined only when small, framed as repository content, and skipped when they read like a bot directive.

## Coverage

Node/TypeScript (npm, pnpm, yarn, bun; workspaces, Turborepo, Nx), Deno, Rust, Go, Python (uv, poetry, pdm, pipenv, hatch), Ruby, JVM (Gradle, Maven, Kotlin, Android), .NET, Swift, PHP, Elixir, Dart/Flutter, C/C++ (CMake, Meson), Zig, Haskell, Scala, OCaml, Gleam, Erlang, Terraform, shell, Lua, Perl, plus Makefile/justfile/Taskfile targets, Bazel, CI (GitHub Actions, GitLab, CircleCI, Azure, Travis, Jenkins, Buildkite, Bitbucket), docker-compose services and umbrella repos. Verified against ~45 public repositories.

## Development

```bash
npm install
npm run check                       # tsc
npm test                            # node --test
node scripts/scan.ts <dir> --checks # print the profile + checks for any directory
```

Layout: `detect/` (per-ecosystem detectors), `profile/` (cache + rendering), `verify/` (runner, pruning, env/code classification, change tracking, planning, gate), `index.ts` (π wiring).

MIT © John Lenard Requina
