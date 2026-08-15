# Full `@c15t/cli` source parity

This is the honest full-entry case study. It executes the real
`@c15t/cli@2.2.0` `src/index.ts` from an inrepo-materialized 188-module closure.
It does not extract the help renderer or replace the CLI with a benchmark-only
entrypoint.

The fixture also carries one reviewable inrepo patch: command implementations
are dynamically imported from their actions instead of being loaded eagerly at
startup. Command metadata and behavior, context setup, telemetry, the help
renderer, and the real command implementations are unchanged. This models the
production refactor we would propose upstream, and the patch is reproduced
during every `sync`.

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
cold process starts per variant with a warm filesystem. It includes the safe
`codemods --dry-run` command as a heavy-route check, so the fast startup result
cannot hide a second-process handoff or a regression in real command routing.

On the same Apple M5 Pro / macOS 26.5 machine used for the size measurements:

| case | variant | mean | p50 | p95 |
| --- | --- | ---: | ---: | ---: |
| help | published npm dist | 173.64 ms | 169.73 ms | 197.51 ms |
| help | vendored lazy source | **43.74 ms** | 43.09 ms | 49.03 ms |
| version | published npm dist | 168.82 ms | 167.09 ms | 180.58 ms |
| version | vendored lazy source | **41.66 ms** | 41.21 ms | 45.02 ms |
| codemods dry run | published npm dist | 240.12 ms | 301.14 ms | 310.48 ms |
| codemods dry run | vendored lazy source | **214.17 ms** | 164.21 ms | 286.94 ms |

The dynamic import stays in the same Bun process. A selected command pays a
single module-import dispatch, but it no longer loads every unrelated command.
That means setup/generate is not routed through another executable, and heavy
commands are not expected to regress. We deliberately benchmark codemods rather
than setup because setup is interactive and mutates a project. In this run the
real codemods route was about 11% faster on mean, while help and version were
about 4× faster. The distributions can be bimodal on this machine, so mean and
p95 are reported alongside p50.

## Why there is no full scriptc number yet

scriptc 0.0.26 does not compile this full entry. The exact vendored source
attempt still exits 1 with no binary and 256 diagnostics: 232 `SC0001`, 12
`SC1010`, 11 `SC1012`, and one `SC0002`. scriptc currently follows dynamic
imports while compiling, so lazy command loading improves Bun startup but does
not conceal the remaining static-compiler gaps. Those include c15t's `~/*`
aliases, default Node builtin imports, URL and fetch typings, directory-entry
APIs, and the ts-morph codemod surface.

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
