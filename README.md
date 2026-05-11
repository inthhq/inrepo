<p align="center">
  <a href="https://github.com/inthhq/inrepo?utm_source=github&utm_medium=repo_homepage" target="_blank" rel="noopener noreferrer">
    <strong>inrepo</strong>
  </a>
  <br />
  <sub>Bring upstream source into your repo without submodules, forks, or mystery patches.</sub>
</p>

&nbsp;

[![GitHub stars](https://img.shields.io/github/stars/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/inthhq/inrepo/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/inrepo?style=flat-square)](https://www.npmjs.com/package/inrepo)
[![Top Language](https://img.shields.io/github/languages/top/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo)
[![Last Commit](https://img.shields.io/github/last-commit/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo/commits/main)
[![Open Issues](https://img.shields.io/github/issues/inthhq/inrepo?style=flat-square)](https://github.com/inthhq/inrepo/issues)

## What is inrepo?

`inrepo` is a small CLI for vendoring upstream git repositories directly into your project.

Use it when you want the ergonomics of local source code, but still want the discipline of pinned dependencies. Instead of hiding changes in `node_modules`, publishing a private package, or keeping a long-lived fork alive, `inrepo` gives you a repeatable recipe:

```text
upstream git commit + your committed patches = generated local package
```

You edit the vendored code in `inrepo_modules/`, capture your changes into `inrepo_patches/`, and let teammates or CI rebuild the same tree with `inrepo sync`.

## Why this exists

Sometimes the safest way to depend on upstream code is to make the exact code visible in your normal repo workflow.

Package registries are convenient, but they are also an attack surface. Compromised package publishes, suspicious dependency changes, and install-time scripts are becoming more common. When that happens, teams need to know exactly what code they installed, what changed, and how to get back to a reviewed version quickly.

`inrepo` is not a magic security boundary, and it does not replace lockfiles, audits, or incident response. What it gives you is a clearer operational model for packages you care about deeply:

- Pin the upstream git commit you reviewed.
- Keep local changes as reviewable files in pull requests.
- Rebuild generated code from a small recipe instead of trusting a mutable working tree.
- Run `inrepo verify` in CI to catch drift.
- Depend on local `file:` packages from your root `package.json`.

That makes upstream code easier to inspect, patch, and reproduce when the package manager ecosystem gets noisy.

## Quick start

Run it in a project that wants to vendor upstream packages. `inrepo` requires [Node.js](https://nodejs.org/) 20+.

```bash
npx inrepo --help
```

Prefer `inrepo` permanently on your `$PATH`? Install via Homebrew on macOS or Linuxbrew:

```bash
brew tap inthhq/tap
brew install inrepo
inrepo --help
```

The formula installs the same artifact that `npm` publishes, so `npx inrepo` and `brew install inrepo` are interchangeable. The rest of this README uses `npx inrepo` because it requires no install; substitute `inrepo` after `brew install` if you prefer.

Initialize config:

```bash
npx inrepo init
```

Add and pin a package:

```bash
npx inrepo add <package>
```

If npm metadata does not point to the right GitHub repository, pass the git URL yourself:

```bash
npx inrepo add <package> --git https://github.com/owner/repo --ref main
```

Then work like this:

```bash
npx inrepo sync
# edit files in inrepo_modules/<package>/
npx inrepo patch <package>
git commit
```

Teammates can reproduce the generated package with:

```bash
npx inrepo sync
```

CI can check that nothing drifted:

```bash
npx inrepo verify
```

## The files

`inrepo` keeps a clean boundary between source inputs and generated output.

Commit these:

- `inrepo.json` or `package.json#inrepo` declares what to vendor.
- `inrepo.lock.json` pins each package to an exact upstream commit.
- `inrepo_patches/<package>/` stores your team's edits and deletions.

Do not commit these:

- `inrepo_modules/<package>/` is rebuilt by `inrepo sync`.
- `.inrepo/` stores cache, state, and backups.

The generated module is wired into your root `package.json` as a local `file:inrepo_modules/<package>` dependency. Use `npx inrepo add <package> -D` or `"dev": true` in config when it should land in `devDependencies`.

## Config

Prefer `inrepo.json` at the project root:

```json
{
  "packages": [
    {
      "name": "example-package",
      "git": "https://github.com/owner/repo",
      "ref": "main",
      "dev": false,
      "keep": ["src", "package.json"],
      "exclude": ["test", "/\\.snap$/"]
    }
  ],
  "keep": ["LICENSE"],
  "exclude": [".github"]
}
```

You can also put the same object under `package.json#inrepo`.

- `name` is the package name and destination under `inrepo_modules/`.
- `git` is optional when npm metadata can resolve the GitHub repository.
- `ref` can be a branch, tag, or commit before the lockfile resolves the exact commit.
- `dev` chooses `devDependencies` instead of `dependencies`.
- `keep` allowlists paths before exclusions run.
- `exclude` removes literal relative paths or slash-delimited regex matches.

## Built-in guardrails

`inrepo` tries not to silently destroy local work.

During sync, it compares the current generated module and overlay against recorded state. If `inrepo_modules/` changed but the overlay did not, it treats that as uncaptured work and asks you to run `npx inrepo patch`. If both changed, it reports a conflict. `npx inrepo sync --force` can discard generated edits, but saves a backup under `.inrepo/backups/`. If you installed the CLI globally, the same command is `inrepo sync --force`.

Patch capture is guarded too. `inrepo patch` compares your current vendored module against the pristine upstream tree, writes changed files into `inrepo_patches/`, and records deleted files in `.inrepo-deletions`.

## Local development

From a clone of this repository:

```bash
bun install
bun run build
node dist/cli.mjs --help
```

## Documentation

- [Overview](./docs/index.md)
- [Quickstart](./docs/quickstart.md)
- [Config reference](./docs/config.md)
- CLI usage: `npx inrepo --help`

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
