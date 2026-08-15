import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import nodePath from "node:path";

export type TreeKind = "file" | "dir" | "symlink";

export interface TreeEntry {
  kind: TreeKind;
  executable: boolean;
  mode: number;
  size: number | null;
  linkTarget: string | null;
}

export const DEFAULT_IGNORED_BASENAMES = new Set([
  ".git",
  ".inrepo-vendor.json",
  ".cache-meta.json",
]);

export const isExecutableMode = function isExecutableMode(
  mode: number
): boolean {
  return (mode & 0o111) !== 0;
};

export const normalizedFileMode = function normalizedFileMode(
  mode: number
): number {
  return isExecutableMode(mode) ? 0o755 : 0o644;
};

export const relPosixToAbs = function relPosixToAbs(
  root: string,
  relPosix: string
): string {
  if (relPosix === "") {
    return root;
  }
  return nodePath.join(root, ...relPosix.split("/"));
};

export const defaultSkipTreePath = function defaultSkipTreePath(
  relPosix: string
): boolean {
  return relPosix
    .split("/")
    .some((part) => DEFAULT_IGNORED_BASENAMES.has(part));
};

const kindFromStat = function kindFromStat(
  stat: Awaited<ReturnType<typeof lstat>>
): TreeKind {
  if (stat.isDirectory()) {
    return "dir";
  }
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  throw new Error(`Unsupported filesystem entry type (mode=${stat.mode})`);
};

export const walkTree = async function walkTree(
  root: string,
  opts: {
    skip?: (relPosix: string) => boolean;
    treatMissingAsEmpty?: boolean;
  } = {}
): Promise<Map<string, TreeEntry>> {
  if (!existsSync(root)) {
    if (opts.treatMissingAsEmpty === true) {
      return new Map();
    }
    throw new Error(`Directory does not exist: ${root}`);
  }

  const out = new Map<string, TreeEntry>();

  const walk = async function walk(
    absDir: string,
    relDir: string
  ): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPosix = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (opts.skip?.(relPosix) === true) {
        continue;
      }

      const abs = nodePath.join(absDir, entry.name);
      const stat = await lstat(abs);
      const kind = kindFromStat(stat);
      const treeEntry: TreeEntry = {
        executable: kind === "file" ? isExecutableMode(stat.mode) : false,
        kind,
        linkTarget: kind === "symlink" ? await readlink(abs) : null,
        mode: stat.mode,
        size: kind === "file" ? stat.size : null,
      };
      out.set(relPosix, treeEntry);

      if (kind === "dir") {
        await walk(abs, relPosix);
      }
    }
  };

  await walk(root, "");
  return out;
};

export const sha256File = async function sha256File(
  absPath: string
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const removeForReplacement = async function removeForReplacement(
  absPath: string,
  nextKind: TreeKind
): Promise<void> {
  if (!existsSync(absPath)) {
    return;
  }
  const stat = await lstat(absPath);
  const currentKind = kindFromStat(stat);
  if (currentKind === "dir" && nextKind === "dir") {
    return;
  }
  await rm(absPath, { force: true, recursive: true });
};

/** True when a relative symlink target resolves outside `root`. */
export const symlinkTargetEscapesRoot = function symlinkTargetEscapesRoot(
  root: string,
  relPosix: string,
  target: string
): boolean {
  const absDir = nodePath.resolve(
    nodePath.dirname(relPosixToAbs(root, relPosix))
  );
  const resolvedTarget = nodePath.resolve(absDir, ...target.split(/[\\/]+/u));
  const rel = nodePath.relative(root, resolvedTarget);
  return rel.startsWith("..") || nodePath.isAbsolute(rel);
};

/**
 * Reject new or rewritten symlinks that are absolute or escape `targetRoot`.
 * Symlinks inherited unchanged from `pristineRoot` are left alone, matching
 * the legacy overlay path.
 */
export const assertPatchedSymlinksWithinRoot =
  async function assertPatchedSymlinksWithinRoot(
    pristineRoot: string,
    targetRoot: string
  ): Promise<void> {
    const [upstream, patched] = await Promise.all([
      walkTree(pristineRoot, { treatMissingAsEmpty: true }),
      walkTree(targetRoot, { treatMissingAsEmpty: true }),
    ]);

    for (const [relPosix, entry] of patched) {
      if (entry.kind !== "symlink" || entry.linkTarget == null) {
        continue;
      }
      const before = upstream.get(relPosix);
      if (
        before?.kind === "symlink" &&
        before.linkTarget === entry.linkTarget
      ) {
        continue;
      }
      if (nodePath.isAbsolute(entry.linkTarget)) {
        throw new Error(
          `Refusing to apply absolute symlink target at "${relPosix}"`
        );
      }
      if (symlinkTargetEscapesRoot(targetRoot, relPosix, entry.linkTarget)) {
        throw new Error(
          `Refusing to apply symlink escaping module root at "${relPosix}"`
        );
      }
    }
  };

const assertSymlinkWithinRoot = function assertSymlinkWithinRoot(
  root: string,
  relPosix: string,
  target: string
): void {
  if (nodePath.isAbsolute(target)) {
    throw new Error(
      `Refusing to capture absolute symlink target at "${relPosix}"`
    );
  }
  if (symlinkTargetEscapesRoot(root, relPosix, target)) {
    throw new Error(
      `Refusing to capture symlink escaping module root at "${relPosix}"`
    );
  }
};

export const copyEntry = async function copyEntry(
  sourceRoot: string,
  relPosix: string,
  targetRoot: string,
  opts: {
    validateSymlinkWithinRoot?: boolean;
  } = {}
): Promise<void> {
  const sourceAbs = relPosixToAbs(sourceRoot, relPosix);
  const stat = await lstat(sourceAbs);
  const kind = kindFromStat(stat);
  const targetAbs = relPosixToAbs(targetRoot, relPosix);

  if (kind === "dir") {
    await removeForReplacement(targetAbs, "dir");
    await mkdir(targetAbs, { recursive: true });
    await chmod(targetAbs, 0o755);
    return;
  }

  await mkdir(nodePath.dirname(targetAbs), { recursive: true });
  if (kind === "file") {
    await removeForReplacement(targetAbs, "file");
    await copyFile(sourceAbs, targetAbs);
    await chmod(targetAbs, normalizedFileMode(stat.mode));
    return;
  }

  const target = await readlink(sourceAbs);
  if (opts.validateSymlinkWithinRoot === true) {
    assertSymlinkWithinRoot(sourceRoot, relPosix, target);
  }
  await removeForReplacement(targetAbs, "symlink");
  await symlink(target, targetAbs);
};

export const copyTree = async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  opts: {
    skip?: (relPosix: string) => boolean;
    treatMissingAsEmpty?: boolean;
    validateSymlinkWithinRoot?: boolean;
  } = {}
): Promise<void> {
  const entries = await walkTree(sourceRoot, {
    skip: opts.skip,
    treatMissingAsEmpty: opts.treatMissingAsEmpty,
  });
  await mkdir(targetRoot, { recursive: true });
  for (const relPosix of [...entries.keys()].toSorted()) {
    await copyEntry(sourceRoot, relPosix, targetRoot, {
      validateSymlinkWithinRoot: opts.validateSymlinkWithinRoot,
    });
  }
};
