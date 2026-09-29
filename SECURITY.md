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

Each release also carries the tarball's provenance as `lenard9191-pi-project-profile-<version>.tgz.intoto.jsonl`: the Sigstore bundle with the SLSA v1 build-provenance statement, its signature, the signing certificate and the transparency-log entry. It verifies without GitHub's attestation store (only the Sigstore trust root is fetched; pass `--custom-trusted-root` to avoid even that):

```bash
gh attestation verify lenard9191-pi-project-profile-<version>.tgz \
  --bundle lenard9191-pi-project-profile-<version>.tgz.intoto.jsonl -R jlrrequina/pi-project-profile
```

A successful verification shows the signer as `.github/workflows/release.yml@refs/tags/v<version>` in this repository. Releases up to 1.0.1 have no bundle attached; use the first command for them.
