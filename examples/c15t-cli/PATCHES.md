# Narrow static-compiler adaptations

`inrepo sync` selects `packages/cli` at the pinned c15t commit and writes the byte-for-byte upstream file under `vendor/inrepo_modules/@c15t/cli/`. `prepare.ts` verifies its SHA-256, produces two ignored generated variants, and applies these small adaptations to both:

1. Redirect the type-only `~/context/types` import to the benchmark's narrow structural types. This avoids pulling unrelated CLI context services into a renderer-only target.
2. Restate each mixed `Math.max(...values, minimum)` call by collecting the mapped widths, pushing the minimum, and spreading that one array into `Math.max`. scriptc 0.0.26 diagnoses the mixed form as `SC2020`; the replacement has the same result.

The static variant has one additional import-only change: `picocolors` points to `static-color.ts`. The benchmark always runs with `NO_COLOR=1`, and the renderer only calls `cyan`, so that shim implements exactly the reached identity behavior. The dynamic variant retains the upstream bare npm import.
