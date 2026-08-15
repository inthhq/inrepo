import { mkdir, rm } from "node:fs/promises";
import nodePath from "node:path";

import {
  assertPatchedSymlinksWithinRoot,
  copyTree,
} from "../overlay/tree-utils.js";
import { readSeries } from "./read-series.js";
import type { SeriesPatch } from "./read-series.js";
import { initSeriesBaseRepo, runSeriesGit, skipGitDir } from "./series-git.js";

const abortInFlightApply = async function abortInFlightApply(
  root: string
): Promise<void> {
  try {
    await runSeriesGit(["am", "--abort"], { cwd: root });
  } catch {
    // The abort is best-effort cleanup; the original failure is what matters.
  }
};

/**
 * Apply patch files onto the current `HEAD` of a scratch repository, in order,
 * leaving one commit per patch.
 *
 * `git am --3way` keeps the recorded author, date, and subject, so the commits
 * carry the same provenance as the patch files that produced them.
 */
export const applySeriesToRepo = async function applySeriesToRepo(
  repoRoot: string,
  patches: SeriesPatch[],
  opts: { onPatch?: (patch: SeriesPatch) => void } = {}
): Promise<void> {
  for (const patch of patches) {
    opts.onPatch?.(patch);
    try {
      // --keep-cr: the mailbox splitter strips a trailing CR by default, which
      // would silently rewrite CRLF content.
      await runSeriesGit(
        ["am", "--3way", "--keep-cr", "--no-verify", patch.path],
        {
          cwd: repoRoot,
        }
      );
    } catch (error) {
      await abortInFlightApply(repoRoot);
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to apply ${patch.fileName}: ${err.message}`, {
        cause: error,
      });
    }
  }
};

/**
 * Rebuild the patched tree for a package: copy the pinned upstream checkout
 * into `targetRoot`, then apply every patch in the series with
 * `git am --3way` in filename order.
 *
 * The result is a plain directory (no `.git`), which is the "patched tree"
 * stage: upstream tree -> patched tree -> generated module.
 */
export const applySeries = async function applySeries(opts: {
  pristineRoot: string;
  seriesDir: string;
  targetRoot: string;
}): Promise<{ applied: SeriesPatch[] }> {
  const patches = await readSeries(opts.seriesDir);
  if (patches.length === 0) {
    throw new Error(`No patches found in ${opts.seriesDir}`);
  }

  await rm(opts.targetRoot, { force: true, recursive: true });
  await mkdir(opts.targetRoot, { recursive: true });
  await copyTree(opts.pristineRoot, opts.targetRoot, {
    skip: skipGitDir,
    treatMissingAsEmpty: true,
  });
  await initSeriesBaseRepo(opts.targetRoot);

  await applySeriesToRepo(opts.targetRoot, patches);

  await rm(nodePath.join(opts.targetRoot, ".git"), {
    force: true,
    recursive: true,
  });
  await assertPatchedSymlinksWithinRoot(opts.pristineRoot, opts.targetRoot);

  return { applied: patches };
};
