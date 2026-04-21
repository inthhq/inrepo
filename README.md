<p align="center">
  <a href="https://github.com/inthhq/inrepo?utm_source=github&utm_medium=repo_homepage" target="_blank" rel="noopener noreferrer">
    <strong>inrepo</strong>
  </a>
  <br />
  <sub>Vendor upstream git repositories into <code>inrepo_modules</code> from declarative config.</sub>
</p>

&nbsp;

[![GitHub stars](https://img.shields.io/github/stars/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/inthhq/inrepo/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/inrepo?style=flat-square)](https://www.npmjs.com/package/inrepo)
[![Top Language](https://img.shields.io/github/languages/top/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo)
[![Last Commit](https://img.shields.io/github/last-commit/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo/commits/main)
[![Open Issues](https://img.shields.io/github/issues/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo/issues)

## Overview

**inrepo** is a small CLI for teams who want upstream code in the repo tree—pinned, reviewable, and independent of the public npm tarball—without maintaining ad-hoc git submodules or copy-paste workflows. You declare packages in `inrepo.json` (or `package.json` under `"inrepo"`), run **`inrepo sync`**, and vendored trees land under **`inrepo_modules/`** with **`inrepo.lock.json`** for reproducible checkouts. **`inrepo verify`** confirms checkouts still match the lockfile.

## Package

| Package | Description | Key Features | Version |
|---------|-------------|--------------|---------|
| `inrepo` | Git vendoring CLI | Declarative config (`inrepo.json` or `package.json#inrepo`), `sync` / `verify` / `add`, npm name → GitHub URL resolution when `repository` is set, lockfile (`inrepo.lock.json`), strips `.git` after sync for plain-tree vendoring | [![npm](https://img.shields.io/npm/v/inrepo?style=flat-square)](https://www.npmjs.com/package/inrepo) |

## Quick start

Install and run from npm (requires [Node.js](https://nodejs.org/) 20+):

```bash
npx inrepo --help
```

From a clone of this repository, build then run locally:

```bash
bun install
bun run build
node dist/cli.mjs --help
```

Typical flow:

1. Add config at the project root—either **`inrepo.json`** or a **`"inrepo"`** field in **`package.json`**—listing `{ "name", "git?", "ref?" }` entries (or a top-level JSON array of those objects).
2. Run **`inrepo sync`** to clone or update into **`inrepo_modules/`**, update **`inrepo.lock.json`**, and wire **`package.json#packages`** to `file:inrepo_modules/...` where applicable.
3. Run **`inrepo verify`** in CI to ensure vendored trees match the lockfile.

**`inrepo add <name>`** vendors a single package (optional **`--git`**, **`--ref`**, **`--save`** to append **`inrepo.json`**).

## Documentation

- [Repository home](https://github.com/inthhq/inrepo) — source, issues, and changelog over time
- CLI usage: **`inrepo --help`** (same text as the help banner in the tool)

## Support

- Open an issue on the [GitHub repository](https://github.com/inthhq/inrepo/issues)
- Visit [inth.com](https://inth.com?utm_source=github&utm_medium=repo_homepage)

## Contributing

- We're open to community contributions.
- Fork the repository
- Create a new branch for your feature or fix
- Submit a pull request
- **All contributions, big or small, are welcome and appreciated.**

## Security

If you believe you have found a security vulnerability in inrepo, we encourage you to **_responsibly disclose this and NOT open a public issue_**. We will investigate all legitimate reports.

Our preference is that you make use of GitHub's private vulnerability reporting feature. To do this, please visit [https://github.com/inthhq/inrepo/security](https://github.com/inthhq/inrepo/security) and click the "Report a vulnerability" button.

### Security Policy

- Please do not share security vulnerabilities in public forums, issues, or pull requests
- Provide detailed information about the potential vulnerability
- Allow reasonable time for us to address the issue before any public disclosure
- We are committed to addressing security concerns promptly and transparently

## License

[MIT License](https://github.com/inthhq/inrepo/blob/main/LICENSE)


---

**Built by [Inth](https://inth.com?utm_source=github&utm_medium=repo_homepage)**
