import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { copyTree } from "../overlay/tree-utils.js";
import {
  hasStagedChanges,
  initSeriesBaseRepo,
  replaceWorkTree,
  runSeriesGit,
  skipGitDir,
  stageAll,
} from "./series-git.js";
import type { SeriesAuthor } from "./series-git.js";

export interface FormattedSeriesPatch {
  /** File name git chose, e.g. `0002-tighten-jsdoc-types.patch`. */
  fileName: string;
  /** Raw `git format-patch --binary` bytes, ready to write into `series/`. */
  content: Buffer;
}

export interface FormatSeriesPatchOptions {
  baseRoot: string;
  patchedRoot: string;
  subject: string;
  author?: SeriesAuthor;
  /** Number used for the `NNNN-` filename prefix (default 1). */
  startNumber?: number;
  /**
   * Extra paths to leave out of both trees, on top of `.git`. Callers pass this
   * when one side carries generated markers (`.inrepo-vendor.json`) or cache
   * metadata that must not become part of the patch.
   */
  skip?: (relPosix: string) => boolean;
}

/**
 * Produce one `git format-patch --binary` patch describing
 * `baseRoot -> patchedRoot`, or `null` when the two trees are identical as far
 * as git is concerned.
 *
 * Both trees are staged in a throwaway repository, so the patch carries exact
 * hunks, binary literals, deletions, symlinks, and mode changes.
 */
export const tryFormatSeriesPatch = async function tryFormatSeriesPatch(
  opts: FormatSeriesPatchOptions
): Promise<FormattedSeriesPatch | null> {
  const work = await mkdtemp(nodePath.join(tmpdir(), "inrepo-series-format-"));
  const repo = nodePath.join(work, "repo");
  const out = nodePath.join(work, "out");
  const extraSkip = opts.skip;
  const skip = extraSkip
    ? (relPosix: string): boolean => skipGitDir(relPosix) || extraSkip(relPosix)
    : skipGitDir;

  try {
    await copyTree(opts.baseRoot, repo, { skip, treatMissingAsEmpty: true });
    await initSeriesBaseRepo(repo);

    await replaceWorkTree(repo, opts.patchedRoot, { skip });
    await stageAll(repo);
    if (!(await hasStagedChanges(repo))) {
      return null;
    }
    await runSeriesGit(
      [
        "commit",
        "--quiet",
        "--no-verify",
        "--allow-empty-message",
        "-m",
        opts.subject,
      ],
      { author: opts.author, cwd: repo }
    );

    await runSeriesGit(
      [
        "format-patch",
        "--binary",
        "--full-index",
        "--no-signature",
        "--no-numbered",
        "--start-number",
        String(opts.startNumber ?? 1),
        "-o",
        out,
        "-1",
        "HEAD",
      ],
      { author: opts.author, cwd: repo }
    );

    const produced = await (
      await readdir(out)
    )
      .filter((name) => name.endsWith(".patch"))
      .toSorted();
    if (produced.length !== 1) {
      throw new Error(
        `Expected exactly one patch file from git format-patch, got ${produced.length}`
      );
    }

    return {
      content: await readFile(nodePath.join(out, produced[0])),
      fileName: produced[0],
    };
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};

/**
 * {@link tryFormatSeriesPatch} for callers that treat "no differences" as a
 * failure rather than a normal outcome.
 */
export const formatSeriesPatch = async function formatSeriesPatch(
  opts: FormatSeriesPatchOptions
): Promise<FormattedSeriesPatch> {
  const patch = await tryFormatSeriesPatch(opts);
  if (patch == null) {
    throw new Error(
      "No differences between the upstream tree and the patched tree"
    );
  }
  return patch;
};
