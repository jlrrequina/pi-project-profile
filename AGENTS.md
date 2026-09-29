# Working on pi-project-profile

A π (pi-coding-agent) extension package. `README.md` is the user-facing reference; this file is for contributors and agents.

## Hard constraints — do not regress

- **Erasable TypeScript only.** π loads `.ts` directly (Node type stripping / jiti): no `enum`, `namespace`, parameter properties, or decorators. Use `import type`, explicit `.ts` import extensions, `"type": "module"`. `tsc` enforces `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- **No runtime dependencies.** Import only from `node:*`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` (`Type`), `@earendil-works/pi-tui` (`Box`/`Text`/`Markdown`).
- **The prompt section must be deterministic per session** (no timestamps, branch names, or ordering that depends on iteration order) so prompt caching keeps working.
- **Never write into the target repository.** All state goes under `~/.pi/agent/project-profile/` or `$TMPDIR/pi-project-profile/`.
- **Never auto-run installs, migrations, deploys, or anything network-bound.** Tests and builds are confirm-once tiers (`TIER_POLICY` in `types.ts`). When unsure, fail to a no-op — never to a wrong action.
- **Bump `DETECTOR_VERSION`** in `detect/index.ts` whenever detector output shape or semantics change (it invalidates cached profiles).

## Verify your changes

```bash
npm run check                          # tsc, must be clean
npm test                               # node --test test/*.test.ts, all passing
node scripts/scan.ts <repo> --checks   # detector output for any real repository
npm run corpus                         # detection on ~20 real repositories (clones them; CI runs it too)
PI_PROJECT_PROFILE_DEBUG=1 pi -p "…"   # live gate trace in $TMPDIR/pi-project-profile/debug.jsonl
```

Add a unit test for every detector or planner change. Add changelog entries under `## Unreleased` in `CHANGELOG.md`; releases are cut by the Release workflow (see `CONTRIBUTING.md`), never by hand. Workflows pin actions to commit SHAs and must pass actionlint and zizmor.
