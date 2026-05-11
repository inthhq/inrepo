# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in `inrepo`, we encourage you to **responsibly disclose this and NOT open a public issue**. We will investigate all legitimate reports.

Our preferred channel is GitHub's private vulnerability reporting:

1. Visit [https://github.com/inthhq/inrepo/security](https://github.com/inthhq/inrepo/security).
2. Click **Report a vulnerability**.
3. Fill in as much detail as you can, including reproduction steps, affected versions, and any logs or proof-of-concept material.

We will acknowledge receipt within a few business days and keep you updated as we investigate and remediate.

## Scope

In-scope:

- The `inrepo` CLI source under [`src/`](src/) and its published npm package.
- The release pipeline ([`.github/workflows/release.yml`](.github/workflows/release.yml)) and CI pipeline ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- The Homebrew formula in `inthhq/homebrew-tap` and its update automation.

Out of scope:

- Vulnerabilities in third-party packages we depend on. Please report those upstream; we will track and update once a fix is available.
- Self-inflicted misuse (for example, running `inrepo sync --force` and then complaining about lost edits — backups are written to `.inrepo/backups/`).

## Disclosure Guidelines

- Please do not share security vulnerabilities in public forums, issues, or pull requests.
- Provide detailed information about the potential vulnerability.
- Allow reasonable time for us to address the issue before any public disclosure.
- We are committed to addressing security concerns promptly and transparently.

## Supported Versions

We support the latest published `inrepo` release. Security fixes are released as patch versions on top of the current minor.

## Supply Chain

- `inrepo` is published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements). Verify with `npm view inrepo --json | jq '.dist'` or via the package page on npmjs.com.
- GitHub Actions used in our release pipeline are pinned to immutable commit SHAs.
- The Homebrew formula in `inthhq/homebrew-tap` installs from the published npm tarball and pins its `sha256`.
