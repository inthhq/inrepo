import { realpathSync } from "node:fs";
import nodePath from "node:path";

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
  // Start from the path's own root ("/", "C:\\", "\\\\server\\share\\"), so a
  // drive or UNC prefix is not treated as an ordinary segment.
  const { root } = nodePath.parse(path);
  let current = root === "" ? process.cwd() : root;
  // Only Windows treats "\\" as a separator; on POSIX it is part of a name.
  const separators = process.platform === "win32" ? /[\\/]+/u : /\/+/u;
  for (const segment of path.slice(root.length).split(separators)) {
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
 * The path of a local `file://` URL without URL dot-segment removal, which
 * would collapse `link/..` before the symlink is followed.
 */
const fileUrlPath = function fileUrlPath(url: string): string | null {
  const rest = url.slice("file://".length);
  const withoutHost = rest.startsWith("localhost/")
    ? rest.slice("localhost".length)
    : rest;
  if (!withoutHost.startsWith("/")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(withoutHost);
    // "/C:/repo" on Windows.
    return process.platform === "win32" && /^\/[A-Za-z]:/u.test(decoded)
      ? decoded.slice(1)
      : decoded;
  } catch {
    return null;
  }
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
    localPath = fileUrlPath(trimmed);
  } else if (nodePath.isAbsolute(trimmed) || !isUrlLike(trimmed)) {
    localPath = resolveTargetUrl(configDir, trimmed);
  }
  return localPath == null ? trimmed : canonicalPath(localPath);
};
