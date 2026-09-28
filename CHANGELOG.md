# Changelog

## 0.1.0 — 2026-09-29

Initial release.

- Profile: stack / commands / conventions / CI / instruction-file detection for ~30 ecosystems, cached under `~/.pi/agent/project-profile/`, injected as a static `<project_profile>` system-prompt section.
- Verify: `agent_before_settle` gate that runs the project's own checks by tier (syntax → fast → lint automatic; test/build confirmed once per repo), prunes failures, and drives a bounded repair loop (`maxRepairRounds`, stops on no changes or identical failure).
- Environment failures (missing tools, uninstalled deps, timeouts, services down) notify the user and disable the check for the session instead of looping the agent.
- `/profile`, `/verify` commands and the `run_checks` tool.
- Project-root resolution never climbs to the home directory (a stray `~/package.json` or a dotfiles repo at `~` must not turn `~` into the project).
