import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { applyVendorExcludes } from "../git/apply-vendor-excludes.js";
import { applyVendorKeep } from "../git/apply-vendor-keep.js";
import { clonePackage } from "../git/clone-package.js";
import { isJsonObject, isString } from "../json/unknown.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import { normalizeRepositoryUrlIdentity } from "../registry/normalize-repository-url-identity.js";
import type { PublishedArtifact } from "../types/published-artifact.js";
import { filtersHash } from "./filters-hash.js";
import {
  cacheDirPath,
  cacheMetaPath,
  repositoryCacheDirPath,
  repositoryCacheRootPath,
} from "./overlay-paths.js";
import {
  ensurePublishedArtifact,
  fillMissingPublishedFiles,
} from "./published-artifact.js";
import {
  copyTree,
  defaultSkipTreePath,
  relPosixToAbs,
  walkTree,
} from "./tree-utils.js";

interface PristineMeta {
  commit: string;
  filtersHash: string;
  gitUrl: string;
  repositoryDirectory: string | null;
  artifactIntegrity: string | null;
}

interface RepositoryMeta {
  commit: string;
  gitUrl: string;
  normalizedGitUrl: string;
}

const normalizeGitUrlIdentity = function normalizeGitUrlIdentity(
  raw: string
): string {
  return (
    normalizeRepositoryUrlIdentity(raw) ?? raw.trim().replace(/^git\+/iu, "")
  );
};

const repositoryCacheKey = function repositoryCacheKey(
  gitUrl: string,
  commit: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commit: commit.toLowerCase(),
        gitUrl: normalizeGitUrlIdentity(gitUrl),
      })
    )
    .digest("hex");
};

const parsePristineMeta = function parsePristineMeta(
  raw: string,
  path: string
): PristineMeta {
  let parsed: unknown;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid cache metadata in ${path}: ${err.message}`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid cache metadata in ${path}: expected an object`);
  }
  const rec = parsed;
  if (
    !isString(rec.commit) ||
    !isString(rec.filtersHash) ||
    !isString(rec.gitUrl)
  ) {
    throw new TypeError(
      `Invalid cache metadata in ${path}: missing required fields`
    );
  }
  return {
    artifactIntegrity: isString(rec.artifactIntegrity)
      ? rec.artifactIntegrity
      : null,
    commit: rec.commit,
    filtersHash: rec.filtersHash,
    gitUrl: rec.gitUrl,
    repositoryDirectory: isString(rec.repositoryDirectory)
      ? normalizeRepositoryDirectory(
          rec.repositoryDirectory,
          `${path} repositoryDirectory`
        )
      : null,
  };
};

const readPristineMeta = async function readPristineMeta(
  path: string
): Promise<PristineMeta | null> {
  if (!existsSync(path)) {
    return null;
  }
  return parsePristineMeta(await readFile(path, "utf-8"), path);
};

const parseRepositoryMeta = function parseRepositoryMeta(
  raw: string,
  path: string
): RepositoryMeta {
  let parsed: unknown;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Invalid repository cache metadata in ${path}: ${err.message}`,
      { cause: error }
    );
  }
  if (!isJsonObject(parsed)) {
    throw new Error(
      `Invalid repository cache metadata in ${path}: expected an object`
    );
  }
  const rec = parsed;
  if (
    !isString(rec.commit) ||
    !isString(rec.gitUrl) ||
    !isString(rec.normalizedGitUrl)
  ) {
    throw new TypeError(
      `Invalid repository cache metadata in ${path}: missing required fields`
    );
  }
  return {
    commit: rec.commit,
    gitUrl: rec.gitUrl,
    normalizedGitUrl: rec.normalizedGitUrl,
  };
};

const readRepositoryMeta = async function readRepositoryMeta(
  path: string
): Promise<RepositoryMeta | null> {
  if (!existsSync(path)) {
    return null;
  }
  return parseRepositoryMeta(await readFile(path, "utf-8"), path);
};

const cachedRepositorySnapshot = async function cachedRepositorySnapshot(
  cwd: string,
  gitUrl: string,
  commit: string
): Promise<{ dir: string; commit: string; gitUrl: string } | null> {
  const normalizedGitUrl = normalizeGitUrlIdentity(gitUrl);
  const dir = repositoryCacheDirPath(
    cwd,
    repositoryCacheKey(normalizedGitUrl, commit)
  );
  if (!existsSync(dir)) {
    return null;
  }
  const meta = await readRepositoryMeta(nodePath.join(dir, ".cache-meta.json"));
  if (
    meta == null ||
    meta.commit.toLowerCase() !== commit.toLowerCase() ||
    meta.normalizedGitUrl !== normalizedGitUrl
  ) {
    return null;
  }
  return { commit: meta.commit, dir, gitUrl: meta.gitUrl };
};

/** Materialize one unfiltered repository commit, shared by every package rooted inside it. */
const ensureRepositorySnapshot = async function ensureRepositorySnapshot(opts: {
  cwd: string;
  gitUrl: string;
  ref?: string | null;
  commit?: string | null;
}): Promise<{ dir: string; commit: string; gitUrl: string }> {
  if (opts.commit) {
    const cached = await cachedRepositorySnapshot(
      opts.cwd,
      opts.gitUrl,
      opts.commit
    );
    if (cached) {
      return { ...cached, gitUrl: opts.gitUrl };
    }
  }

  const parent = repositoryCacheRootPath(opts.cwd);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(nodePath.join(parent, ".tmp-"));
  try {
    const cloned = await clonePackage({
      dest: stage,
      gitUrl: opts.gitUrl,
      ref: opts.commit ?? opts.ref ?? undefined,
    });
    const normalizedGitUrl = normalizeGitUrlIdentity(cloned.originUrl);
    const existing = await cachedRepositorySnapshot(
      opts.cwd,
      normalizedGitUrl,
      cloned.commit
    );
    if (existing) {
      await rm(stage, { force: true, recursive: true });
      return { ...existing, gitUrl: cloned.originUrl };
    }

    await rm(nodePath.join(stage, ".git"), { force: true, recursive: true });
    const meta: RepositoryMeta = {
      commit: cloned.commit,
      gitUrl: cloned.originUrl,
      normalizedGitUrl,
    };
    await writeFile(
      nodePath.join(stage, ".cache-meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8"
    );

    const dir = repositoryCacheDirPath(
      opts.cwd,
      repositoryCacheKey(normalizedGitUrl, cloned.commit)
    );
    await rename(stage, dir);
    return { commit: cloned.commit, dir, gitUrl: cloned.originUrl };
  } catch (error) {
    await rm(stage, { force: true, recursive: true });
    throw error;
  }
};

const manifestIdentity = async function manifestIdentity(
  root: string,
  relativePath: string
): Promise<{ name: string | null; version: string | null } | null> {
  try {
    const raw = await readFile(relPosixToAbs(root, relativePath), "utf-8");
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed)) {
      return null;
    }
    const record = parsed;
    return {
      name: isString(record.name) ? record.name : null,
      version: isString(record.version) ? record.version : null,
    };
  } catch {
    return null;
  }
};

/** Locate a registry package inside its immutable repository commit. */
export const discoverRepositoryDirectory =
  async function discoverRepositoryDirectory(opts: {
    cwd: string;
    name: string;
    version: string;
    gitUrl: string;
    commit: string;
  }): Promise<string | null> {
    const repository = await ensureRepositorySnapshot({
      commit: opts.commit,
      cwd: opts.cwd,
      gitUrl: opts.gitUrl,
    });
    const root = await manifestIdentity(repository.dir, "package.json");
    if (root?.name === opts.name) {
      return null;
    }

    const entries = await walkTree(repository.dir, {
      skip: defaultSkipTreePath,
    });
    const matches: string[] = [];
    const nameMatches: string[] = [];
    let manifestCount = 0;
    for (const [relativePath, entry] of entries) {
      if (
        entry.kind !== "file" ||
        nodePath.posix.basename(relativePath) !== "package.json"
      ) {
        continue;
      }
      manifestCount += 1;
      const identity = await manifestIdentity(repository.dir, relativePath);
      if (identity?.name === opts.name) {
        const directory = nodePath.posix.dirname(relativePath);
        nameMatches.push(directory);
        if (identity.version === opts.version) {
          matches.push(directory);
        }
      }
    }
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length === 0 && nameMatches.length === 1) {
      return nameMatches[0];
    }
    // Some source-only repositories generate package.json only while publishing.
    // With no competing workspace manifests, npm's root repository locator is
    // still unambiguous and the exact publish pin remains usable.
    if (
      matches.length === 0 &&
      nameMatches.length === 0 &&
      manifestCount === 0
    ) {
      return null;
    }
    if (matches.length === 0 && nameMatches.length === 0) {
      throw new Error(
        `Cannot locate "${opts.name}@${opts.version}" in ${opts.gitUrl} at ${opts.commit}`
      );
    }
    throw new Error(
      `Cannot locate "${opts.name}@${opts.version}" uniquely in ${opts.gitUrl} at ${opts.commit}: ${[...new Set([...matches, ...nameMatches])].join(", ")}`
    );
  };

export const ensurePristine = async function ensurePristine(opts: {
  cwd: string;
  name: string;
  gitUrl: string;
  repositoryDirectory?: string | null;
  ref?: string | null;
  commit?: string | null;
  keep: string[];
  exclude: string[];
  artifact?: PublishedArtifact | null;
}): Promise<{ dir: string; commit: string; gitUrl: string }> {
  const dir = cacheDirPath(opts.cwd, opts.name);
  const metaPath = cacheMetaPath(opts.cwd, opts.name);
  const expectedFiltersHash = filtersHash(opts.keep, opts.exclude);
  const repositoryDirectory =
    opts.repositoryDirectory == null
      ? null
      : normalizeRepositoryDirectory(
          opts.repositoryDirectory,
          `repositoryDirectory for "${opts.name}"`
        );
  const cachedMeta = await readPristineMeta(metaPath);

  if (
    opts.commit &&
    cachedMeta &&
    cachedMeta.commit === opts.commit &&
    normalizeGitUrlIdentity(cachedMeta.gitUrl) ===
      normalizeGitUrlIdentity(opts.gitUrl) &&
    cachedMeta.filtersHash === expectedFiltersHash &&
    cachedMeta.repositoryDirectory === repositoryDirectory &&
    cachedMeta.artifactIntegrity === (opts.artifact?.integrity ?? null) &&
    existsSync(dir)
  ) {
    return { commit: cachedMeta.commit, dir, gitUrl: cachedMeta.gitUrl };
  }

  const repository = await ensureRepositorySnapshot(opts);
  const repositoryRoot = repositoryDirectory
    ? relPosixToAbs(repository.dir, repositoryDirectory)
    : repository.dir;
  if (!existsSync(repositoryRoot)) {
    throw new Error(
      `Repository directory "${repositoryDirectory}" for "${opts.name}" does not exist at ${repository.commit}`
    );
  }
  if (!(await (await lstat(repositoryRoot)).isDirectory())) {
    throw new Error(
      `Repository directory "${repositoryDirectory}" for "${opts.name}" is not a directory at ${repository.commit}`
    );
  }

  const parent = nodePath.join(opts.cwd, ".inrepo", "cache");
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(nodePath.join(parent, ".tmp-"));
  const stageMetaPath = nodePath.join(stage, ".cache-meta.json");

  try {
    await copyTree(repositoryRoot, stage, {
      skip: defaultSkipTreePath,
      treatMissingAsEmpty: true,
      validateSymlinkWithinRoot: true,
    });

    if (opts.artifact != null) {
      const artifactRoot = await ensurePublishedArtifact(
        opts.cwd,
        opts.artifact
      );
      await fillMissingPublishedFiles(artifactRoot, stage);
    }

    if (opts.keep.length > 0) {
      await applyVendorKeep(stage, opts.keep);
    }
    if (opts.exclude.length > 0) {
      await applyVendorExcludes(stage, opts.exclude);
    }

    const meta: PristineMeta = {
      artifactIntegrity: opts.artifact?.integrity ?? null,
      commit: repository.commit,
      filtersHash: expectedFiltersHash,
      gitUrl: repository.gitUrl,
      repositoryDirectory,
    };
    await writeFile(
      stageMetaPath,
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8"
    );

    await rm(dir, { force: true, recursive: true });
    await mkdir(nodePath.dirname(dir), { recursive: true });
    await rename(stage, dir);
    return { commit: repository.commit, dir, gitUrl: repository.gitUrl };
  } catch (error) {
    await rm(stage, { force: true, recursive: true });
    throw error;
  }
};
