# pi-project-profile

[![npm](https://img.shields.io/npm/v/@lenard9191/pi-project-profile)](https://www.npmjs.com/package/@lenard9191/pi-project-profile)
[![CI](https://github.com/jlrrequina/pi-project-profile/actions/workflows/ci.yml/badge.svg)](https://github.com/jlrrequina/pi-project-profile/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@lenard9191/pi-project-profile)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jlrrequina/pi-project-profile/badge)](https://scorecard.dev/viewer/?uri=github.com/jlrrequina/pi-project-profile)

Makes the [π coding agent](https://pi.dev) project-aware in any repository, then checks its work.

![pi-project-profile: the injected project profile and the verification of an agent turn](https://raw.githubusercontent.com/jlrrequina/pi-project-profile/main/docs/cover.png)

- **Profile**: detects the stack, commands (including how to run one test), conventions, CI checks, test layout, generated code and instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …), and injects them as a stable `<project_profile>` system-prompt section.
- **Verify**: after every turn that changed files, runs the project's *own* checks and sends new failures back to the agent for a bounded number of repair rounds.
- **Review**: flags what a reviewer would want to know about the agent's diff: added suppressions, skipped or focused tests, stubs, loosened configs, deleted tests, secrets, unignored `.env` files, stale lockfiles.
- **Rules on demand**: delivers nested `AGENTS.md` files and glob-scoped rules (Cursor, Copilot, Windsurf) when the agent first touches a file they apply to, and warns before hand-editing generated files.

It never writes into the repository. Cache and settings live under `~/.pi/agent/project-profile/`.

## Install

```bash
pi install npm:@lenard9191/pi-project-profile
```

Requires π ≥ 0.87 and Node ≥ 22.18. No runtime dependencies. Update with `pi update npm:@lenard9191/pi-project-profile`.

## What the agent sees

```
<project_profile>
- Project: zod — ~/projects/zod · remote github.com/colinhacks/zod · ~741 tracked files
- Stack: monorepo: pnpm workspaces (8 packages) · pnpm · Vite · Vitest
- Commands: install `pnpm install` · typecheck `pnpm exec tsc --noEmit -p tsconfig.json` · lint `pnpm run lint` · test `pnpm run test` · test one `pnpm exec vitest run <file> -t "<name>"`
- Conventions: ESM · Prettier · Biome · Husky git hooks · License: MIT
- Tests: `*.test.ts` in tests/ (202)
- Instruction files: AGENTS.md (loaded) · .cursorrules (22 KB — read it when relevant)
- Verification: after each turn that changed files, the harness runs `pnpm exec tsc --noEmit -p tsconfig.json`, `pnpm run lint:check` automatically; asks once before running tests
</project_profile>
```

The section is identical for every turn of a session, so prompt caching keeps working.

## Verification

| Tier | Examples | Policy |
|---|---|---|
| syntax | `node --check`, `python -c ast.parse`, `ruby -c`, `bash -n`, JSON parse | automatic, changed files only |
| fast | `tsc --noEmit`, `cargo check`, `go build`/`go vet`, `mypy`/`pyright`, `mix compile`, `dart analyze` | automatic |
| lint | `eslint`, `biome`, `prettier --check`, `ruff`, `cargo fmt --check`/`clippy`, `gofmt`, `rubocop`, `swiftlint` | automatic |
| test | `npm test`, `cargo test`, `pytest`, `go test`, `rspec`, `mix test`, `phpunit`, `swift test`, `./gradlew test` | confirmed once per repo |
| build | `pnpm build`, `./gradlew compile*`, `swift build`, `zig build`, `cmake --build` | confirmed once per repo |

Installs, migrations, deploys and anything network-bound are never run.

- **Only new failures cost repair rounds.** Diagnostics recorded before a prompt (a repo that was already red) are pre-existing: not sent back to the agent, noted once for you, and they don't block the tests.
- **Narrowed runs.** Tests run as `vitest related`, `jest --findRelatedTests`, `go test ./<pkg>/...`, `cargo test -p <package>` or `pytest <changed test files>` when that is safe; `cargo check` drops `--all-targets` when no test/bench/example code changed. Monorepo packages are checked in their own directory with their own scripts, and a workspace-wide root run replaces the per-package duplicates.
- **Fast.** Read-only checks in a tier run in parallel; tests and builds run one at a time.
- **Actionable failures.** Diagnostic lines first (~40 lines, full log path), plus the exact auto-fix command for format/lint failures (`prettier --write <files>`, `ruff check --fix <files>`, …).
- **Bounded.** At most `maxRepairRounds` (3); stops early when a round changes nothing or repeats the same failure, then asks the agent for a summary. Environment failures (missing tool, deps not installed, timeout, database down) go to *you* and disable that check for the session.

## Review of the agent's changes

Compared with the content before the agent's first write (or git `HEAD`; files that were already dirty are never blamed on the agent):

- `@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa`, `#[allow]`, `//nolint`, `@Suppress`, … added
- tests skipped (`.skip`, `xit`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]`) or focused (`.only`), test files deleted, test cases removed
- stubs left in (`raise NotImplementedError`, `todo!()`, `throw new Error("not implemented")`)
- checks loosened in config (`"strict": false`, ESLint rules `"off"`, `continue-on-error: true`, `|| true` in scripts)
- secrets (AWS, GitHub, OpenAI/Anthropic, Slack, Stripe, Google, npm, Hugging Face keys, private keys; values are never repeated), `.env` files that are not gitignored
- dependency changes without a lockfile update (`pnpm install`, `uv lock`, `go mod tidy`, …)

Secrets, stale lockfiles and `.only` get one follow-up turn; weakening added while checks were failing gets one follow-up turn; everything else is shown to you.

## Commands and tool

| | |
|---|---|
| `/profile` | show the profile, checks, availability and cache path |
| `/profile doctor` | required vs installed runtimes, tool and dependency availability, fix commands (never run) |
| `/profile refresh` | re-detect (also automatic when a manifest changes) |
| `/profile set <key> <cmd>` | override `typecheck`, `lint`, `test`, `build`, … (`-` disables) |
| `/profile note <text>` | persist a per-repo note for the agent |
| `/profile tests allow\|deny\|ask` | test-tier permission (same for `build`) |
| `/profile verify on\|off` | per-repo switch for the gate |
| `/profile forget` | drop cache and user data for this repo |
| `/verify [fast\|lint\|test\|build\|all] [file…]` | run checks now, showing every failure (`/verify cancel` aborts) |
| `run_checks` | the same, as a tool the model can call mid-task |

## Configuration

`~/.pi/agent/project-profile/config.json` — create it with `/profile config`. Main keys:

```jsonc
{
  "verify": { "enabled": true, "maxRepairRounds": 3, "runTests": "ask", "runBuild": "ask", "guard": true, "perTurn": false, "concurrency": 0 },
  "profile": { "inject": true, "scopedInstructions": true, "maxInstructionFileChars": 3000 }
}
```

`verify.perTurn` also runs the syntax + fast tiers after every turn that changed files and adds a short informational note when red (no repair loop: multi-file edits are legitimately red half-way). `PI_PROJECT_PROFILE_DEBUG=1` writes a JSONL trace to `$TMPDIR/pi-project-profile/`.

## Design rules

- Nothing is hardcoded per project; every capability degrades detected → generic → no-op, never to a wrong action.
- Only read-only checks run unprompted. The gate runs only in projects π reports as trusted.
- Tools are bound late (`node_modules/.bin`, `uv run`/`poetry run`/`.venv`), so the profile stays valid before and after installs.
- Repository instructions are framed as repository content, inlined only when small, and skipped when they read like a bot directive.

## Coverage

Node/TypeScript (npm, pnpm, yarn, bun; workspaces, Turborepo, Nx), Deno, Rust, Go, Python (uv, poetry, pdm, pipenv, hatch), Ruby, JVM (Gradle, Maven, Kotlin, Android), .NET, Swift, PHP, Elixir, Dart/Flutter, C/C++ (CMake, Meson), Zig, Haskell, Scala, OCaml, Gleam, Erlang, Terraform, shell, Lua, Perl, plus Makefile/justfile/Taskfile targets, Bazel, CI (GitHub Actions, GitLab, CircleCI, Azure, Travis, Jenkins, Buildkite, Bitbucket), docker-compose services and umbrella repos. Tested on macOS, Linux and Windows.

## Development

```bash
npm install
npm run check                       # tsc
npm test                            # node --test
node scripts/scan.ts <dir> --checks # print the profile + checks for any directory
```

CI runs the tests on Linux, macOS and Windows, a smoke test of the packed tarball, and weekly detection on ~20 real repositories (`node scripts/corpus.ts`). Releases are published from GitHub Actions with npm provenance. See [AGENTS.md](AGENTS.md) for the constraints every change must keep and [CONTRIBUTING.md](CONTRIBUTING.md) for releasing. MIT © John Lenard Requina
