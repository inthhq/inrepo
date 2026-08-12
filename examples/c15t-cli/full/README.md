# Full `@c15t/cli` source parity

This is the honest full-entry case study. It executes the real
`@c15t/cli@2.2.0` `src/index.ts`, including its eagerly imported command graph,
from an inrepo-materialized 188-module closure. It does not extract the help
renderer or replace the CLI with a benchmark-only entrypoint.

## What is pinned

[`vendor/inrepo.lock.json`](vendor/inrepo.lock.json) records:

- `@c15t/cli@2.2.0` at c15t commit
  `017433b2ca27e29177c320f51b973e4a78b6851e` and `packages/cli`;
- 188 exact module instances under lockfile version 5;
- edge-specific versions where npm needs incompatible `citty`, `content-type`,
  `hono`, and `jose` instances;
- each registry dependency's immutable Git source plus the npm tarball URL and
  integrity used to restore publish-only runtime files.

The generated module keeps repository files as the authoritative source.
Integrity-checked npm payloads only fill absent files such as `dist/`; they do
not overwrite source or `package.json`. This is accurately described as
"vendored CLI source with integrity-pinned published dependency artifacts," not
as every dependency executing raw repository source.

## Parity gate

[`check.ts`](check.ts) compares the published npm `dist/index.mjs` against the
real vendored `src/index.ts` under the same Bun runtime, cwd, non-interactive
environment, fixture `package.json`, and disabled telemetry. It requires exact
exit status, stdout, and stderr for:

- `--help --no-telemetry`;
- `--version --no-telemetry`;
- an invalid `--logger` value followed by `--version`;
- the safe real command path `codemods --dry-run --no-telemetry`.

It also proves that no `node_modules` directory exists anywhere in the
candidate entry's resolution ancestry and that the controlled fixture is not
mutated. The observed run passed all four cases:

| case | exit | stdout | stderr |
| --- | ---: | ---: | ---: |
| help | 0 | 3,242 bytes | 0 bytes |
| version | 0 | 48 bytes | 0 bytes |
| invalid logger | 0 | 48 bytes | 82 bytes |
| codemods dry run | 0 | 829 bytes | 0 bytes |

`prepare.ts` copies the committed fixture to an OS temporary directory, runs
`sync` with registry resolution disabled, and runs `verify`. A populated cache
therefore replays without consulting npm packuments; a fresh machine still
needs access to the locked Git repositories and tarball URLs to populate its
content-addressed caches.

## Size

One Apple M5 Pro / macOS 26.5 run with Bun 1.3.11 and Node 24.18.0 measured:

| material | packages/modules | files | size |
| --- | ---: | ---: | ---: |
| npm ordinary-dependency closure | 185 | 9,653 | 68.9 MB |
| generated `inrepo_modules` closure | 188 | 22,957 | 197.1 MB |
| content-addressed Git cache | — | 48,865 | 429.6 MB |
| integrity-pinned artifact cache | — | 9,839 | 68.7 MB |
| filtered package views | — | 22,769 | 196.9 MB |

The inrepo module tree is about 2.9× the npm closure size because it keeps
reviewable repository source alongside published runtime output. With all
rebuild caches retained, the working footprint is about 892 MB. These are
source-auditability costs, not size wins.

## Startup benchmark

`bench.ts` first runs the parity gate, warms each variant, then interleaves 40
cold process starts per variant with a warm filesystem:

| case | variant | mean | p50 | p95 |
| --- | --- | ---: | ---: | ---: |
| help | published npm dist | 230.92 ms | 290.00 ms | 298.82 ms |
| help | vendored source | 236.74 ms | 173.91 ms | 310.42 ms |
| version | published npm dist | 234.67 ms | 289.99 ms | 307.99 ms |
| version | vendored source | 242.16 ms | 186.73 ms | 327.04 ms |

The distributions are bimodal on this machine, so the mean and p95 are more
useful than comparing the p50 values in isolation. The honest result is that
full vendored source startup is close but slightly slower on average—about 2.5%
for help and 3.2% for version. The earlier selected-renderer static benchmark is
a different, intentionally narrow measurement.

## Why there is no full scriptc number yet

scriptc 0.0.26 does not compile this full entry. The exact vendored source
attempt exits 1 with no binary and 256 diagnostics: 232 `SC0001`, 12 `SC1010`,
11 `SC1012`, and one `SC0002`. Remaining gaps include c15t's `~/*` aliases,
default Node builtin imports, URL and fetch typings, directory-entry APIs, and
the eagerly imported ts-morph codemod surface.

Publishing a static timing for a renderer extraction as if it represented this
entry would be misleading. Full scriptc size and speed remain gated on a real
successful compile and the same four parity cases.

## Reproduce

```sh
cd examples/c15t-cli
npm ci --ignore-scripts
npm run full:prepare
npm run full:check
npm run full:stats
npm run full:bench
```
