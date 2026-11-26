import { mkdir, rm } from "node:fs/promises";
import nodePath from "node:path";

import { InrepoError } from "../cli/errors.js";
import type { JsonObject } from "../json/unknown.js";
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

const patchApplyFailed = function patchApplyFailed(
  error: Error,
  patch: SeriesPatch,
  name: string | undefined
): InrepoError {
  const details: JsonObject = { file: patch.path, patch: patch.fileName };
  if (name !== undefined) {
    details.package = name;
  }
  const update =
    name === undefined
      ? ""
      : ` To move the series onto a newer upstream commit, run: inrepo update ${name}`;
  return new InrepoError(
    "PATCH_APPLY_FAILED",
    `Failed to apply ${patch.fileName}: ${error.message}`,
    {
      cause: error,
      details,
      hint: `${patch.fileName} does not apply to the pinned upstream tree. Fix or remove ${patch.path}, then rerun.${update}`,
    }
  );
};

/**
 * Apply patch files onto the current `HEAD` of a scratch repository, in order,
 * leaving one commit per patch.
 *
 * `git am --3way` keeps the recorded author, date, and subject, so the commits
 * carry the same provenance as the patch files that produced them. A patch
 * that does not apply fails with `PATCH_APPLY_FAILED`.
 */
export const applySeriesToRepo = async function applySeriesToRepo(
  repoRoot: string,
  patches: SeriesPatch[],
  opts: {
    onPatch?: (patch: SeriesPatch) => void;
    /** Package the series belongs to; reported when a patch fails to apply. */
    name?: string;
  } = {}
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
      throw patchApplyFailed(err, patch, opts.name);
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
  /** Package the series belongs to; reported when a patch fails to apply. */
  name?: string;
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

  await applySeriesToRepo(opts.targetRoot, patches, { name: opts.name });

  await rm(nodePath.join(opts.targetRoot, ".git"), {
    force: true,
    recursive: true,
  });
  await assertPatchedSymlinksWithinRoot(opts.pristineRoot, opts.targetRoot);

  return { applied: patches };
};
