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

To vendor the package's runtime dependencies alongside it, add `--with-deps`:

```bash
npx inrepo add <package> --with-deps
```

Then work like this:

```bash
npx inrepo sync
# edit files in inrepo_modules/<package>/
npx inrepo patch <package> -m "why this change"
npx inrepo diff <package>
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
- `inrepo.lock.json` pins each package to an exact upstream commit, and records the dependency graph when you vendor one.
- `inrepo_patches/<package>/` stores your team's edits and deletions.

Two patch formats are supported:

- `inrepo_patches/<package>/series/0001-*.patch` is an ordered git patch series. Patches are standard `git format-patch --binary` output, applied in filename order with `git am --3way` on top of the pinned upstream commit. There is no separate series manifest; the file name is the order.
- `inrepo_patches/<package>/` whole-file snapshots plus `.inrepo-deletions` are the original overlay format. They still work, and keep being used by any package that still has them.

New captures go into the patch series. A package only stays on the snapshot format while snapshot files are present; run `npx inrepo migrate <package>` to move it across.

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

Patch capture is guarded too. `inrepo patch` refuses to run when the overlay changed behind your back, and tells you to sync first.

## Capturing a patch

`inrepo patch <package> -m "reason"` compares `inrepo_modules/<package>` against the patched tree — the pinned upstream commit plus the patches already in the series — and appends whatever you changed as the next numbered patch:

```bash
npx inrepo patch <package> -m "Replace the event emitter for static compilation"
```

Every invocation writes a new patch; there is no amend or squash. The `-m` text becomes the patch subject, so the message is required. When nothing changed, the command says so and writes no patch.

Patch headers are the provenance record. `From:`, `Date:`, and `Subject:` capture who made the change, when, and why, so no separate manifest is needed. The author comes from your git `user.name` and `user.email`.

Packages that still carry snapshot files keep the original capture behavior: `inrepo patch <package>` rewrites the whole-file overlay and records deleted files in `.inrepo-deletions`.

## Reviewing what you changed

`inrepo diff` shows the effective delta between the pinned upstream commit and the patched tree, so a review sees hunks instead of whole replacement files:

```bash
npx inrepo diff <package>          # unified diff, plus the patch series that produced it
npx inrepo diff <package> --stat   # per-file +/- summary
npx inrepo diff                    # every vendored package
```

The diff is rendered by git, so deletions, mode changes, symlinks, and binary files all read correctly. Packages on the snapshot format are covered too, including their `.inrepo-deletions` entries. `inrepo diff` is a viewer: it exits 0 whether or not there are differences, and only fails on an unknown or unvendored package.

## Updating to a newer upstream commit

`inrepo update <package>` re-resolves the pinned ref, rebases the committed patch series onto the new upstream commit, and rebuilds everything:

```bash
npx inrepo update <package>              # follow the configured ref to its current tip
npx inrepo update <package> --ref v2.1.0 # move to another branch, tag, or commit
```

The rebase runs in a scratch git repository, so upstream changes to a patched file are merged instead of hidden. When it succeeds, `inrepo` rewrites the series (renumbered from `0001`, with every patch's original subject, author, and date preserved), updates `inrepo.lock.json`, saves a `--ref` back to your config, and re-syncs `inrepo_modules/<package>`. A patch upstream has since adopted itself is dropped. Nothing is written until the rebase finishes, so a failed update leaves the repository exactly as it was.

Packages with no patches are simply re-pinned and rebuilt. Packages still on the snapshot format cannot be rebased; run `npx inrepo migrate <package>` first.

### Resolving update conflicts

When a patch and upstream touch the same lines, the update stops and reports the patch that failed and the conflicted files. The in-progress rebase is kept in `.inrepo/updates/<package>/repo`, an ordinary git work tree with ordinary conflict markers:

```text
<<<<<<< HEAD
export const v = 3;
=======
export const v = 42;
>>>>>>> Bump the exported version
```

Edit those files in place — there is no need to `git add` anything — then:

```bash
npx inrepo update <package> --continue   # finish the rebase and move the pin
npx inrepo update <package> --abort      # throw the update away, changing nothing
```

`--continue` picks up where git stopped and repeats the report if a later patch conflicts too. If your resolution leaves a patch with nothing to apply, that patch is dropped from the series. Until an update finishes, `inrepo_patches/`, your config, the lockfile, and `inrepo_modules/` are untouched, and starting another update for the same package tells you to finish or abandon this one first.

## Vendoring transitive dependencies

`inrepo add <package>` vendors exactly one package, so its imports of other packages still resolve through `node_modules`. Add `--with-deps` to vendor the whole runtime dependency tree as visible source instead:

```bash
npx inrepo add <package> --with-deps
```

`inrepo` reads `dependencies` from the pinned checkout, resolves each range to an exact published version, maps that version to its repository and release tag, and recurses. Only runtime `dependencies` are followed — `devDependencies` and `peerDependencies` are deliberately out of scope, because neither is needed to run the vendored source.

The resolved tree is printed before anything is written:

```text
commander 12.1.0 (a1b2c3d)
├─ picocolors ^1.0.0 → 1.1.1 (9f3e21c)
└─ shared ^2.0.0 → 2.4.0 (77c0b8a)
   └─ picocolors ^1.0.0 → 1.1.1 (9f3e21c) (deduped)
```

Every resolved package is then vendored exactly like a package you added by hand: a config entry pinned to its release tag, its own lockfile entry, a materialized `inrepo_modules/<package>`, and an empty patch surface you can start capturing patches into. A dependency that is already vendored at a compatible version is reused rather than re-pinned, and running `--with-deps` again on a package you already vendored simply completes the missing part of its graph.

Scoped names retain their npm layout throughout the workflow: `@scope/pkg` is materialized at `inrepo_modules/@scope/pkg`, recorded under that full name in the graph, and replays through `sync` and `verify` like an unscoped package.

The edges themselves are recorded under `graph` in `inrepo.lock.json`, which raises the file to `lockfileVersion: 2`:

```json
{
  "lockfileVersion": 2,
  "modules": { "…": {} },
  "graph": {
    "commander": {
      "version": "12.1.0",
      "root": true,
      "dependencies": {
        "picocolors": { "range": "^1.0.0", "version": "1.1.1", "module": "picocolors" }
      }
    },
    "picocolors": { "version": "1.1.1" }
  }
}
```

Because every dependency entry pins an exact git URL and tag, `inrepo sync` and `inrepo verify` replay and check the whole graph from committed files with no registry access at all. A project with no recorded graph keeps writing `lockfileVersion: 1`.

`inrepo update <package>` keeps that graph in step with the pin it moves: the package's recorded `version` and the resolved `version` on every edge pointing at it are re-read from the rebuilt checkout, so `inrepo verify` stays clean. Ranges are not re-resolved — that is `--with-deps`'s job — so when the new version no longer satisfies a dependent's recorded range, `update` names the dependent and the range in a warning and leaves the range alone.

Resolution fails — before a single package is vendored — when:

- two packages need the same dependency at ranges no published version satisfies. The message names both dependents and their ranges. Resolving version conflicts is out of scope; vendor the conflicting packages separately.
- a dependency uses a source `inrepo` cannot pin: `workspace:`, `file:`, `link:`, `catalog:`, `npm:` aliases, git URLs, tarball URLs, or a dist-tag.
- a package's `package.json` lives in a monorepo subdirectory rather than at the repository root.
- a dependency has no usable `repository` URL on the registry, or its repository has no tag for the resolved version.

In every case the message names the dependency and the reason, and the fix is to vendor that one package by hand with `npx inrepo add <dep> --git <url> --ref <ref>`.

Overlapping ranges are not a conflict: `^1.0.0` and `>=1.2.0` unify onto the highest published version satisfying both.

`--with-deps` cannot be combined with `--no-save`, since a graph is only replayable from committed config and lockfile entries.

### Rewiring imports between vendored packages

Vendoring the graph does not, on its own, make it self-contained: the source still says `import pc from "picocolors"`, which only resolves through `node_modules`. Turn on import rewiring to point those specifiers at the sibling checkouts instead:

```json
{
  "rewireImports": true,
  "packages": [{ "name": "commander" }, { "name": "picocolors" }]
}
```

`inrepo_modules/commander/lib/help.js` then reads:

```js
import pc from '../../picocolors/picocolors.js';
```

The setting is off by default, so existing projects are unchanged. Set it at the root to cover every package, or per package to opt one in or out:

```json
{
  "rewireImports": true,
  "packages": [{ "name": "commander", "rewireImports": false }]
}
```

What gets rewritten, and what does not:

- Only bare specifiers naming a package that the recorded `graph` lists as a runtime dependency of the importing package. A specifier for anything else — a package you did not vendor, `node:` builtins, relative paths, `#` aliases, URLs — is left alone.
- `import`, `export … from`, `import(…)`, and `require(…)`, in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts` files. Specifiers are located with a JavaScript lexer, not a text search, so a package name inside a string, comment, template literal, or regular expression is never touched.
- Subpaths keep their shape: `pkg/sub/thing.js` becomes a relative path to that file inside `inrepo_modules/pkg`.
- A bare package name resolves to a concrete file — the dependency's `exports`, `module`, or `main` entry, honoring `import` and `require` conditions — because Node's ESM resolver does no directory or `main` lookup for relative specifiers. `import "../picocolors"` would fail where `import "../picocolors/picocolors.js"` works.
- A specifier that names a vendored dependency but resolves to no file in it (a subpath that does not exist, say) is reported as a warning and left exactly as upstream wrote it, so the generated tree stays reproducible either way.

Rewiring is a **generated** transform, applied after the patch series, and it never enters the patch surface:

- `inrepo diff` renders the patched tree, so it never shows a rewritten specifier.
- `inrepo patch <package> -m "…"` computes the same rewrites against the patched tree and undoes them before comparing, so a captured patch contains your edit and nothing else — even when you edited the lines next to a rewired import.
- `inrepo verify` reapplies the transform and compares, so a correctly rewired checkout passes and a hand-edited specifier is reported as drift.
- `inrepo sync` and `inrepo update` reapply it every time, from committed files only. Rewiring the same tree twice changes nothing.

Because a rewritten specifier points into a dependency's checkout, `sync` vendors dependencies before the packages that need them, and reports what it rewrote:

```text
Synced "commander" @ a1b2c3d → …/inrepo_modules/commander
  Rewired 3 import specifiers in 2 files of "commander"
```

## Migrating to a patch series

Convert a package's snapshot overlay into a git patch series:

```bash
npx inrepo migrate <package>
```

This replays the current overlay over the pinned upstream commit, records the result as `inrepo_patches/<package>/series/0001-*.patch`, and removes the snapshot files only after confirming that applying the series reproduces the identical tree. If it does not, the overlay is left exactly as it was and the command reports why. Empty directories are the one thing a series cannot carry over, because git has no way to record them; the command lists any it had to drop.

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
