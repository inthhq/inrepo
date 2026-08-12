import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { copyTree, defaultSkipTreePath, relPosixToAbs } from './tree-utils.js';

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
