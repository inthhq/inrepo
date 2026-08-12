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

| variant         | deps come from                | scriptc mode          | binary | observed avg run (spawn) |
| --------------- | ----------------------------- | --------------------- | ------ | ------------------------ |
| `demo-vendored` | `inrepo_modules/` (this repo) | **static**            | 750 KB | **1.98–2.65 ms**         |
| `demo-npm`      | `node_modules/` (npm)         | `--dynamic` (QuickJS) | 1.2 MB | 12.77–17.81 ms           |
| baseline        | `node_modules/`               | `bun cli.ts`          | —      | 23.90–33.13 ms           |
| baseline        | `node_modules/`               | `node cli.ts`         | —      | 54.33–73.89 ms           |

(Two clean mitata spawn-per-iteration runs on an Apple M5 Pro with scriptc
0.0.25. The range shows the reported run averages; cold-spawn timing moves
with CPU power state. Reproduce with `npm run bench`.)

The statically compiled vendored build was ~6.5–6.7× faster than the same app
with npm deps in dynamic mode, and ~27–28× faster than node. Both binaries
produce byte-identical output and exit codes across greet/help/version/error
paths.

## Why inrepo is the enabler

scriptc can only compile what it can see and type-check. npm packages ship
build artifacts, so scriptc falls back to embedding a JS engine. Vendoring the
_upstream source_ with inrepo puts the dependency inside the compiler's reach —
but upstream source is rarely static-compiler-clean, and that's where inrepo's
patch workflow does the real work:

```
npx inrepo add picocolors
npx inrepo add commander
# edit inrepo_modules/* until `scriptc build` is clean
npx inrepo patch commander -m "restate operations scriptc has no lowering for yet"
npx inrepo patch picocolors -m "restate the createColors closure factory as exported functions"
git commit
```

Each `inrepo patch` call appends one numbered `git format-patch` file to
`inrepo_patches/<package>/series/`, and the `-m` message becomes the patch
subject — the permanent record of _why_ that change exists. The pinned commit
plus the committed series make the compiled tree reproducible: `inrepo sync`
replays the patches with `git am --3way` and `inrepo verify` catches drift in
CI. (scriptc itself is exploring the same idea with its experimental
`--npm-static` and `--provenance-sources` flags; inrepo gets you there today
with reviewable, committed patches.)

## What had to be patched

picocolors was restated from a `createColors()` closure-factory into plain
exported function declarations (same output, ~40 lines). commander needed
roughly forty small edits across four files, split into one patch per
rationale:

```
inrepo_patches/commander/series/
  0001-Annotate-commander-types-so-scriptc-can-enforce-them.patch
  0002-Replace-EventEmitter-inheritance-with-a-minimal-Map-.patch
  0003-Drop-deprecated-and-async-commander-APIs-the-static-.patch
  0004-Restate-operations-scriptc-has-no-lowering-for-yet.patch
  0005-Rewrite-union-typed-getters-and-mixed-boolean-chains.patch
inrepo_patches/picocolors/series/
  0001-Restate-the-createColors-closure-factory-as-exported.patch
  0002-Drop-the-CommonJS-type-declarations-that-no-longer-d.patch
```

`inrepo diff <package> [--stat]` shows the effective delta against the pinned
upstream commit, with the series that produced it:

```console
$ npx inrepo diff commander --stat
commander @ ba6d13d — patch series (5 patches)
  0001  Annotate commander types so scriptc can enforce them at runtime  (Kaylee, 2026-08-11, 4 files)
  0002  Replace EventEmitter inheritance with a minimal Map-based emitter  (Kaylee, 2026-08-11, 1 file)
  0003  Drop deprecated and async commander APIs the static build cannot support  (Kaylee, 2026-08-11, 1 file)
  0004  Restate operations scriptc has no lowering for yet  (Kaylee, 2026-08-11, 3 files)
  0005  Rewrite union-typed getters and mixed boolean chains for static narrowing  (Kaylee, 2026-08-11, 2 files)

 lib/command.js        | 411 ++++++++++++++++++++++++++++++++------------------
 lib/help.js           | 146 ++++++++++++++----
 lib/option.js         |   3 +
 lib/suggestSimilar.js |  40 +++--
 4 files changed, 413 insertions(+), 187 deletions(-)
```

(Author emails are abbreviated above; the real output prints them in full.)

The recurring categories behind those patches:

- **JSDoc type tightening** — scriptc _trusts and enforces_ JSDoc at runtime.
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

Dropped in the static build (patch 0003): async hooks/actions, the deprecated
RegExp form of `.option()`'s parse argument, `configureHelp()` overrides, and
the deprecated `outputHelp(callback)` form.

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
- `inrepo_patches/<package>/series/` — the committed, ordered git patch series
  that makes each dep compile; one numbered `git format-patch` file per
  rationale, replayed by `inrepo sync` with `git am --3way`
- `check.ts` — behavior parity check that must pass before timing
- `bench.ts` — mitata spawn benchmark; preflights every timed command

## Reproduce

Requires macOS arm64, clang, cmake (for the `--dynamic` build), Node 22.12+,
and bun.

```sh
npm ci                           # clean, registry-backed npm baseline
npx inrepo sync                  # rebuild inrepo_modules from lock + patch series
npm run build                    # build npm/dynamic and vendored/static binaries
npm run check                    # prove output and exit-code parity first
npm run bench
```

The npm baseline and vendored tree are deliberately separate: `package.json`
pins registry releases for `node_modules`, while `inrepo.lock.json` pins the
matching upstream source commits for `inrepo_modules`. This prevents an npm
install from silently linking the baseline back to the patched vendored tree.

The repository CI also runs a platform-neutral reproduction check from the
repository root:

```sh
bun run test:scriptc-example
```

It first checks that the example can be installed from its committed npm
lockfile, then copies the committed example into a temporary directory, runs
the current inrepo CLI's `sync` and `verify` commands, and checks canonical
hashes for the generated commander and picocolors trees. The native scriptc
compilation and benchmark remain manual because they require macOS arm64 and
benchmark timing is not a stable CI assertion.
