# Changelog

## Unreleased

- Scoped test runs: when the changed files allow it, the test tier runs `vitest related --run`, `jest --findRelatedTests`, `go test ./<pkg>/...`, `cargo test -p <package>` (workspace root package; members already run in their own directory) or `pytest <changed test files>` instead of the whole suite. Config/manifest changes, unknown file kinds and ambiguous mappings fall back to the full run; previously failing checks keep their file list across repair rounds. The binary is still resolved at run time.
- `verify.perTurn` (default off): run the syntax + fast tiers after every turn that changed files (tool writes, or a git peek when a shell tool ran) and append a non-continuing informational note when red. Earlier per-turn notes are superseded to keep context small.
- Boundary handlers now carry entries queued by earlier extensions instead of replacing the draft chain.
- Detector version 9 (new `scope` field on checks).

## 0.1.0 — 2026-09-29

Initial release.

- Profile: stack / commands / conventions / CI / instruction-file detection for ~30 ecosystems, cached under `~/.pi/agent/project-profile/`, injected as a static `<project_profile>` system-prompt section.
- Verify: `agent_before_settle` gate that runs the project's own checks by tier (syntax → fast → lint automatic; test/build confirmed once per repo), prunes failures, and drives a bounded repair loop (`maxRepairRounds`, stops on no changes or identical failure).
- Environment failures (missing tools, uninstalled deps, timeouts, services down) notify the user and disable the check for the session instead of looping the agent.
- `/profile`, `/verify` commands and the `run_checks` tool.
- Project-root resolution never climbs to the home directory (a stray `~/package.json` or a dotfiles repo at `~` must not turn `~` into the project).
