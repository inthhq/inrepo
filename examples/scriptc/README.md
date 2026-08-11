# inrepo + scriptc: compile your dependencies, not just your code

[scriptc](https://github.com/vercel-labs/scriptc) compiles TypeScript to native
binaries. Its [quickstart](https://scriptc.dev/quickstart#use-an-npm-dependency)
shows that npm dependencies need `--dynamic` mode: the package's shipped JS is
bundled into the binary and executed by an embedded QuickJS engine at runtime.

This example asks: **if the dependency source lives in your repo (vendored with
inrepo), can scriptc compile the dependency statically too — and is that
faster?**

Answer: yes, and by a lot.

## Benchmark

A tiny terminal app (`demo greet <name> --upper --repeat <n>`) built with
commander + picocolors, compiled two ways from the same app logic:

| variant | deps come from | scriptc mode | binary | avg run (spawn) |
| --- | --- | --- | --- | --- |
| `demo-vendored` | `inrepo_modules/` (this repo) | **static** | 750 KB | **2.05 ms** |
| `demo-npm` | `node_modules/` (npm) | `--dynamic` (QuickJS) | 1.2 MB | 15.66 ms |
| baseline | `node_modules/` | `bun cli.ts` | — | 22.72 ms |
| baseline | `node_modules/` | `node cli.ts` | — | 62.39 ms |

(mitata spawn-per-iteration benchmark, Apple M5 Pro, scriptc 0.0.25 —
rerun with `bun bench.ts`.)

The statically compiled vendored build is ~7.6× faster than the same app with
npm deps in dynamic mode, and ~30× faster than node. Both binaries produce
byte-identical output and exit codes across greet/help/version/error paths.

## Why inrepo is the enabler

scriptc can only compile what it can see and type-check. npm packages ship
build artifacts, so scriptc falls back to embedding a JS engine. Vendoring the
*upstream source* with inrepo puts the dependency inside the compiler's reach —
but upstream source is rarely static-compiler-clean, and that's where inrepo's
patch workflow does the real work:

```
npx inrepo add picocolors
npx inrepo add commander
# edit inrepo_modules/* until `scriptc build` is clean
npx inrepo patch commander && npx inrepo patch picocolors
git commit
```

The pinned commit + committed overlays in `inrepo_patches/` make the compiled
tree reproducible: `inrepo sync` rebuilds it and `inrepo verify` catches drift
in CI. (scriptc itself is exploring the same idea with its experimental
`--npm-static` and `--provenance-sources` flags; inrepo gets you there today
with reviewable, committed patches.)

## What had to be patched

picocolors was restated from a `createColors()` closure-factory into plain
exported function declarations (same output, ~40 lines). commander needed
roughly forty small edits across four files, in a few recurring categories:

- **JSDoc type tightening** — scriptc *trusts and enforces* JSDoc at runtime.
  Bare `Promise`/`Array` generics, untyped params, and untyped fields
  (`this._aliases = []`) all had to be annotated. Two were genuine upstream
  type bugs: `_findOption` declares `@return {Option}` but can return
  `undefined`, and `_helpCommand` is typed `{Command}` while initialized to
  `undefined` — the latter compiled but **segfaulted** the binary.
- **Union-narrowing rewrites** — commander's getter/setter methods
  (`name()` → `string | Command`) and `a && b` chains over mixed types don't
  lower; replaced with private-field reads and explicit `if` narrowing.
- **Stdlib gaps** — no lowering yet for `EventEmitter` (replaced with a
  Map-based emitter), `fn.apply` (action callbacks are now zero-arg; values
  are read via `processedArgs`/`opts()`), `Object.assign`, `Promise.then`,
  `process.exitCode`, `util.stripVTControlCharacters` (regex fallback),
  g-flag `match()` (manual scanner), sparse array writes (Levenshtein matrix
  rebuilt with `push`), and out-of-bounds indexing (`arr.slice(-1)[0]`).

Dropped in the static build (documented in the patches): async
hooks/actions, the deprecated RegExp form of `.option()`'s parse argument,
`configureHelp()` overrides, and the deprecated `outputHelp(callback)` form.

Two scriptc bugs surfaced along the way: the mis-typed-field segfault above,
and an internal compiler error (`union u0: arm 0 is jsval`) when compiling the
vendored source with `--dynamic` (which is why that third variant is absent
from the benchmark).

## Layout

- `cli.ts` — app with deps from npm (`import ... from "commander"`), built
  with `scriptc build cli.ts --dynamic -o demo-npm`
- `cli-vendored.ts` — same app importing `./inrepo_modules/...`, built with
  `scriptc build cli-vendored.ts -o demo-vendored` (no `--dynamic`)
- `inrepo.json` / `inrepo.lock.json` — pinned upstream commits
- `inrepo_modules/` — generated vendored checkouts (upstream @ pin + patches)
- `inrepo_patches/` — committed overlay files that make the deps compile
- `bench.ts` — mitata spawn benchmark

## Reproduce

Requires macOS arm64, clang, cmake (for the `--dynamic` build), Node 20+, bun.

```sh
npm install                      # commander, picocolors, scriptc, mitata
npx inrepo sync                  # rebuild inrepo_modules from lock + patches
npx scriptc build cli.ts --dynamic -o demo-npm
npx scriptc build cli-vendored.ts -o demo-vendored
bun bench.ts
```
