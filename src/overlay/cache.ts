import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { applyVendorExcludes } from '../git/apply-vendor-excludes.js';
import { applyVendorKeep } from '../git/apply-vendor-keep.js';
import { clonePackage } from '../git/clone-package.js';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';
import { normalizeRepositoryUrlIdentity } from '../registry/normalize-repository-url-identity.js';
import { filtersHash } from './filters-hash.js';
import {
  cacheDirPath,
  cacheMetaPath,
  repositoryCacheDirPath,
  repositoryCacheRootPath,
} from './overlay-paths.js';
import { copyTree, defaultSkipTreePath, relPosixToAbs, walkTree } from './tree-utils.js';

type PristineMeta = {
  commit: string;
  filtersHash: string;
  gitUrl: string;
  repositoryDirectory: string | null;
};

type RepositoryMeta = {
  commit: string;
  gitUrl: string;
  normalizedGitUrl: string;
};

function normalizeGitUrlIdentity(raw: string): string {
  return normalizeRepositoryUrlIdentity(raw) ?? raw.trim().replace(/^git\+/i, '');
}

function repositoryCacheKey(gitUrl: string, commit: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ gitUrl: normalizeGitUrlIdentity(gitUrl), commit: commit.toLowerCase() }))
    .digest('hex');
}

function parsePristineMeta(raw: string, path: string): PristineMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid cache metadata in ${path}: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid cache metadata in ${path}: expected an object`);
  }
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.commit !== 'string' ||
    typeof rec.filtersHash !== 'string' ||
    typeof rec.gitUrl !== 'string'
  ) {
    throw new Error(`Invalid cache metadata in ${path}: missing required fields`);
  }
  return {
    commit: rec.commit,
    filtersHash: rec.filtersHash,
    gitUrl: rec.gitUrl,
    repositoryDirectory:
      typeof rec.repositoryDirectory === 'string'
        ? normalizeRepositoryDirectory(rec.repositoryDirectory, `${path} repositoryDirectory`)
        : null,
  };
}

async function readPristineMeta(path: string): Promise<PristineMeta | null> {
  if (!existsSync(path)) return null;
  return parsePristineMeta(await readFile(path, 'utf8'), path);
}

function parseRepositoryMeta(raw: string, path: string): RepositoryMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid repository cache metadata in ${path}: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid repository cache metadata in ${path}: expected an object`);
  }
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.commit !== 'string' ||
    typeof rec.gitUrl !== 'string' ||
    typeof rec.normalizedGitUrl !== 'string'
  ) {
    throw new Error(`Invalid repository cache metadata in ${path}: missing required fields`);
  }
  return {
    commit: rec.commit,
    gitUrl: rec.gitUrl,
    normalizedGitUrl: rec.normalizedGitUrl,
  };
}

async function readRepositoryMeta(path: string): Promise<RepositoryMeta | null> {
  if (!existsSync(path)) return null;
  return parseRepositoryMeta(await readFile(path, 'utf8'), path);
}

async function cachedRepositorySnapshot(
  cwd: string,
  gitUrl: string,
  commit: string,
): Promise<{ dir: string; commit: string; gitUrl: string } | null> {
  const normalizedGitUrl = normalizeGitUrlIdentity(gitUrl);
  const dir = repositoryCacheDirPath(cwd, repositoryCacheKey(normalizedGitUrl, commit));
  if (!existsSync(dir)) return null;
  const meta = await readRepositoryMeta(join(dir, '.cache-meta.json'));
  if (
    meta == null ||
    meta.commit.toLowerCase() !== commit.toLowerCase() ||
    meta.normalizedGitUrl !== normalizedGitUrl
  ) {
    return null;
  }
  return { dir, commit: meta.commit, gitUrl: meta.gitUrl };
}

/** Materialize one unfiltered repository commit, shared by every package rooted inside it. */
async function ensureRepositorySnapshot(opts: {
  cwd: string;
  gitUrl: string;
  ref?: string | null;
  commit?: string | null;
}): Promise<{ dir: string; commit: string; gitUrl: string }> {
  if (opts.commit) {
    const cached = await cachedRepositorySnapshot(opts.cwd, opts.gitUrl, opts.commit);
    if (cached) return { ...cached, gitUrl: opts.gitUrl };
  }

  const parent = repositoryCacheRootPath(opts.cwd);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.tmp-'));
  try {
    const cloned = await clonePackage({
      dest: stage,
      gitUrl: opts.gitUrl,
      ref: opts.commit ?? opts.ref ?? undefined,
    });
    const normalizedGitUrl = normalizeGitUrlIdentity(cloned.originUrl);
    const existing = await cachedRepositorySnapshot(opts.cwd, normalizedGitUrl, cloned.commit);
    if (existing) {
      await rm(stage, { recursive: true, force: true });
      return { ...existing, gitUrl: cloned.originUrl };
    }

    await rm(join(stage, '.git'), { recursive: true, force: true });
    const meta: RepositoryMeta = {
      commit: cloned.commit,
      gitUrl: cloned.originUrl,
      normalizedGitUrl,
    };
    await writeFile(join(stage, '.cache-meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const dir = repositoryCacheDirPath(
      opts.cwd,
      repositoryCacheKey(normalizedGitUrl, cloned.commit),
    );
    await rename(stage, dir);
    return { dir, commit: cloned.commit, gitUrl: cloned.originUrl };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function manifestIdentity(
  root: string,
  relativePath: string,
): Promise<{ name: string | null; version: string | null } | null> {
  try {
    const raw = await readFile(relPosixToAbs(root, relativePath), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : null,
      version: typeof record.version === 'string' ? record.version : null,
    };
  } catch {
    return null;
  }
}

/** Locate a registry package inside its immutable repository commit. */
export async function discoverRepositoryDirectory(opts: {
  cwd: string;
  name: string;
  version: string;
  gitUrl: string;
  commit: string;
}): Promise<string | null> {
  const repository = await ensureRepositorySnapshot({
    cwd: opts.cwd,
    gitUrl: opts.gitUrl,
    commit: opts.commit,
  });
  const root = await manifestIdentity(repository.dir, 'package.json');
  if (root?.name === opts.name) return null;

  const entries = await walkTree(repository.dir, { skip: defaultSkipTreePath });
  const matches: string[] = [];
  const nameMatches: string[] = [];
  let manifestCount = 0;
  for (const [relativePath, entry] of entries) {
    if (entry.kind !== 'file' || posix.basename(relativePath) !== 'package.json') continue;
    manifestCount++;
    const identity = await manifestIdentity(repository.dir, relativePath);
    if (identity?.name === opts.name) {
      const directory = posix.dirname(relativePath);
      nameMatches.push(directory);
      if (identity.version === opts.version) matches.push(directory);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0 && nameMatches.length === 1) return nameMatches[0];
  // Some source-only repositories generate package.json only while publishing.
  // With no competing workspace manifests, npm's root repository locator is
  // still unambiguous and the exact publish pin remains usable.
  if (matches.length === 0 && nameMatches.length === 0 && manifestCount === 0) return null;
  if (matches.length === 0 && nameMatches.length === 0) {
    throw new Error(
      `Cannot locate "${opts.name}@${opts.version}" in ${opts.gitUrl} at ${opts.commit}`,
    );
  }
  throw new Error(
    `Cannot locate "${opts.name}@${opts.version}" uniquely in ${opts.gitUrl} at ${opts.commit}: ${[...new Set([...matches, ...nameMatches])].join(', ')}`,
  );
}

export async function ensurePristine(opts: {
  cwd: string;
  name: string;
  gitUrl: string;
  repositoryDirectory?: string | null;
  ref?: string | null;
  commit?: string | null;
  keep: string[];
  exclude: string[];
}): Promise<{ dir: string; commit: string; gitUrl: string }> {
  const dir = cacheDirPath(opts.cwd, opts.name);
  const metaPath = cacheMetaPath(opts.cwd, opts.name);
  const expectedFiltersHash = filtersHash(opts.keep, opts.exclude);
  const repositoryDirectory =
    opts.repositoryDirectory == null
      ? null
      : normalizeRepositoryDirectory(
          opts.repositoryDirectory,
          `repositoryDirectory for "${opts.name}"`,
        );
  const cachedMeta = await readPristineMeta(metaPath);

  if (
    opts.commit &&
    cachedMeta &&
    cachedMeta.commit === opts.commit &&
    normalizeGitUrlIdentity(cachedMeta.gitUrl) === normalizeGitUrlIdentity(opts.gitUrl) &&
    cachedMeta.filtersHash === expectedFiltersHash &&
    cachedMeta.repositoryDirectory === repositoryDirectory &&
    existsSync(dir)
  ) {
    return { dir, commit: cachedMeta.commit, gitUrl: cachedMeta.gitUrl };
  }

  const repository = await ensureRepositorySnapshot(opts);
  const repositoryRoot = repositoryDirectory
    ? relPosixToAbs(repository.dir, repositoryDirectory)
    : repository.dir;
  if (!existsSync(repositoryRoot)) {
    throw new Error(
      `Repository directory "${repositoryDirectory}" for "${opts.name}" does not exist at ${repository.commit}`,
    );
  }
  if (!(await lstat(repositoryRoot)).isDirectory()) {
    throw new Error(
      `Repository directory "${repositoryDirectory}" for "${opts.name}" is not a directory at ${repository.commit}`,
    );
  }

  const parent = join(opts.cwd, '.inrepo', 'cache');
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.tmp-'));
  const stageMetaPath = join(stage, '.cache-meta.json');

  try {
    await copyTree(repositoryRoot, stage, {
      skip: defaultSkipTreePath,
      treatMissingAsEmpty: true,
      validateSymlinkWithinRoot: true,
    });

    if (opts.keep.length > 0) {
      await applyVendorKeep(stage, opts.keep);
    }
    if (opts.exclude.length > 0) {
      await applyVendorExcludes(stage, opts.exclude);
    }

    const meta: PristineMeta = {
      commit: repository.commit,
      filtersHash: expectedFiltersHash,
      gitUrl: repository.gitUrl,
      repositoryDirectory,
    };
    await writeFile(stageMetaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await rename(stage, dir);
    return { dir, commit: repository.commit, gitUrl: repository.gitUrl };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
