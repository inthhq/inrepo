# `@c15t/cli` benchmarks

This directory now contains two deliberately separate results:

- [`full/`](full/) executes the real `@c15t/cli@2.2.0` source entry with its
  complete inrepo dependency closure and checks published-CLI parity.
- The remainder of this README describes the older selected help-renderer
  scriptc benchmark. It remains useful as a compiler microbenchmark, but it is
  not presented as full CLI performance.

## Selected-source help benchmark

This example measures one honest, narrow question: can scriptc statically
compile the help renderer selected from `@c15t/cli@2.2.0` source, and does that
renderer behave exactly like the same source using an npm dependency through
scriptc's dynamic runtime?

The answer for this selected source path is yes. This is deliberately **not** a
claim that inrepo can vendor or scriptc can statically compile the complete
c15t CLI dependency graph.

## Pinned source

The committed [`vendor/inrepo.json`](vendor/inrepo.json) and
[`vendor/inrepo.lock.json`](vendor/inrepo.lock.json) select:

- npm identity: `@c15t/cli@2.2.0`
- repository: `https://github.com/c15t/c15t.git`
- repository directory: `packages/cli`
- release tag: `@c15t/cli@2.2.0`
- peeled commit: `017433b2ca27e29177c320f51b973e4a78b6851e`
- retained source: `src/actions/show-help-menu.ts` plus `package.json`

`inrepo sync` runs in the isolated `vendor/` project and writes the selected
package under `vendor/inrepo_modules/@c15t/cli/`. [`prepare.ts`](prepare.ts) reads that generated
source, verifies its pinned SHA-256 from [`provenance.json`](provenance.json),
and creates ignored dynamic and static variants. There is no standalone source
copy pretending to be inrepo output.

The command and flag descriptors are copied from the same commit's
`packages/cli/src/index.ts` and `packages/cli/src/context/parser.ts`. The
renderer-only harness omits command actions and the rest of `CliContext`, since
the selected function does not execute them.

## Compared variants

- `demo-npm`: selected c15t help source with its upstream bare `picocolors`
  import, built using `scriptc --dynamic`.
- `demo-static`: the same selected source built statically. Its only
  dependency import is redirected to a no-color identity shim, matching the
  fixed `NO_COLOR=1` benchmark contract.
- Bun and Node executing the npm-import entrypoint are interpreter baselines.

Both scriptc variants receive the same two small compatibility restatements.
They are documented in [`PATCHES.md`](PATCHES.md): a narrow type-only context
import and an equivalent form of two `Math.max` calls that scriptc 0.0.26 can
lower.

## Parity gate

[`check.ts`](check.ts) runs the renderer both with no arguments and with
`--help`. It requires byte-identical stdout and stderr plus the same exit status
across Bun, Node, scriptc dynamic, and scriptc static before timing is allowed.
All runs fix `NO_COLOR=1`, `FORCE_COLOR=0`, and `CI=1`.

On Apple M5 Pro / macOS arm64 with Bun 1.3.11, Node 24.18.0, and scriptc 0.0.26:

- all 2 scenarios matched across all 4 variants;
- `demo-npm` was 1.1 MB;
- `demo-static` was 392 KB.

## Observed benchmark

Mitata measures cold process spawn plus rendering on each iteration. One clean
run on the machine above produced:

| variant | average | observed range |
| --- | ---: | ---: |
| scriptc dynamic, npm `picocolors` | 8.89 ms | 8.62–9.33 ms |
| scriptc static, selected c15t source | **1.74 ms** | 1.42–2.20 ms |
| Bun npm entrypoint | 10.23 ms | 9.57–11.08 ms |
| Node npm entrypoint | 42.09 ms | 40.57–43.68 ms |

For this renderer-only target, the static binary was about 5.1× faster than
the dynamic scriptc binary. This is not a full-CLI performance result.

## Reproduce

Requires Node 22.18+ (for direct TypeScript execution), Bun, clang, and macOS
arm64 for the native numbers shown above.

```sh
cd examples/c15t-cli
npm ci --ignore-scripts
npm run build
npm run check
npm run bench
```

`npm run build` first runs the repository's current inrepo CLI to reproduce the
selected source from the committed lock, then verifies the source hash and
builds both binaries. `npm run bench` always reruns the parity gate first.

From the repository root, this platform-neutral probe independently performs a
clean temporary `sync` and `verify`, checks npm provenance, and hashes the
materialized source:

```sh
bun run test:c15t-cli-case
```

The current `--with-deps` implementation also has a separate executable probe.
It runs the real registry resolver and materializer for `@c15t/cli@2.2.0`,
asserts lockfile version 5, integrity-pinned published artifacts, and distinct
`citty`, `content-type`, and `hono` module instances, removes the generated
module tree, and proves that `sync` and `verify` can rebuild and check it with
registry access disabled:

```sh
cd examples/c15t-cli
npm run probe:with-deps
```

The clean reference run for this stack resolved, materialized, synced, and
verified 188 exact runtime module instances. The probe accepts at least 180 so
new compatible transitive releases do not make the case artificially brittle.
This is a graph and source-materialization result, not an executable full-CLI
result: the probe deliberately stops before running the vendored
`@c15t/cli` entrypoint.

## Historical boundary of the selected benchmark

The complete published `@c15t/cli` runtime graph now resolves and materializes,
including incompatible versions, npm repository shorthand, missing monorepo
directory metadata, and releases pinned through npm publish metadata or
registry-hosted provenance. Full CLI execution remains beyond this case study:

- `--with-deps` follows published `dependencies`, but not npm peer or optional
  dependency installation semantics;
- package exports point at untracked build output under `dist/`, while source
  dependencies expose subpaths such as `@c15t/scripts/registry` through their
  missing `dist` output;
- source uses workspace aliases such as `~/*` and extensionless imports, which
  import rewiring does not currently translate;
- the real CLI entrypoint eagerly imports setup, codemod, backend, telemetry,
  filesystem, process, and browser-opening paths even for `--help`.

The separate [`full/`](full/) fixture now crosses the executable parity
boundary by using integrity-pinned published files only where repository
checkouts omit runtime output. Full static scriptc compilation remains blocked,
and its diagnostics are recorded there rather than hidden behind this renderer
extraction.
