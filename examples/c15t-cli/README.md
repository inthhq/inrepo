# `@c15t/cli` as a real-world `--with-deps` case study

This case study asks whether inrepo can vendor the complete runtime dependency
graph of [`@c15t/cli`](https://www.npmjs.com/package/@c15t/cli) and then give
scriptc enough visible source to compile a narrow command such as `--help`
statically.

It is intentionally separate from the
[`examples/scriptc`](../scriptc) microbenchmark. The small example answers a
controlled performance question; this one measures how a production CLI
stresses dependency discovery, monorepo provenance, source materialization,
import rewiring, and static-compiler compatibility.

## Pinned subject

The probe fixes every identity involved in the result:

- npm package: `@c15t/cli@2.2.0`
- git repository: `https://github.com/c15t/c15t.git`
- release tag: `@c15t/cli@2.2.0`
- commit: `017433b2ca27e29177c320f51b973e4a78b6851e`
- npm `repository.directory`: `packages/cli`

The published package declares 16 direct runtime dependencies. A lock-only npm
12 resolution on 2026-08-12 contained 276 package entries; that count is a
scale observation rather than a stable assertion because transitive ranges can
move.

## Current result

Scoped-package materialization now works, so the command reaches the c15t
checkout correctly:

```sh
inrepo add @c15t/cli --ref @c15t/cli@2.2.0 --with-deps
```

The package lives inside a monorepo, however. The repository root declares
`c15t-workspace`; the package being requested lives at `packages/cli`.
`--with-deps` therefore stops before writing config, lockfile, or generated
modules:

```text
Cannot resolve dependencies for "@c15t/cli": the repository root declares package "c15t-workspace". Monorepo package subdirectories are not supported yet.
```

This explicit failure replaces the previous misleading result, which treated
the workspace root as `@c15t/cli` and printed an empty one-package graph.

Run the executable probe from the repository root with:

```sh
bun run test:c15t-cli-case
```

It checks the exact npm name/version, repository and subdirectory metadata,
the 16 direct runtime dependencies, the CLI diagnostic, and the guarantee that
the failed plan leaves project files untouched. CI runs the same probe.

## What must land before a benchmark

1. Preserve npm's `repository.directory` alongside each git URL and commit.
2. Materialize the package subdirectory as the module root while retaining the
   repository-level pin and patch provenance.
3. Reuse one cloned commit for multiple `@c15t/*` packages from the same
   monorepo instead of cloning the workspace repeatedly.
4. Resolve the full runtime graph and apply generated import rewiring between
   its vendored package roots.
5. Compile a narrow `@c15t/cli --help` path with scriptc and prove its stdout,
   stderr, and exit status match the npm-backed command.
6. Only after behavioral parity passes, compare dynamic npm and static vendored
   timings. Until then this case study publishes no performance claim.
