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

**inrepo** is a small CLI for teams who want upstream code in the repo tree—pinned, reviewable, and independent of the public npm tarball—without maintaining ad-hoc git submodules or a separate long-lived fork. You declare packages in `inrepo.json` (or `package.json` under `"inrepo"`), pin the upstream commit in `inrepo.lock.json`, and keep your team's customizations as committed overlay files under `inrepo_patches/`. Running **`inrepo sync`** rebuilds **`inrepo_modules/`** from `upstream + our overlay`, and **`inrepo verify`** confirms the generated tree still matches that recipe.

## Package

| Package | Description | Key Features | Version |
|---------|-------------|--------------|---------|
| `inrepo` | Git vendoring CLI | Declarative config (`inrepo.json` or `package.json#inrepo`), `sync` / `patch` / `verify` / `add`, npm name → GitHub URL resolution when `repository` is set, lockfile (`inrepo.lock.json`), committed overlay tree (`inrepo_patches/`), wires `dependencies` / `devDependencies`, strips `.git` after sync for plain-tree vendoring | [![npm](https://img.shields.io/npm/v/inrepo?style=flat-square)](https://www.npmjs.com/package/inrepo) |

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

0. The **first** time you run **`inrepo sync`** or **`inrepo add`** in a repo that has neither **`inrepo.json`** nor a **`package.json`** **`"inrepo"`** field, the CLI asks whether config should live in **`inrepo.json`** or **`package.json`**, then writes an empty **`packages`** list you can edit (subsequent **`inrepo add`** calls record entries automatically). Init also recommends keeping **`inrepo_modules/`** and **`.inrepo/`** in **`.gitignore`** and appends them automatically in non-interactive mode. In CI or without a TTY, set **`INREPO_CONFIG=inrepo.json`** or **`INREPO_CONFIG=package.json`** instead, or create one of those stubs yourself. Set **`INREPO_NONINTERACTIVE=1`** only together with an existing config file or **`INREPO_CONFIG`**.

1. Add config at the project root—either **`inrepo.json`** or a **`"inrepo"`** field in **`package.json`**—listing `{ "name", "git?", "ref?", "dev?", "exclude?", "keep?" }` entries (or a top-level JSON array of those objects). Set **`"dev": true`** on an entry to wire **`package.json#devDependencies`** on sync; omit it or use **`false`** for **`#dependencies`**.
2. Optional **`keep`** (allowlist): when non-empty, only paths **equal to** an entry or under **`entry/`** are kept (POSIX `/`, no leading `/` on entries). List root files you still need (e.g. **`"package.json"`**) explicitly—nothing is kept implicitly. Root and per-package **`keep`** lists are merged (union). Runs **before** **`exclude`**. Use the object root shape `{ "packages": [...], "keep": [...] }`; bare array configs cannot carry root **`keep`**.
3. Optional **`exclude`**: runs after **`keep`**. Each entry is either a **literal relative path** (no leading `/`), e.g. `".agents"`, or a **slash-delimited regex** `/pattern/optionalflags` matched against every path under the module (forward slashes). Per-package **`exclude`** is merged with the root list. Use object root `{ "packages": [...], "exclude": [...] }` when you need root **`exclude`** (not on bare array configs).
4. Run **`inrepo add <name>`** once to create or refresh the upstream pin in **`inrepo.lock.json`**, or run **`inrepo sync`** to rebuild every configured package from the existing lockfile.
5. Edit files in **`inrepo_modules/<name>/`** as if it were your local working fork, then run **`inrepo patch <name>`** to capture those changes into **`inrepo_patches/<name>/`**. Commit **`inrepo.json`**, **`inrepo.lock.json`** (when the upstream pin changed), and **`inrepo_patches/`**. Do **not** commit **`inrepo_modules/`** or **`.inrepo/`**.
6. Run **`inrepo verify`** in CI to ensure vendored trees still match `lockfile + overlay`.

**`inrepo add <name>`** vendors a single package and, by default, records the entry in **`inrepo.json`** (or **`package.json`** under **`"inrepo"`**) after a successful checkout, so subsequent **`inrepo sync`** can replay it. Optional flags: **`-D`** / **`--dev`** for devDependencies, **`--git`**, **`--ref`**, **`--no-save`** to skip the config upsert (one-off vendoring).

## Shared Overlay Workflow

Think about the on-disk state in three layers:

- **`inrepo.lock.json`** chooses the exact upstream commit.
- **`inrepo_patches/<name>/`** stores your team's committed customizations as real files plus a `.inrepo-deletions` list.
- **`inrepo_modules/<name>/`** is generated output built from those two inputs.

That means the usual collaboration loop is:

1. `inrepo sync`
2. edit `inrepo_modules/<name>/...`
3. `inrepo patch <name>`
4. `git commit`
5. teammate pulls and runs `inrepo sync`

This keeps upstream code, your team’s changes, and the generated working copy clearly separated.

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
