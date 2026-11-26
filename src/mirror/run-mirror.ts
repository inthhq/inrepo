import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { runGitCapture } from "../git/run-git-capture.js";
import { runGitInput } from "../git/run-git-input.js";
import { runGit } from "../git/run-git.js";
import type { InrepoMirror } from "../types/inrepo-mirror.js";
import { selectMirrorPaths } from "./select-mirror-paths.js";

/** Trailer on every mirror commit naming the source commit it was built from. */
export const MIRROR_SOURCE_TRAILER = "Inrepo-Mirror-Source";

export interface MirrorOptions {
  /** Source revision to publish. Defaults to `HEAD`. */
  ref: string;
  /** Build and report the commit without pushing it. */
  dryRun: boolean;
  /** Publish even if the target has changes inrepo did not make, or is ahead of `ref`. */
  overwrite: boolean;
  /** Subject line for the mirror commit. */
  message?: string;
}

export interface MirrorChange {
  status: string;
  path: string;
}

export interface MirrorResult {
  sourceCommit: string;
  includedCount: number;
  excludedCount: number;
  /** Target branch tip before this run, or null when the branch is new. */
  previousTip: string | null;
  /** True when the target already holds exactly this content. */
  upToDate: boolean;
  /** Mirror commit built by this run; null when up to date. */
  commit: string | null;
  /** True when the commit was pushed (false on a dry run). */
  pushed: boolean;
  changes: MirrorChange[];
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

const short = (sha: string): string => sha.slice(0, 7);

const tryCapture = async function tryCapture(
  args: string[],
  cwd: string
): Promise<string | null> {
  try {
    return await runGitCapture(args, { cwd });
  } catch {
    return null;
  }
};

const resolveSourceTree = async function resolveSourceTree(
  cwd: string,
  mirror: InrepoMirror,
  ref: string
): Promise<{ sourceCommit: string; tree: string }> {
  const prefix = await tryCapture(["rev-parse", "--show-prefix"], cwd);
  if (prefix == null) {
    throw new Error("inrepo mirror must run inside a git repository");
  }
  const sourceCommit = await tryCapture(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd
  );
  if (sourceCommit == null) {
    throw new Error(`Cannot resolve ${JSON.stringify(ref)} to a commit`);
  }
  const relDir = nodePath.posix.join(prefix, mirror.directory ?? "");
  const spec =
    relDir === "." || relDir === ""
      ? `${sourceCommit}^{tree}`
      : `${sourceCommit}:${relDir.replace(/\/+$/u, "")}`;
  const tree = await tryCapture(["rev-parse", "--verify", spec], cwd);
  const type =
    tree == null ? null : await tryCapture(["cat-file", "-t", tree], cwd);
  if (tree == null || type !== "tree") {
    throw new Error(
      `Mirror "${mirror.name}": directory ${JSON.stringify(mirror.directory ?? ".")} is not a committed directory at ${short(sourceCommit)}`
    );
  }
  return { sourceCommit, tree };
};

const listTree = async function listTree(
  cwd: string,
  tree: string
): Promise<TreeEntry[]> {
  const raw = await runGitCapture(["ls-tree", "-r", "-z", tree], {
    cwd,
    trim: false,
  });
  const entries: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (!record) {
      continue;
    }
    const tab = record.indexOf("\t");
    const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
    entries.push({ mode, oid, path: record.slice(tab + 1), type });
  }
  return entries;
};

/** Build a scratch repository that borrows the host's objects via alternates. */
const makeScratchRepo = async function makeScratchRepo(
  cwd: string
): Promise<string> {
  const objects = await runGitCapture(["rev-parse", "--git-path", "objects"], {
    cwd,
  });
  const scratch = await mkdtemp(nodePath.join(tmpdir(), "inrepo-mirror-"));
  await runGit(["init", "-q", scratch]);
  const infoDir = nodePath.join(scratch, ".git", "objects", "info");
  await mkdir(infoDir, { recursive: true });
  await writeFile(
    nodePath.join(infoDir, "alternates"),
    `${nodePath.resolve(cwd, objects)}\n`,
    "utf-8"
  );
  return scratch;
};

const readTargetTip = async function readTargetTip(
  scratch: string,
  mirror: InrepoMirror
): Promise<string | null> {
  const ref = `refs/heads/${mirror.branch}`;
  const listing = await runGitCapture(["ls-remote", mirror.git, ref], {
    cwd: scratch,
  });
  const line = listing.split("\n").find((l) => l.endsWith(`\t${ref}`));
  if (!line) {
    return null;
  }
  await runGit(["fetch", "-q", "--no-tags", "--depth=1", mirror.git, ref], {
    cwd: scratch,
  });
  return runGitCapture(["rev-parse", "FETCH_HEAD"], { cwd: scratch });
};

const readPreviousSource = async function readPreviousSource(
  scratch: string,
  tip: string
): Promise<string | null> {
  const value = await runGitCapture(
    [
      "log",
      "-1",
      `--format=%(trailers:key=${MIRROR_SOURCE_TRAILER},valueonly)`,
      tip,
    ],
    { cwd: scratch }
  );
  const last = value
    .split("\n")
    .map((l) => l.trim())
    .findLast(Boolean);
  return last ?? null;
};

/** Refuse to publish over target changes inrepo did not make, or roll it back. */
const assertSafeToPublish = async function assertSafeToPublish(
  cwd: string,
  mirror: InrepoMirror,
  tip: string,
  previousSource: string | null,
  sourceCommit: string
): Promise<void> {
  const target = `${mirror.git} (${mirror.branch})`;
  if (previousSource == null) {
    throw new Error(
      `Mirror "${mirror.name}": the tip of ${target}, ${short(tip)}, was not written by inrepo mirror. ` +
        "Port any changes made there into this repository, then rerun with --overwrite to replace them."
    );
  }
  const known = await tryCapture(
    ["cat-file", "-e", `${previousSource}^{commit}`],
    cwd
  );
  if (known == null) {
    throw new Error(
      `Mirror "${mirror.name}": ${target} was last mirrored from ${short(previousSource)}, which this clone does not have. ` +
        "Fetch full history (for example, actions/checkout with fetch-depth: 0) or rerun with --overwrite."
    );
  }
  const ancestor = await tryCapture(
    ["merge-base", "--is-ancestor", previousSource, sourceCommit],
    cwd
  );
  if (ancestor == null) {
    throw new Error(
      `Mirror "${mirror.name}": ${target} was last mirrored from ${short(previousSource)}, which is not an ancestor of ${short(sourceCommit)}. ` +
        "Publishing would roll the mirror back; rerun with --overwrite if that is intended."
    );
  }
};

const readIdentityEnv = async function readIdentityEnv(
  cwd: string
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const name = await tryCapture(["config", "user.name"], cwd);
  const email = await tryCapture(["config", "user.email"], cwd);
  if (name && env.GIT_AUTHOR_NAME == null) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME ??= name;
  }
  if (email && env.GIT_AUTHOR_EMAIL == null) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL ??= email;
  }
  return env;
};

const listChanges = async function listChanges(
  scratch: string,
  fromTree: string | null,
  toTree: string
): Promise<MirrorChange[]> {
  // A new branch diffs against the empty tree (object format agnostic).
  const base =
    fromTree ?? (await runGitInput(["mktree"], "", { cwd: scratch }));
  const raw = await runGitCapture(
    ["diff-tree", "-r", "-z", "--name-status", base, toTree],
    { cwd: scratch, trim: false }
  );
  const fields = raw.split("\0").filter(Boolean);
  const changes: MirrorChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changes.push({ path: fields[i + 1] ?? "", status: fields[i] ?? "" });
  }
  return changes;
};

/**
 * Publish a filtered snapshot of `mirror.directory` at `opts.ref` to the
 * mirror's target branch as one fast-forward commit. Never force-pushes.
 */
export const runMirror = async function runMirror(
  cwd: string,
  mirror: InrepoMirror,
  opts: MirrorOptions
): Promise<MirrorResult> {
  const { sourceCommit, tree } = await resolveSourceTree(cwd, mirror, opts.ref);
  const entries = await listTree(cwd, tree);
  const selection = selectMirrorPaths(
    entries.map((e) => e.path),
    mirror.keep,
    mirror.exclude
  );
  if (selection.included.length === 0) {
    throw new Error(
      `Mirror "${mirror.name}" would publish no files; check its keep and exclude lists`
    );
  }
  const included = new Set(selection.included);

  const scratch = await makeScratchRepo(cwd);
  try {
    const indexInfo = entries
      .filter((e) => included.has(e.path))
      .map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}\0`)
      .join("");
    await runGitInput(["update-index", "-z", "--index-info"], indexInfo, {
      cwd: scratch,
    });
    const newTree = await runGitCapture(["write-tree"], { cwd: scratch });

    const tip = await readTargetTip(scratch, mirror);
    const tipTree =
      tip == null
        ? null
        : await runGitCapture(["rev-parse", `${tip}^{tree}`], {
            cwd: scratch,
          });
    const base = {
      excludedCount: selection.excluded.length,
      includedCount: selection.included.length,
      previousTip: tip,
      sourceCommit,
    };
    if (tipTree === newTree) {
      return {
        ...base,
        changes: [],
        commit: null,
        pushed: false,
        upToDate: true,
      };
    }
    if (tip != null && !opts.overwrite) {
      const previousSource = await readPreviousSource(scratch, tip);
      await assertSafeToPublish(cwd, mirror, tip, previousSource, sourceCommit);
    }

    const changes = await listChanges(scratch, tipTree, newTree);
    const subject = opts.message ?? `Mirror ${short(sourceCommit)}`;
    const commitArgs = ["commit-tree", newTree];
    if (tip != null) {
      commitArgs.push("-p", tip);
    }
    commitArgs.push(
      "-m",
      subject,
      "-m",
      `${MIRROR_SOURCE_TRAILER}: ${sourceCommit}`
    );
    const commit = await runGitCapture(commitArgs, {
      cwd: scratch,
      env: await readIdentityEnv(cwd),
    });

    if (!opts.dryRun) {
      await runGit(
        ["push", "-q", mirror.git, `${commit}:refs/heads/${mirror.branch}`],
        { cwd: scratch }
      );
    }
    return { ...base, changes, commit, pushed: !opts.dryRun, upToDate: false };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};
