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

The stack progressively teaches the command to select `packages/cli` from the
c15t monorepo:

```sh
inrepo add @c15t/cli --ref @c15t/cli@2.2.0 --with-deps
```

The metadata layer first records the directory while retaining the previous
workspace-root diagnostic. The materialization layer then reaches
`packages/cli` but still reads `workspace:*` from the git checkout. The graph
layer pairs that checkout with the published manifest and progresses until a
selected transitive dependency has no recognizable release tag. At every
layer, `--with-deps` stops before writing config, lockfile, or generated
modules.

```text
# Metadata layer:
Cannot resolve dependencies for "@c15t/cli": the repository root declares package "c15t-workspace".

# Materialization layer:
Unsupported dependency source: "@c15t/cli" depends on "@c15t/backend" as "workspace:*".

# Later in the stack:
Unsupported dependency source: no tag for "@scalar/hono-api-reference@0.11.8" could be found.
```

These explicit failures replace the previous misleading result, which treated
the workspace root as `@c15t/cli` and printed an empty one-package graph.

Run the executable probe from the repository root with:

```sh
bun run test:c15t-cli-case
```

It checks the exact npm name/version, repository and subdirectory metadata,
the 16 direct runtime dependencies, a known dependency-provenance diagnostic,
and the guarantee that the failed plan leaves project files untouched. CI runs
the same probe.

## What must land before a benchmark

1. Resolve package versions that have no recognized release tag using reliable
   registry provenance or an explicit override.
2. Support multiple incompatible versions of the same package in one vendored
   dependency graph.
3. Resolve the full runtime graph and apply generated import rewiring between
   its vendored package roots.
4. Compile a narrow `@c15t/cli --help` path with scriptc and prove its stdout,
   stderr, and exit status match the npm-backed command.
5. Only after behavioral parity passes, compare dynamic npm and static vendored
   timings. Until then this case study publishes no performance claim.
