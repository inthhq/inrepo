# inrepo

## 0.1.0

### Minor Changes

- 11a805e: Rewire imports between vendored packages with the new `rewireImports` config setting. When it is on, `sync` rewrites bare specifiers that name a vendored runtime dependency into relative paths pointing at the sibling `inrepo_modules/<dep>` checkout, so a graph vendored with `--with-deps` resolves as plain source with no `node_modules` lookup. A bare package name resolves to the dependency's `exports`, `module`, or `main` entry file — honoring `import` and `require` conditions — because Node's ESM resolver does no directory or `main` lookup for relative specifiers; subpaths keep their shape. Specifiers are located with a JavaScript lexer in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts` files, covering `import`, `export … from`, `import(…)`, and `require(…)`, so a package name inside a string, comment, template literal, or regular expression is never touched, and anything that is not a vendored dependency is left alone. A specifier that names a vendored dependency but resolves to no file is reported and left unchanged. The setting is off by default and can be set project-wide or overridden per package. Rewiring is a generated transform applied after the patch series: `inrepo diff` never shows it, `inrepo patch` undoes it before capturing so patches hold only real edits, and `inrepo verify` reapplies it, accepting a correctly rewired tree and flagging a hand-edited specifier. `sync` and `add` now vendor dependencies before the packages that need them and report what was rewritten.
- 3c419e9: Add git patch series support. A package can now keep its committed changes as ordered `inrepo_patches/<package>/series/0001-*.patch` files, generated with `git format-patch --binary` and applied in filename order with `git am --3way` on top of the pinned upstream commit. `sync` and `verify` use the series when one exists and keep using legacy whole-file overlays otherwise, and the new `inrepo migrate <package>` command converts an overlay into a series after verifying that it reproduces the identical tree.
- 91a5e4c: Resolve registry packages to immutable source commits using npm `gitHead`, matching release tags, or registry-hosted npm provenance cross-checked against the tarball digest and repository, and discover missing monorepo package directories from the pinned checkout. `inrepo add --with-deps` now gives transitive packages versioned module identities so incompatible versions can coexist, records exact graph edges in lockfile version 4, and replays each instance through sync, verify, diff, patch, and import rewiring.
- ae5f33f: Support packages rooted in monorepo subdirectories, including npm `repository.directory` discovery, explicit `--repository-directory` sources, shared repository snapshots, lockfile v3 provenance, and dependency-graph replay using published workspace dependency rewrites.
- e11f80f: Update a vendored package by rebasing its patch series. `inrepo update <package> [--ref <ref>]` re-resolves the pinned ref, replays the committed series onto the new upstream commit in an isolated scratch repository, and only then rewrites the series (renumbered from `0001`, with each patch's original subject, author, and date preserved), the config ref, `inrepo.lock.json`, and the generated module. Patches upstream has since adopted are dropped. Conflicts stop the update with the failing patch subject and the conflicted paths, keeping the half-finished rebase under `.inrepo/updates/<package>/repo` for `inrepo update <package> --continue` or `--abort`, and leaving every committed file untouched. Packages with no patches are re-pinned and rebuilt; packages still on the legacy whole-file overlay are told to run `inrepo migrate` first.
- 6612687: Capture patches with a reason and review them. `inrepo patch <package> -m "reason"` now appends the current edits in `inrepo_modules/<package>` to the package's patch series as the next numbered `git format-patch` file, using the message as the patch subject; each invocation writes a new patch, and an unchanged module reports that there is nothing to capture. New packages start on the series format, while packages that still carry whole-file snapshots keep the original overlay capture. The new `inrepo diff [package] [--stat]` command renders the effective delta from the pinned upstream commit to the patched tree with git, so deletions, mode changes, symlinks, and binary files all read correctly, and lists each patch's subject, author, and date as the provenance record.
- 9092064: Retain integrity-pinned npm artifacts for registry dependencies and fill publish-only runtime files that are absent from immutable git checkouts. Artifact-assisted locks use version 5 and replay offline from a content-addressed cache without replacing repository source.
- 75c2527: Vendor a package's transitive runtime dependencies with `inrepo add <package> --with-deps`. The whole closure is resolved before anything is written: each `dependencies` range from the pinned checkout is resolved to an exact published version, mapped to its repository and release tag, and recursed into, with overlapping ranges from different dependents unified onto one version and already vendored packages reused rather than re-pinned. `devDependencies` and `peerDependencies` are not followed. Every resolved package is vendored like a hand-added one — config entry, lockfile pin, generated module, empty patch surface — and the resolved tree is printed first. Scoped package names retain their npm directory layout and full graph keys. Non-overlapping ranges and unsupported dependency sources (`workspace:`, `file:`, `link:`, `catalog:`, `npm:` aliases, git or tarball URLs, dist-tags, monorepo package subdirectories, missing repository metadata, missing release tags) fail with the dependents and the reason named, before any package is vendored. The graph itself is recorded under `graph` in `inrepo.lock.json` (raising it to `lockfileVersion: 2`, which older files stay compatible with), so `inrepo sync` and `inrepo verify` replay and check it entirely offline. Plain `inrepo add` is unchanged. `inrepo update <package>` keeps a recorded graph in step with the pin it moves: the package's own version and the resolved version on every edge pointing at it are re-read from the rebuilt checkout, and a dependent whose recorded range the new version no longer satisfies is named in a warning instead of being re-resolved.

### Patch Changes

- 9d400c5: Prefer Node export conditions when rewiring CLI imports and add a full `@c15t/cli@2.2.0` executable parity case study backed by a committed 188-module lock.

## 0.0.8

### Patch Changes

- 75bfd28: Pin dependency versions instead of using caret ranges so `bun install --frozen-lockfile` and the published package resolve identically across machines and CI.
- 75bfd28: Add Homebrew tap support. `inrepo` is now installable via `brew tap inthhq/tap && brew install inrepo` from [inthhq/homebrew-tap](https://github.com/inthhq/homebrew-tap). Each npm release auto-opens a PR there with the new tarball URL and `sha256`, gated by `brew audit --strict --online` and `brew test` before merge.

## 0.0.7

### Patch Changes

- 56e7038: Update the CLI banner artwork, generate its fixed-width terminal padding at runtime, and ask interactive init users if they want to open GitHub to star inrepo.

## 0.0.6

### Patch Changes

- b4803c9: tweaked module repos and .inrepo

## 0.0.5

### Patch Changes

- 638a874: added patch system

## 0.0.4

### Patch Changes

- a4b44cf: We have added patching system to the cli + new cli harness
