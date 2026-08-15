import { finalizeVendorCheckout } from "../git/finalize-vendor-checkout.js";
import { loadRewirePlan } from "../rewire/load-rewire-plan.js";
import { rewireTree } from "../rewire/rewire-tree.js";
import type { RewirePlan, RewireReport } from "../rewire/rewire-tree.js";
import { applySeries } from "../series/apply-series.js";
import { readSeries } from "../series/read-series.js";
import { applyOverlay } from "./apply-overlay.js";
import { readDeletionsFile } from "./deletions-file.js";
import {
  overlayDeletionsPath,
  overlayDirPath,
  seriesDirPath,
} from "./overlay-paths.js";

export interface PatchedTreeOptions {
  cwd: string;
  name: string;
  pristineRoot: string;
  targetRoot: string;
}

/** Apply the legacy whole-file overlay (snapshot files plus `.inrepo-deletions`). */
export const applyLegacyOverlayTree = async function applyLegacyOverlayTree(
  opts: PatchedTreeOptions
): Promise<string> {
  const overlayRoot = overlayDirPath(opts.cwd, opts.name);
  const deletions = await readDeletionsFile(
    overlayDeletionsPath(opts.cwd, opts.name)
  );
  await applyOverlay({
    deletions,
    overlayRoot,
    pristineRoot: opts.pristineRoot,
    targetRoot: opts.targetRoot,
  });
  return opts.targetRoot;
};

/**
 * Build the patched tree stage (upstream tree + committed changes).
 *
 * Packages with `inrepo_patches/<name>/series/` use the ordered git patch
 * series; everything else keeps using the legacy whole-file overlay.
 */
export const assemblePatchedTree = async function assemblePatchedTree(
  opts: PatchedTreeOptions
): Promise<string> {
  const seriesDir = seriesDirPath(opts.cwd, opts.name);
  const patches = await readSeries(seriesDir);
  if (patches.length > 0) {
    await applySeries({
      pristineRoot: opts.pristineRoot,
      seriesDir,
      targetRoot: opts.targetRoot,
    });
    return opts.targetRoot;
  }
  return applyLegacyOverlayTree(opts);
};

/**
 * Patched tree plus the generated transforms: import rewiring, when the package
 * opted into it, and the vendor marker written into `inrepo_modules/`.
 *
 * Everything added here belongs to the generated stage only. It must never
 * reach `inrepo diff`, which renders the patched tree, nor a captured patch,
 * which is expressed against it.
 */
export const assembleModuleTree = async function assembleModuleTree(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  commit: string;
  gitUrl: string;
  repositoryDirectory?: string | null;
  targetRoot: string;
  /** Pass `null` to skip rewiring; omit to resolve the plan from committed state. */
  rewire?: RewirePlan | null;
  onRewire?: (report: RewireReport) => void;
}): Promise<string> {
  await assemblePatchedTree({
    cwd: opts.cwd,
    name: opts.name,
    pristineRoot: opts.pristineRoot,
    targetRoot: opts.targetRoot,
  });
  const plan =
    opts.rewire === undefined
      ? await loadRewirePlan(opts.cwd, opts.name)
      : opts.rewire;
  if (plan != null) {
    const report = await rewireTree(opts.targetRoot, plan);
    opts.onRewire?.(report);
  }
  await finalizeVendorCheckout(opts.targetRoot, {
    commit: opts.commit,
    gitUrl: opts.gitUrl,
    repositoryDirectory: opts.repositoryDirectory,
  });
  return opts.targetRoot;
};
