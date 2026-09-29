# Security policy

## Reporting a vulnerability

Report it privately at <https://github.com/jlrrequina/pi-project-profile/security/advisories/new> (**Security → Report a vulnerability**). Please do not open a public issue.

Expect a first response within 7 days. Fixes ship as a patch release, and the advisory is published once the fix is on npm. Only the latest release is supported.

In scope: anything that makes the extension run commands it should not (installs, network access, writes into the repository), leak secrets into prompts or logs, or follow instructions planted in repository files.

## Verifying a release

Releases are built and published only by the [Release workflow](.github/workflows/release.yml), from the tagged commit, with no long-lived npm token (trusted publishing).

```bash
npm audit signatures                                   # in a project that installed the package: npm provenance
gh attestation verify lenard9191-pi-project-profile-<version>.tgz -R jlrrequina/pi-project-profile
gh release verify v<version> -R jlrrequina/pi-project-profile       # GitHub releases are immutable
```

The tarball attached to each GitHub release is byte-identical to the one on npm.
