import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { copyTree, defaultSkipTreePath } from "../overlay/tree-utils.js";
import { applySeriesToRepo } from "./apply-series.js";
import { readSeries, seriesPatchFileName } from "./read-series.js";
import type { SeriesPatch } from "./read-series.js";
import {
  initSeriesBaseRepo,
  replaceWorkTree,
  runSeriesGit,
  runSeriesGitCapture,
  skipGitDir,
  stageAll,
  trySeriesGit,
  SERIES_BASE_BRANCH,
} from "./series-git.js";
import type { SeriesAuthor } from "./series-git.js";

/** Branch holding the new upstream pin inside an update scratch repository. */
export const SERIES_TARGET_BRANCH = "inrepo-new-upstream";

/** One patch of a successfully rebased series, ready to be written to disk. */
export interface RebasedPatch {
  /** Position in the rebased series, 1-based; also the `NNNN-` prefix. */
  number: number;
  subject: string;
  fileName: string;
  content: Buffer;
}

export type SeriesRebaseResult =
  | { status: "rebased"; patches: RebasedPatch[] }
  | {
      status: "conflict";
      /** 1-based position of the patch the rebase stopped on. */
      number: number;
      subject: string;
      /** Paths in the scratch work tree that carry conflict markers. */
      files: string[];
    };

const updateSkip = function updateSkip(relPosix: string): boolean {
  return skipGitDir(relPosix) || defaultSkipTreePath(relPosix);
};

/** True while git has a rebase parked in the scratch repository. */
export const rebaseInProgress = function rebaseInProgress(
  repoRoot: string
): boolean {
  return (
    existsSync(nodePath.join(repoRoot, ".git", "rebase-merge")) ||
    existsSync(nodePath.join(repoRoot, ".git", "rebase-apply"))
  );
};

const conflictedFiles = async function conflictedFiles(
  repoRoot: string
): Promise<string[]> {
  const raw = await runSeriesGitCapture(
    ["diff", "--name-only", "--diff-filter=U"],
    {
      cwd: repoRoot,
    }
  );
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
};

/** True when a work-tree file still carries leftover git conflict markers. */
const hasConflictMarkers = function hasConflictMarkers(text: string): boolean {
  return text.includes("<<<<<<<") || text.includes(">>>>>>>");
};

/**
 * Unmerged paths whose work-tree contents still have conflict markers.
 *
 * Git keeps a path unmerged until it is staged, so `conflictedFiles()` alone
 * cannot tell a resolved edit from an untouched conflict. Staging first would
 * mark the markers resolved, which is the bug this check prevents.
 */
const unresolvedConflictedFiles = async function unresolvedConflictedFiles(
  repoRoot: string
): Promise<string[]> {
  const leftover: string[] = [];
  for (const file of await conflictedFiles(repoRoot)) {
    const abs = nodePath.join(repoRoot, file);
    if (!existsSync(abs)) {
      continue;
    }
    if (hasConflictMarkers(await readFile(abs, "utf-8"))) {
      leftover.push(file);
    }
  }
  return leftover;
};

/** Subject of the patch git is currently stuck on. */
const stoppedSubject = async function stoppedSubject(
  repoRoot: string
): Promise<string> {
  try {
    return await runSeriesGitCapture(
      ["log", "-1", "--format=%s", "REBASE_HEAD"],
      {
        cwd: repoRoot,
      }
    );
  } catch {
    const messagePath = nodePath.join(
      repoRoot,
      ".git",
      "rebase-merge",
      "message"
    );
    if (!existsSync(messagePath)) {
      return "(unknown patch)";
    }
    return (
      (await (await readFile(messagePath, "utf-8")).split("\n")[0].trim()) ||
      "(unknown patch)"
    );
  }
};

const commitCount = async function commitCount(
  repoRoot: string,
  range: string
): Promise<number> {
  const raw = await runSeriesGitCapture(["rev-list", "--count", range], {
    cwd: repoRoot,
  });
  const parsed = Math.trunc(Number(raw));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const conflictResult = async function conflictResult(
  repoRoot: string,
  newBase: string
): Promise<SeriesRebaseResult> {
  return {
    files: await conflictedFiles(repoRoot),
    number: (await commitCount(repoRoot, `${newBase}..HEAD`)) + 1,
    status: "conflict",
    subject: await stoppedSubject(repoRoot),
  };
};

/**
 * Regenerate the series from the commits that now sit on top of the new
 * upstream base. `git format-patch` renumbers them from 0001 and carries each
 * commit's original author, date, and subject into the new file.
 */
const collectRebasedPatches = async function collectRebasedPatches(
  repoRoot: string,
  newBase: string
): Promise<RebasedPatch[]> {
  const out = await mkdtemp(nodePath.join(tmpdir(), "inrepo-rebase-out-"));
  try {
    const range = `${newBase}..HEAD`;
    await runSeriesGit(
      [
        "format-patch",
        "--binary",
        "--full-index",
        "--no-signature",
        "--no-numbered",
        "--start-number",
        "1",
        "-o",
        out,
        range,
      ],
      { cwd: repoRoot }
    );

    const produced = await (
      await readdir(out)
    )
      .filter((name) => name.endsWith(".patch"))
      .toSorted();
    // `<sha>\t<subject>` keeps one line per commit even when a subject is
    // empty, which a hand-written patch file is allowed to be.
    const subjectLines = await runSeriesGitCapture(
      ["log", "--reverse", "--format=%H%x09%s", range],
      { cwd: repoRoot, trim: false }
    );
    const subjects = subjectLines
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(line.indexOf("\t") + 1));
    if (subjects.length !== produced.length) {
      throw new Error(
        `Expected ${subjects.length} patch file(s) from git format-patch, got ${produced.length}`
      );
    }

    const patches: RebasedPatch[] = [];
    for (let i = 0; i < produced.length; i += 1) {
      patches.push({
        content: await readFile(nodePath.join(out, produced[i])),
        fileName: seriesPatchFileName(produced[i], i + 1),
        number: i + 1,
        subject: subjects[i],
      });
    }
    return patches;
  } finally {
    await rm(out, { force: true, recursive: true });
  }
};

/**
 * Run one rebase command and translate its outcome: a stopped rebase is a
 * conflict to report, anything else is a real failure.
 */
const runRebaseStep = async function runRebaseStep(
  repoRoot: string,
  args: string[],
  newBase: string,
  author?: SeriesAuthor
): Promise<SeriesRebaseResult> {
  try {
    await runSeriesGit(args, { author, cwd: repoRoot });
  } catch (error) {
    if (!rebaseInProgress(repoRoot)) {
      throw error;
    }
    return conflictResult(repoRoot, newBase);
  }
  if (rebaseInProgress(repoRoot)) {
    return conflictResult(repoRoot, newBase);
  }
  return {
    patches: await collectRebasedPatches(repoRoot, newBase),
    status: "rebased",
  };
};

/**
 * Start rebasing a package's committed patch series onto a newer upstream
 * commit.
 *
 * The scratch repository gets the old pin as its base commit, the existing
 * series applied on top of it as one commit per patch, and a sibling commit
 * carrying the new pin. `git rebase --onto` then replays the patch commits onto
 * the new pin, which is what produces ordinary git conflict markers when
 * upstream and a patch touch the same lines.
 *
 * `resolveNewRoot` is called only after the old upstream tree has been copied
 * into the scratch repository, so both trees may be the same cache directory.
 */
export const startSeriesRebase = async function startSeriesRebase(opts: {
  repoRoot: string;
  seriesDir: string;
  /** Upstream tree at the currently pinned commit. */
  oldRoot: string;
  /** Materializes the upstream tree at the new commit and returns its root. */
  resolveNewRoot: () => Promise<string>;
  author?: SeriesAuthor;
  /** Called as each existing patch is replayed onto the old pin. */
  onPatch?: (patch: SeriesPatch) => void;
}): Promise<{ newBase: string; result: SeriesRebaseResult }> {
  const patches = await readSeries(opts.seriesDir);
  if (patches.length === 0) {
    throw new Error(`No patches found in ${opts.seriesDir}`);
  }

  const repo = opts.repoRoot;
  await rm(repo, { force: true, recursive: true });
  await mkdir(repo, { recursive: true });
  await copyTree(opts.oldRoot, repo, {
    skip: updateSkip,
    treatMissingAsEmpty: true,
  });
  await initSeriesBaseRepo(repo);
  const oldBase = await runSeriesGitCapture(["rev-parse", "HEAD"], {
    cwd: repo,
  });

  try {
    await applySeriesToRepo(repo, patches, { onPatch: opts.onPatch });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `The committed series does not apply to the pinned commit, so there is nothing to rebase: ${err.message}`,
      { cause: error }
    );
  }

  const newRoot = await opts.resolveNewRoot();
  await runSeriesGit(
    ["checkout", "--quiet", "-b", SERIES_TARGET_BRANCH, oldBase],
    { cwd: repo }
  );
  await replaceWorkTree(repo, newRoot, { skip: updateSkip });
  await stageAll(repo);
  await runSeriesGit(
    [
      "commit",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "-m",
      "inrepo upstream update",
    ],
    { author: opts.author, cwd: repo }
  );
  const newBase = await runSeriesGitCapture(["rev-parse", "HEAD"], {
    cwd: repo,
  });

  const result = await runRebaseStep(
    repo,
    ["rebase", "--onto", SERIES_TARGET_BRANCH, oldBase, SERIES_BASE_BRANCH],
    newBase,
    opts.author
  );
  return { newBase, result };
};

/**
 * Resume a rebase the user has resolved by hand. Conflicted files that still
 * carry `<<<<<<<` / `>>>>>>>` markers are refused so `--continue` cannot stage
 * them as a resolution. Everything else in the scratch work tree is staged, so
 * resolving a conflict is just editing files. A resolution that leaves the
 * patch with no effect skips it, mirroring what git asks for when `--continue`
 * finds nothing to commit.
 */
export const continueSeriesRebase = async function continueSeriesRebase(opts: {
  repoRoot: string;
  newBase: string;
  author?: SeriesAuthor;
}): Promise<SeriesRebaseResult> {
  const repo = opts.repoRoot;
  if (!rebaseInProgress(repo)) {
    // The rebase already finished (for example a previous --continue crashed
    // after git committed); regenerating from the range is still correct.
    return {
      patches: await collectRebasedPatches(repo, opts.newBase),
      status: "rebased",
    };
  }

  const unresolved = await unresolvedConflictedFiles(repo);
  if (unresolved.length > 0) {
    throw new Error(
      [
        "Cannot continue the rebase: unresolved conflicts remain:",
        ...unresolved.map((file) => `  ${file}`),
        "Resolve every listed file, then run --continue again.",
      ].join("\n")
    );
  }

  await stageAll(repo);
  const patchIsEmpty = await trySeriesGit(["diff", "--cached", "--quiet"], {
    cwd: repo,
  });
  const args = patchIsEmpty ? ["rebase", "--skip"] : ["rebase", "--continue"];
  return runRebaseStep(repo, args, opts.newBase, opts.author);
};

/**
 * Replace a package's committed series with the rebased one. Called only once
 * the rebase has finished, so the committed patch files change exactly once per
 * successful update. An empty result removes the series directory, because a
 * package whose patches all became redundant no longer has any.
 *
 * Patches are written to a sibling directory and renamed into place so a crash
 * mid-write cannot leave an empty `series/` behind. Callers that snapshot the
 * previous series can restore it if a later step fails.
 */
export const writeRebasedSeries = async function writeRebasedSeries(
  seriesDir: string,
  patches: RebasedPatch[]
): Promise<void> {
  const parent = nodePath.dirname(seriesDir);
  await mkdir(parent, { recursive: true });

  if (patches.length === 0) {
    await rm(seriesDir, { force: true, recursive: true });
    return;
  }

  const staging = await mkdtemp(nodePath.join(parent, ".series-next-"));
  try {
    for (const patch of patches) {
      await writeFile(nodePath.join(staging, patch.fileName), patch.content);
    }

    const previous = existsSync(seriesDir) ? `${staging}.prev` : null;
    if (previous) {
      await rename(seriesDir, previous);
    }
    try {
      await rename(staging, seriesDir);
    } catch (error) {
      if (previous && existsSync(previous) && !existsSync(seriesDir)) {
        await rename(previous, seriesDir);
      }
      throw error;
    }
    if (previous) {
      await rm(previous, { force: true, recursive: true });
    }
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
};
