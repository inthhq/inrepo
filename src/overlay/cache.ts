import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyVendorExcludes } from '../git/apply-vendor-excludes.js';
import { applyVendorKeep } from '../git/apply-vendor-keep.js';
import { clonePackage } from '../git/clone-package.js';
import { filtersHash } from './filters-hash.js';
import { cacheDirPath, cacheMetaPath } from './overlay-paths.js';

type PristineMeta = {
  commit: string;
  filtersHash: string;
  gitUrl: string;
};

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
  };
}

async function readPristineMeta(path: string): Promise<PristineMeta | null> {
  if (!existsSync(path)) return null;
  return parsePristineMeta(await readFile(path, 'utf8'), path);
}

export async function ensurePristine(opts: {
  cwd: string;
  name: string;
  gitUrl: string;
  ref?: string | null;
  commit?: string | null;
  keep: string[];
  exclude: string[];
}): Promise<{ dir: string; commit: string; gitUrl: string }> {
  const dir = cacheDirPath(opts.cwd, opts.name);
  const metaPath = cacheMetaPath(opts.cwd, opts.name);
  const expectedFiltersHash = filtersHash(opts.keep, opts.exclude);
  const cachedMeta = await readPristineMeta(metaPath);

  if (
    opts.commit &&
    cachedMeta &&
    cachedMeta.commit === opts.commit &&
    cachedMeta.gitUrl === opts.gitUrl &&
    cachedMeta.filtersHash === expectedFiltersHash &&
    existsSync(dir)
  ) {
    return { dir, commit: cachedMeta.commit, gitUrl: cachedMeta.gitUrl };
  }

  const parent = join(opts.cwd, '.inrepo', 'cache');
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.tmp-'));
  const stageMetaPath = join(stage, '.cache-meta.json');

  try {
    const cloneRef = opts.commit ?? opts.ref ?? undefined;
    const { commit, originUrl } = await clonePackage({
      dest: stage,
      gitUrl: opts.gitUrl,
      ref: cloneRef ?? undefined,
    });

    if (opts.keep.length > 0) {
      await applyVendorKeep(stage, opts.keep);
    }
    if (opts.exclude.length > 0) {
      await applyVendorExcludes(stage, opts.exclude);
    }

    await rm(join(stage, '.git'), { recursive: true, force: true });
    const meta: PristineMeta = {
      commit,
      filtersHash: expectedFiltersHash,
      gitUrl: originUrl,
    };
    await writeFile(stageMetaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    await rm(dir, { recursive: true, force: true });
    await rename(stage, dir);
    return { dir, commit, gitUrl: originUrl };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
