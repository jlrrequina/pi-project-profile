# Contributing

Issues and pull requests are welcome.

- Read [AGENTS.md](AGENTS.md): the hard constraints (erasable TypeScript only, no runtime dependencies, deterministic prompt section, never write into the target repository, never run installs or network-bound commands automatically).
- `npm install`, then `npm run check` and `npm test` must pass. CI runs them on Linux, macOS and Windows.
- Every detector or planner change needs a unit test, and a run of `node scripts/scan.ts <dir> --checks` on a real repository that shows it.
- Bump `DETECTOR_VERSION` in `detect/index.ts` when detector output changes, and add a line to `CHANGELOG.md`.
- For a wrong detection, the scan output of the repository is the most useful thing to include.
