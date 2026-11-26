import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";

import { mirrorsFromConfigText } from "../config/load-config.js";
import { runGitCapture } from "../git/run-git-capture.js";
import { runGitBytes, runGitInput } from "../git/run-git-input.js";
import { runGit } from "../git/run-git.js";
import type { InrepoMirror } from "../types/inrepo-mirror.js";
import { resolveTargetUrl } from "./resolve-target-url.js";
import { selectMirrorPaths } from "./select-mirror-paths.js";

/** Scratch remote used for every target operation, so the checked URL is the pushed URL. */
const TARGET_REMOTE = "inrepo-target";

/** Trailer on every mirror commit naming the source commit it was built from. */
export const MIRROR_SOURCE_TRAILER = "Inrepo-Mirror-Source";
/** Trailer on every mirror commit naming the tree inrepo wrote, to detect later edits. */
export const MIRROR_TREE_TRAILER = "Inrepo-Mirror-Tree";

/** Variables that point git at a specific repository, index, or object store. */
const FALLBACK_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

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
  /** False when the path's bytes are not valid UTF-8. */
  validPath: boolean;
}

interface Scratch {
  dir: string;
  env: NodeJS.ProcessEnv;
}

const short = (sha: string): string => sha.slice(0, 7);

/** Hide `user:token@` credentials embedded in URLs. */
export const redactCredentials = function redactCredentials(
  text: string
): string {
  return text.replaceAll(
    /(?<scheme>\b[a-z][\d+.a-z-]*:\/\/)[^\s/]+@/giu,
    "$<scheme>***@"
  );
};

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
  let prefix: string;
  try {
    // Keep path whitespace: strip only git's terminating newline.
    prefix = (
      await runGitCapture(["rev-parse", "--show-prefix"], { cwd, trim: false })
    ).replace(/\n$/u, "");
  } catch {
    throw new Error("inrepo mirror must run inside a git repository");
  }
  const sourceCommit = await tryCapture(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd
  );
  if (sourceCommit == null) {
    throw new Error(`Cannot resolve ${JSON.stringify(ref)} to a commit`);
  }
  const relDir = nodePath.posix
    .join(prefix, mirror.directory ?? "")
    .replace(/\/+$/u, "");
  const spec =
    relDir === "." || relDir === ""
      ? `${sourceCommit}^{tree}`
      : `${sourceCommit}:${relDir}`;
  const tree = await tryCapture(
    ["rev-parse", "--verify", "--end-of-options", spec],
    cwd
  );
  const type =
    tree == null ? null : await tryCapture(["cat-file", "-t", tree], cwd);
  if (tree == null || type !== "tree") {
    throw new Error(
      `Mirror "${mirror.name}": directory ${JSON.stringify(mirror.directory ?? ".")} is not a committed directory at ${short(sourceCommit)}`
    );
  }
  return { sourceCommit, tree };
};

// ignoreBOM: a leading U+FEFF is part of the file name, not an encoding marker.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Every entry under `tree`, read as bytes so non-UTF-8 names are detected. */
const listTree = async function listTree(
  cwd: string,
  tree: string
): Promise<TreeEntry[]> {
  // --full-tree: list `tree` itself, not the subdirectory matching cwd.
  const raw = await runGitBytes(["ls-tree", "-r", "-z", "--full-tree", tree], {
    cwd,
  });
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf(0, start);
    if (end === -1) {
      end = raw.length;
    }
    const record = raw.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(9);
    if (tab === -1) {
      continue;
    }
    const [mode = "", type = "", oid = ""] = record
      .subarray(0, tab)
      .toString("ascii")
      .split(" ");
    const pathBytes = record.subarray(tab + 1);
    let path: string;
    let validPath = true;
    try {
      path = utf8.decode(pathBytes);
    } catch {
      path = lossyUtf8.decode(pathBytes);
      validPath = false;
    }
    entries.push({ mode, oid, path, type, validPath });
  }
  return entries;
};

/** Refuse entries that cannot be published exactly as committed. */
const assertPublishable = function assertPublishable(
  mirror: InrepoMirror,
  entries: TreeEntry[]
): void {
  const invalid = entries.filter((e) => !e.validPath).map((e) => e.path);
  if (invalid.length > 0) {
    throw new Error(
      `Mirror "${mirror.name}": these paths are not valid UTF-8, so they cannot be filtered safely; rename them or exclude a parent directory: ${invalid.join(", ")}`
    );
  }
  const gitlinks = entries
    .filter((e) => e.type === "commit")
    .map((e) => e.path);
  if (gitlinks.length > 0) {
    throw new Error(
      `Mirror "${mirror.name}": submodules cannot be mirrored (their .gitmodules entry stays behind); exclude them: ${gitlinks.join(", ")}`
    );
  }
};

/** Git environment for the scratch repository, isolated from the caller's repository variables. */
const isolatedEnv = async function isolatedEnv(
  dir: string
): Promise<NodeJS.ProcessEnv> {
  const listed = await runGitCapture(["rev-parse", "--local-env-vars"], {
    cwd: dir,
  }).catch(() => "");
  const strip = new Set([...FALLBACK_LOCAL_ENV_VARS, ...listed.split("\n")]);
  // GIT_CONFIG_* carry settings (credentials, transport policy), not repository locations.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.startsWith("GIT_CONFIG") || !strip.has(name)
    )
  );
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
};

/** Build a scratch repository that borrows the host's objects via alternates. */
const initScratchRepo = async function initScratchRepo(
  cwd: string,
  dir: string
): Promise<Scratch> {
  const objects = await runGitCapture(["rev-parse", "--git-path", "objects"], {
    cwd,
  });
  const objectFormat = await runGitCapture(
    ["rev-parse", "--show-object-format"],
    { cwd }
  );
  const baseEnv = await isolatedEnv(dir);
  await runGit(["init", "-q", `--object-format=${objectFormat}`, dir], {
    env: baseEnv,
  });
  const gitDir = nodePath.join(dir, ".git");
  await writeFile(
    nodePath.join(gitDir, "objects", "info", "alternates"),
    `${nodePath.resolve(cwd, objects)}\n`,
    "utf-8"
  );
  return {
    dir,
    env: {
      ...baseEnv,
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: nodePath.join(gitDir, "index"),
    },
  };
};

const scratchCapture = function scratchCapture(
  scratch: Scratch,
  args: string[],
  trim = true
): Promise<string> {
  return runGitCapture(args, { cwd: scratch.dir, env: scratch.env, trim });
};

/**
 * Add the target as a scratch remote and use it for every target operation.
 * `url.*.pushInsteadOf` or a pushurl in global config could otherwise send
 * the push somewhere other than the repository inrepo fetched and checked.
 */
const addTargetRemote = async function addTargetRemote(
  scratch: Scratch,
  url: string
): Promise<void> {
  await runGit(["remote", "add", TARGET_REMOTE, url], {
    cwd: scratch.dir,
    env: scratch.env,
  });
  const urls = async (push: boolean): Promise<string[]> =>
    (
      await scratchCapture(
        scratch,
        [
          "remote",
          "get-url",
          "--all",
          ...(push ? ["--push"] : []),
          TARGET_REMOTE,
        ],
        false
      )
    )
      .split("\n")
      .filter(Boolean);
  const fetchUrls = await urls(false);
  const pushUrls = await urls(true);
  const [fetchUrl = ""] = fetchUrls;
  const [pushUrl = ""] = pushUrls;
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrl !== pushUrl) {
    throw new Error(
      `git resolves the mirror target to different repositories for fetch (${fetchUrls.join(", ")}) and push (${pushUrls.join(", ")}), ` +
        "so inrepo cannot check the repository it would publish to. Remove the url.*.pushInsteadOf rule or point the mirror at the push URL."
    );
  }
};

const readTargetTip = async function readTargetTip(
  scratch: Scratch,
  ref: string
): Promise<string | null> {
  const listing = await scratchCapture(scratch, [
    "ls-remote",
    TARGET_REMOTE,
    ref,
  ]);
  const line = listing.split("\n").find((l) => l.endsWith(`\t${ref}`));
  if (!line) {
    return null;
  }
  // Send no "have" lines: the borrowed host objects would otherwise advertise
  // private commit IDs to the target during negotiation.
  await runGit(
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "-c",
      "core.alternateRefsCommand=true",
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      TARGET_REMOTE,
      ref,
    ],
    {
      cwd: scratch.dir,
      env: scratch.env,
    }
  );
  return scratchCapture(scratch, ["rev-parse", "FETCH_HEAD"]);
};

/** The trailers inrepo wrote on `tip`, or empty values when it has none. */
const readMirrorTrailers = async function readMirrorTrailers(
  scratch: Scratch,
  tip: string
): Promise<{ source: string | null; tree: string | null }> {
  const raw = await scratchCapture(scratch, [
    "log",
    "-1",
    "--format=%(trailers:only,unfold)",
    tip,
  ]);
  let source: string | null = null;
  let tree: string | null = null;
  for (const line of raw.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === MIRROR_SOURCE_TRAILER) {
      source = value;
    } else if (key === MIRROR_TREE_TRAILER) {
      tree = value;
    }
  }
  return { source, tree };
};

/** Refuse to publish over target changes inrepo did not make, or to roll it back. */
const assertSafeToPublish = async function assertSafeToPublish(
  cwd: string,
  scratch: Scratch,
  mirror: InrepoMirror,
  tip: string,
  tipTree: string,
  sourceCommit: string
): Promise<void> {
  const target = `${mirror.git} (${mirror.branch})`;
  const trailers = await readMirrorTrailers(scratch, tip);
  const oid = new RegExp(`^[0-9a-f]{${sourceCommit.length}}$`, "u");
  const previousSource =
    trailers.source != null && oid.test(trailers.source)
      ? trailers.source
      : null;
  if (previousSource == null || trailers.tree !== tipTree) {
    throw new Error(
      `Mirror "${mirror.name}": the tip of ${target}, ${short(tip)}, was not written by inrepo mirror, or was changed after it was. ` +
        "Port any changes made there into this repository, then rerun with --overwrite to replace them."
    );
  }
  const known = await tryCapture(
    ["cat-file", "-e", "--end-of-options", `${previousSource}^{commit}`],
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
    const shallow = await tryCapture(
      ["rev-parse", "--is-shallow-repository"],
      cwd
    );
    if (shallow === "true") {
      throw new Error(
        `Mirror "${mirror.name}": this clone is shallow, so inrepo cannot check that ${short(sourceCommit)} descends from ${short(previousSource)}, the last mirrored commit. ` +
          "Fetch full history (for example, actions/checkout with fetch-depth: 0) or rerun with --overwrite."
      );
    }
    throw new Error(
      `Mirror "${mirror.name}": ${target} was last mirrored from ${short(previousSource)}, which is not an ancestor of ${short(sourceCommit)}. ` +
        "Publishing would roll the mirror back; rerun with --overwrite if that is intended."
    );
  }
};

/**
 * Commit identity: GIT_AUTHOR_* / GIT_COMMITTER_* when set, else this
 * repository's user.name / user.email. Never git's guessed OS identity.
 */
const commitEnv = async function commitEnv(
  cwd: string,
  scratch: Scratch
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...scratch.env };
  const name = await tryCapture(["config", "user.name"], cwd);
  const email = await tryCapture(["config", "user.email"], cwd);
  // Each role falls back to user.* on its own; neither copies the other's override.
  if (name) {
    env.GIT_AUTHOR_NAME ||= name;
    env.GIT_COMMITTER_NAME ||= name;
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL ||= email;
    env.GIT_COMMITTER_EMAIL ||= email;
  }
  return env;
};

const listChanges = async function listChanges(
  scratch: Scratch,
  fromTree: string | null,
  toTree: string
): Promise<MirrorChange[]> {
  // A new branch diffs against the empty tree (object format agnostic).
  const base =
    fromTree ??
    (await runGitInput(["mktree"], "", {
      cwd: scratch.dir,
      env: scratch.env,
    }));
  const raw = await scratchCapture(
    scratch,
    ["diff-tree", "-r", "-z", "--name-status", base, toTree],
    false
  );
  const fields = raw.split("\0").filter(Boolean);
  const changes: MirrorChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changes.push({ path: fields[i + 1] ?? "", status: fields[i] ?? "" });
  }
  return changes;
};

/** Build the filtered tree in the scratch index and check it holds exactly `included`. */
const writeFilteredTree = async function writeFilteredTree(
  scratch: Scratch,
  entries: TreeEntry[],
  included: Set<string>
): Promise<string> {
  const selected = entries.filter((e) => included.has(e.path));
  const indexInfo = selected
    .map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}\0`)
    .join("");
  await runGitInput(["update-index", "-z", "--index-info"], indexInfo, {
    cwd: scratch.dir,
    env: scratch.env,
  });
  const tree = await scratchCapture(scratch, ["write-tree"]);
  // Compare mode, type, object ID, and exact path bytes of every written entry.
  const expected = new Set(
    selected.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`)
  );
  const written = (
    await runGitBytes(["ls-tree", "-r", "-z", "--full-tree", tree], {
      cwd: scratch.dir,
      env: scratch.env,
    })
  )
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
  if (
    written.length !== expected.size ||
    written.some((record) => !expected.has(record))
  ) {
    throw new Error(
      "inrepo mirror built a tree that does not match the selected files; nothing was pushed"
    );
  }
  return tree;
};

interface MirrorSource {
  sourceCommit: string;
  entries: TreeEntry[];
  included: Set<string>;
  excludedCount: number;
}

/** The mirrors declared by the config the source commit itself would load. */
const readCommittedMirrors = async function readCommittedMirrors(
  cwd: string,
  sourceCommit: string
): Promise<InrepoMirror[]> {
  // Same precedence as the loader: inrepo.json, else package.json#inrepo.
  for (const file of ["inrepo.json", "package.json"] as const) {
    const listing = await runGitCapture(["ls-tree", sourceCommit, "--", file], {
      cwd,
    });
    if (!listing) {
      continue;
    }
    const [mode = "", type = "", oid = ""] = (
      listing.split("\t")[0] ?? ""
    ).split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(
        `${file} is not a regular file at ${short(sourceCommit)}`
      );
    }
    const text = await runGitCapture(["cat-file", "blob", oid], {
      cwd,
      trim: false,
    });
    return mirrorsFromConfigText(text, file, cwd);
  }
  return [];
};

/**
 * The filters come from the config on disk. Refuse unless the source commit's
 * own config declares exactly the same mirror, so an uncommitted edit, a
 * deleted or shadowed config file, or another branch's `--ref` cannot publish
 * files that commit's config excludes.
 */
const assertConfigMatchesSource = async function assertConfigMatchesSource(
  cwd: string,
  mirror: InrepoMirror,
  sourceCommit: string,
  ref: string
): Promise<void> {
  let committed: InrepoMirror | undefined;
  let reason = "";
  try {
    committed = (await readCommittedMirrors(cwd, sourceCommit)).find(
      (m) => m.name === mirror.name
    );
  } catch (error) {
    reason = ` (${error instanceof Error ? error.message : String(error)})`;
  }
  if (committed == null || !isDeepStrictEqual(committed, mirror)) {
    throw new Error(
      `Mirror "${mirror.name}" in the config on disk does not match the one committed at ${JSON.stringify(ref)} (${short(sourceCommit)})${reason}. ` +
        `Commit the config, or check out ${JSON.stringify(ref)}, so the filters match the files being published.`
    );
  }
};

/** Resolve and filter the source tree; touches nothing outside the host repository. */
const prepareSource = async function prepareSource(
  cwd: string,
  mirror: InrepoMirror,
  ref: string
): Promise<MirrorSource> {
  const { sourceCommit, tree } = await resolveSourceTree(cwd, mirror, ref);
  await assertConfigMatchesSource(cwd, mirror, sourceCommit, ref);
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
  assertPublishable(
    mirror,
    entries.filter((e) => included.has(e.path))
  );
  return {
    entries,
    excludedCount: selection.excluded.length,
    included,
    sourceCommit,
  };
};

const publish = async function publish(
  cwd: string,
  mirror: InrepoMirror,
  opts: MirrorOptions,
  source: MirrorSource,
  scratch: Scratch
): Promise<MirrorResult> {
  const { sourceCommit, entries, included } = source;
  const ref = `refs/heads/${mirror.branch}`;
  await runGit(["check-ref-format", ref], { env: scratch.env });
  await addTargetRemote(scratch, resolveTargetUrl(cwd, mirror.git));
  const newTree = await writeFilteredTree(scratch, entries, included);

  const tip = await readTargetTip(scratch, ref);
  const tipTree =
    tip == null
      ? null
      : await scratchCapture(scratch, ["rev-parse", `${tip}^{tree}`]);
  const base = {
    excludedCount: source.excludedCount,
    includedCount: included.size,
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
  if (tip != null && tipTree != null && !opts.overwrite) {
    await assertSafeToPublish(cwd, scratch, mirror, tip, tipTree, sourceCommit);
  }

  const changes = await listChanges(scratch, tipTree, newTree);
  const commitArgs = ["-c", "user.useConfigOnly=true", "commit-tree", newTree];
  if (tip != null) {
    commitArgs.push("-p", tip);
  }
  commitArgs.push(
    "-m",
    opts.message ?? `Mirror ${short(sourceCommit)}`,
    "-m",
    `${MIRROR_SOURCE_TRAILER}: ${sourceCommit}\n${MIRROR_TREE_TRAILER}: ${newTree}`
  );
  const commit = await runGitCapture(commitArgs, {
    cwd: scratch.dir,
    env: await commitEnv(cwd, scratch),
  });

  if (!opts.dryRun) {
    // The lease makes the push fail if the branch moved, or appeared, since it was read.
    await runGit(
      [
        "push",
        "-q",
        `--force-with-lease=${ref}:${tip ?? ""}`,
        TARGET_REMOTE,
        `${commit}:${ref}`,
      ],
      { cwd: scratch.dir, env: scratch.env }
    );
  }
  return { ...base, changes, commit, pushed: !opts.dryRun, upToDate: false };
};

/**
 * Publish a filtered snapshot of `mirror.directory` at `opts.ref` to the
 * mirror's target branch as one commit on top of its current tip. Never
 * rewrites target history.
 */
export const runMirror = async function runMirror(
  cwd: string,
  mirror: InrepoMirror,
  opts: MirrorOptions
): Promise<MirrorResult> {
  let dir: string | null = null;
  try {
    const source = await prepareSource(cwd, mirror, opts.ref);
    dir = await mkdtemp(nodePath.join(tmpdir(), "inrepo-mirror-"));
    const scratch = await initScratchRepo(cwd, dir);
    return await publish(cwd, mirror, opts, source, scratch);
  } catch (error) {
    // Git errors echo the target URL. Rethrow a redacted copy only: the
    // original (with any embedded token) must not travel on as `cause`,
    // where error reporting and telemetry would read it.
    const message = error instanceof Error ? error.message : String(error);
    // oxlint-disable-next-line preserve-caught-error -- the cause holds unredacted credentials
    throw new Error(redactCredentials(message));
  } finally {
    if (dir != null) {
      await rm(dir, { force: true, recursive: true });
    }
  }
};
