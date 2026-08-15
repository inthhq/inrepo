import nodePath from "node:path";

const assertSafePackagePathSegment = function assertSafePackagePathSegment(
  kind: string,
  value: string,
  name: string
): void {
  if (!value) {
    throw new Error(
      `Invalid ${kind} in package name "${name}": segment is empty`
    );
  }
  if (nodePath.isAbsolute(value)) {
    throw new Error(
      `Invalid ${kind} in package name "${name}": absolute paths are not allowed`
    );
  }

  const parts = value.split(/[\\/]/u);
  if (parts.length !== 1) {
    throw new Error(
      `Invalid ${kind} in package name "${name}": path separators are not allowed`
    );
  }
  if (parts[0] === "." || parts[0] === "..") {
    throw new Error(
      `Invalid ${kind} in package name "${name}": traversal segments are not allowed`
    );
  }
};

const packageTreePath = function packageTreePath(
  root: string,
  name: string
): string {
  if (nodePath.isAbsolute(name)) {
    throw new Error(
      `Invalid package name "${name}": absolute paths are not allowed`
    );
  }
  if (name.startsWith("@")) {
    const i = name.indexOf("/", 1);
    if (i === -1) {
      throw new Error(`Invalid scoped name (missing /): ${name}`);
    }
    const scope = name.slice(0, i);
    const pkg = name.slice(i + 1);
    if (!pkg) {
      throw new Error(`Invalid scoped name: ${name}`);
    }
    assertSafePackagePathSegment("scope", scope, name);
    assertSafePackagePathSegment("package segment", pkg, name);
    return nodePath.join(root, scope, pkg);
  }
  assertSafePackagePathSegment("package segment", name, name);
  return nodePath.join(root, name);
};

export const overlayDirPath = function overlayDirPath(
  cwd: string,
  name: string
): string {
  return packageTreePath(nodePath.join(cwd, "inrepo_patches"), name);
};

export const overlayDeletionsPath = function overlayDeletionsPath(
  cwd: string,
  name: string
): string {
  return nodePath.join(overlayDirPath(cwd, name), ".inrepo-deletions");
};

/** Directory name holding a package's ordered git patch series. */
export const SERIES_DIR_NAME = "series";

export const seriesDirPath = function seriesDirPath(
  cwd: string,
  name: string
): string {
  return nodePath.join(overlayDirPath(cwd, name), SERIES_DIR_NAME);
};

export const cacheDirPath = function cacheDirPath(
  cwd: string,
  name: string
): string {
  return packageTreePath(nodePath.join(cwd, ".inrepo", "cache"), name);
};

export const cacheMetaPath = function cacheMetaPath(
  cwd: string,
  name: string
): string {
  return nodePath.join(cacheDirPath(cwd, name), ".cache-meta.json");
};

/** Content-addressed, unfiltered repository snapshots shared by package views. */
export const repositoryCacheRootPath = function repositoryCacheRootPath(
  cwd: string
): string {
  return nodePath.join(cwd, ".inrepo", "repositories");
};

export const repositoryCacheDirPath = function repositoryCacheDirPath(
  cwd: string,
  key: string
): string {
  return nodePath.join(repositoryCacheRootPath(cwd), key);
};

/** Content-addressed npm package payloads used to restore publish-only files. */
export const artifactCacheRootPath = function artifactCacheRootPath(
  cwd: string
): string {
  return nodePath.join(cwd, ".inrepo", "artifacts");
};

export const artifactCacheDirPath = function artifactCacheDirPath(
  cwd: string,
  key: string
): string {
  return nodePath.join(artifactCacheRootPath(cwd), key);
};

/**
 * Root of an in-progress `inrepo update` for one package. Everything the
 * command needs to resume or discard a conflicted rebase lives under here, and
 * nothing outside it changes until the update succeeds.
 */
export const updateDirPath = function updateDirPath(
  cwd: string,
  name: string
): string {
  return packageTreePath(nodePath.join(cwd, ".inrepo", "updates"), name);
};

/** Scratch repository the user edits to resolve update conflicts. */
export const updateRepoPath = function updateRepoPath(
  cwd: string,
  name: string
): string {
  return nodePath.join(updateDirPath(cwd, name), "repo");
};

export const updateStatePath = function updateStatePath(
  cwd: string,
  name: string
): string {
  return nodePath.join(updateDirPath(cwd, name), "state.json");
};

/** Copy of `series/` taken before an update replaces the committed patches. */
export const updateSeriesSnapshotPath = function updateSeriesSnapshotPath(
  cwd: string,
  name: string
): string {
  return nodePath.join(updateDirPath(cwd, name), "series");
};

export const moduleStatePath = function moduleStatePath(
  cwd: string,
  name: string
): string {
  return `${packageTreePath(nodePath.join(cwd, ".inrepo", "state"), name)}.json`;
};

export const backupDirPath = function backupDirPath(
  cwd: string,
  name: string,
  iso: string
): string {
  const safeName = name.replaceAll("/", "__");
  return nodePath.join(cwd, ".inrepo", "backups", `${safeName}-${iso}`);
};
