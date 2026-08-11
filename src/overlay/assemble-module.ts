import { finalizeVendorCheckout } from '../git/finalize-vendor-checkout.js';
import { applySeries } from '../series/apply-series.js';
import { readSeries } from '../series/read-series.js';
import { applyOverlay } from './apply-overlay.js';
import { readDeletionsFile } from './deletions-file.js';
import { overlayDeletionsPath, overlayDirPath, seriesDirPath } from './overlay-paths.js';

export type PatchedTreeOptions = {
  cwd: string;
  name: string;
  pristineRoot: string;
  targetRoot: string;
};

/** Apply the legacy whole-file overlay (snapshot files plus `.inrepo-deletions`). */
export async function applyLegacyOverlayTree(opts: PatchedTreeOptions): Promise<string> {
  const overlayRoot = overlayDirPath(opts.cwd, opts.name);
  const deletions = await readDeletionsFile(overlayDeletionsPath(opts.cwd, opts.name));
  await applyOverlay({
    pristineRoot: opts.pristineRoot,
    overlayRoot,
    deletions,
    targetRoot: opts.targetRoot,
  });
  return opts.targetRoot;
}

/**
 * Build the patched tree stage (upstream tree + committed changes).
 *
 * Packages with `inrepo_patches/<name>/series/` use the ordered git patch
 * series; everything else keeps using the legacy whole-file overlay.
 */
export async function assemblePatchedTree(opts: PatchedTreeOptions): Promise<string> {
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
}

/** Patched tree plus the generated vendor marker written into `inrepo_modules/`. */
export async function assembleModuleTree(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  commit: string;
  gitUrl: string;
  targetRoot: string;
}): Promise<string> {
  await assemblePatchedTree({
    cwd: opts.cwd,
    name: opts.name,
    pristineRoot: opts.pristineRoot,
    targetRoot: opts.targetRoot,
  });
  await finalizeVendorCheckout(opts.targetRoot, {
    commit: opts.commit,
    gitUrl: opts.gitUrl,
  });
  return opts.targetRoot;
}
