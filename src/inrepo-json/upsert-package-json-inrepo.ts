import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { packageJsonPath } from '../paths/package-json-path.js';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';
import type { InrepoJsonEntry } from './upsert-inrepo-json.js';

type InrepoData = {
  packages: Record<string, unknown>[];
  exclude?: unknown;
  keep?: unknown;
  /** Object.keys order from object-shaped config (stable round-trip, includes unknown keys). */
  fullKeyOrder?: string[];
  /** Shallow snapshot of the parsed root object (object form only); preserves unknown top-level keys. */
  rootSnapshot?: Record<string, unknown>;
};

function parseExistingInrepo(existing: unknown): InrepoData {
  if (existing == null) {
    return { packages: [] };
  }
  if (Array.isArray(existing)) {
    return { packages: existing as Record<string, unknown>[] };
  }
  if (typeof existing === 'object' && Array.isArray((existing as { packages?: unknown }).packages)) {
    const obj = existing as {
      packages: Record<string, unknown>[];
      exclude?: unknown;
      keep?: unknown;
    };
    const data: InrepoData = {
      packages: obj.packages,
      fullKeyOrder: Object.keys(obj),
      rootSnapshot: { ...obj },
    };
    if ('exclude' in obj) data.exclude = obj.exclude;
    if ('keep' in obj) data.keep = obj.keep;
    return data;
  }
  throw new Error('package.json "inrepo" must be a JSON array or an object with a "packages" array');
}

/** Upsert a package entry into package.json#inrepo (preserves other package.json keys). */
export async function upsertPackageJsonInrepo(cwd: string, entry: InrepoJsonEntry): Promise<void> {
  const path = packageJsonPath(cwd);
  if (!existsSync(path)) {
    throw new Error('package.json not found; create it or use a project root that contains package.json.');
  }
  const raw = await readFile(path, 'utf8');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (pkg == null || typeof pkg !== 'object') {
    throw new Error('package.json must contain a JSON object');
  }

  const data = parseExistingInrepo(pkg.inrepo);

  const identity = entry.module ?? entry.name;
  const ix = data.packages.findIndex((p) => {
    if (!p || typeof p !== 'object') return false;
    return (typeof p.module === 'string' ? p.module : p.name) === identity;
  });
  const next: Record<string, unknown> = { name: entry.name };
  if (entry.module) next.module = entry.module;
  if (entry.git) next.git = entry.git;
  if (entry.ref) next.ref = entry.ref;
  const repositoryDirectory =
    typeof entry.repositoryDirectory === 'string'
      ? normalizeRepositoryDirectory(
          entry.repositoryDirectory,
          'repositoryDirectory',
        )
      : entry.repositoryDirectory;
  if (repositoryDirectory != null) next.repositoryDirectory = repositoryDirectory;

  if (ix >= 0) {
    const merged = { ...data.packages[ix], ...next };
    if (entry.repositoryDirectory === null || repositoryDirectory === null) {
      delete merged.repositoryDirectory;
    }
    if (entry.dev === true) merged.dev = true;
    else delete merged.dev;
    data.packages[ix] = merged;
  } else {
    if (entry.dev === true) next.dev = true;
    data.packages.push(next);
  }

  let out: Record<string, unknown>;
  if (data.fullKeyOrder && data.rootSnapshot) {
    out = {};
    for (const k of data.fullKeyOrder) {
      if (k === 'packages') out.packages = data.packages;
      else if (k === 'exclude' && 'exclude' in data) out.exclude = data.exclude;
      else if (k === 'keep' && 'keep' in data) out.keep = data.keep;
      else out[k] = data.rootSnapshot[k];
    }
  } else {
    out = { packages: data.packages };
    if ('exclude' in data) out.exclude = data.exclude;
    if ('keep' in data) out.keep = data.keep;
  }
  pkg.inrepo = out;

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}
