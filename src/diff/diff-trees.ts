import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { copyTree, defaultSkipTreePath } from "../overlay/tree-utils.js";
import {
  initSeriesBaseRepo,
  listStagedFileChanges,
  replaceWorkTree,
  runSeriesGitCapture,
  skipGitDir,
  stageAll,
} from "../series/series-git.js";
import type { StagedFileChange } from "../series/series-git.js";

export interface DiffTreesOptions {
  /** Left side of the diff, normally the pinned upstream checkout. */
  baseRoot: string;
  /** Right side of the diff, normally the assembled patched tree. */
  targetRoot: string;
  /** Render a per-file `+/-` summary instead of the full unified diff. */
  stat?: boolean;
}

export interface DiffTreesResult {
  /** Unified diff (or `--stat` summary); empty when the trees are identical. */
  rendered: string;
  /** Per-file change kind and line counts, sorted by path. */
  files: StagedFileChange[];
}

const diffSkip = function diffSkip(relPosix: string): boolean {
  return skipGitDir(relPosix) || defaultSkipTreePath(relPosix);
};

/**
 * Render `baseRoot -> targetRoot` as a unified diff using git itself, plus a
 * per-file summary.
 *
 * Both trees are staged in a throwaway repository so git decides how to present
 * deletions, mode changes, symlinks, and binary files. `rendered` is an empty
 * string when the trees are identical.
 */
export const diffTreesWithFiles = async function diffTreesWithFiles(
  opts: DiffTreesOptions
): Promise<DiffTreesResult> {
  const work = await mkdtemp(nodePath.join(tmpdir(), "inrepo-diff-"));
  const repo = nodePath.join(work, "repo");

  try {
    await copyTree(opts.baseRoot, repo, {
      skip: diffSkip,
      treatMissingAsEmpty: true,
    });
    await initSeriesBaseRepo(repo);
    await replaceWorkTree(repo, opts.targetRoot, { skip: diffSkip });
    await stageAll(repo);

    // `--stat` indents every row by one space, so leading whitespace has to
    // survive; only the trailing newline is dropped.
    const rendered = await runSeriesGitCapture(
      [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        ...(opts.stat === true ? ["--stat"] : []),
      ],
      { cwd: repo, trim: false }
    );
    const files = await listStagedFileChanges(repo);
    return { files, rendered: rendered.replace(/\s+$/u, "") };
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};

/** {@link diffTreesWithFiles}, keeping only the rendered text. */
export const diffTrees = async function diffTrees(
  opts: DiffTreesOptions
): Promise<string> {
  return (await diffTreesWithFiles(opts)).rendered;
};
