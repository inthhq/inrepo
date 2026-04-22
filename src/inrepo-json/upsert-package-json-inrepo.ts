import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { packageJsonPath } from '../paths/package-json-path.js';
import type { InrepoJsonEntry } from './upsert-inrepo-json.js';

type InrepoData = { packages: Record<string, unknown>[]; exclude?: unknown; keep?: unknown };

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
    const data: InrepoData = { packages: obj.packages };
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

  const ix = data.packages.findIndex(
    (p) => p && typeof p === 'object' && p.name === entry.name,
  );
  const next: Record<string, unknown> = { name: entry.name };
  if (entry.git) next.git = entry.git;
  if (entry.ref) next.ref = entry.ref;

  if (ix >= 0) {
    const merged = { ...data.packages[ix], ...next };
    if (entry.dev === true) merged.dev = true;
    else delete merged.dev;
    data.packages[ix] = merged;
  } else {
    if (entry.dev === true) next.dev = true;
    data.packages.push(next);
  }

  const out: Record<string, unknown> = { packages: data.packages };
  if ('exclude' in data) out.exclude = data.exclude;
  if ('keep' in data) out.keep = data.keep;
  pkg.inrepo = out;

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}
