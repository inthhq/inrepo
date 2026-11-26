import { realpathSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** True for `scheme://…` and scp-style `host:path` targets. */
const isUrlLike = function isUrlLike(git: string): boolean {
  if (git.includes("://")) {
    return true;
  }
  const colon = git.indexOf(":");
  const slash = git.indexOf("/");
  return colon > 0 && (slash === -1 || colon < slash);
};

/**
 * The configured mirror target as git should see it from a scratch
 * repository: URLs (`scheme://`, `host:path`) and absolute paths as written,
 * relative paths prefixed with the config directory. Paths are not
 * normalized here, so `link/..` resolves through symlinks the way git does.
 */
export const resolveTargetUrl = function resolveTargetUrl(
  configDir: string,
  git: string
): string {
  if (isUrlLike(git) || nodePath.isAbsolute(git)) {
    return git;
  }
  return `${configDir}${nodePath.sep}${git}`;
};

/**
 * Resolve `path` one segment at a time, following each symlink before the
 * next `..` is applied, the way the operating system (and so git) does.
 */
const canonicalPath = function canonicalPath(path: string): string {
  let current = nodePath.parse(nodePath.resolve("/")).root;
  if (!nodePath.isAbsolute(path)) {
    current = process.cwd();
  }
  for (const segment of path.split(/[\\/]+/u)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    current =
      segment === ".."
        ? nodePath.dirname(current)
        : nodePath.join(current, segment);
    try {
      current = realpathSync.native(current);
    } catch {
      // Missing segments stay as written.
    }
  }
  return current;
};

/**
 * A comparison key for duplicate-target checks: the canonical filesystem path
 * (symlinks resolved) for local repositories that exist, else the URL as
 * written without trailing slashes.
 */
export const targetIdentity = function targetIdentity(
  configDir: string,
  git: string
): string {
  const trimmed = git.replace(/\/+$/u, "");
  let localPath: string | null = null;
  if (trimmed.startsWith("file://")) {
    try {
      localPath = fileURLToPath(trimmed);
    } catch {
      localPath = null;
    }
  } else if (!isUrlLike(trimmed)) {
    localPath = resolveTargetUrl(configDir, trimmed);
  }
  return localPath == null ? trimmed : canonicalPath(localPath);
};
