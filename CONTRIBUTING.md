# Contributing

Issues and pull requests are welcome.

- Read [AGENTS.md](AGENTS.md): the hard constraints (erasable TypeScript only, no runtime dependencies, deterministic prompt section, never write into the target repository, never run installs or network-bound commands automatically).
- `npm install`, then `npm run check` and `npm test` must pass. CI runs them on Linux, macOS and Windows with Node 22.18, 24 and 26, smoke-tests the packed tarball and enforces a coverage floor.
- Every detector or planner change needs a unit test, and a run of `node scripts/scan.ts <dir> --checks` on a real repository that shows it.
- Bump `DETECTOR_VERSION` in `detect/index.ts` when detector output changes, and add a line to `CHANGELOG.md`.
- Detector changes also run `npm run corpus` in CI: detection on ~20 real repositories with invariants (deterministic, bounded prompt section, automatic checks never write files) and expectations per repository. Run it locally before changing a detector's output.
- Workflows pin every action to a commit SHA with the version in a comment (Dependabot keeps them current). CI lints them with actionlint and zizmor.
- For a wrong detection, the scan output of the repository is the most useful thing to include.

## Releasing

Add entries under `## Unreleased` in `CHANGELOG.md` as you go. To release: **Actions → Release → Run workflow** on `main`, with `patch`, `minor`, `major` or an exact version. Tick *dry-run* to rehearse: it tests the release commit and lists the files without pushing anything.

1. **prepare** (on `main`) moves the Unreleased notes under the new version, bumps `package.json`, runs the checks, then pushes the release commit and the `vX.Y.Z` tag.
2. **publish** (started on the tag) tests again, packs once, attests the tarball, publishes it to npm with provenance and attaches the same tarball to the GitHub release. Because it runs on the tag, the provenance points at exactly the released commit.

npm authentication is trusted publishing from the `npm` environment, which only `main` and `v*` tags can use: there is no npm token anywhere. Pushing a `vX.Y.Z` tag yourself (with `package.json` and a `## X.Y.Z` section already in place) runs step 2 directly. Every step is idempotent, so a failed release is finished by re-running it.
