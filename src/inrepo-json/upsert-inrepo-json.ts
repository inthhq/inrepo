import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inrepoConfigPath } from '../paths/inrepo-config-path.js';

export type InrepoJsonEntry = {
  name: string;
  git?: string;
  ref?: string;
};

/** Upsert a package entry into inrepo.json (creates `{ "packages": [...] }` if missing). */
export async function upsertInrepoJson(cwd: string, entry: InrepoJsonEntry): Promise<void> {
  const path = inrepoConfigPath(cwd);
  let data: { packages: Record<string, unknown>[] } = { packages: [] };

  if (existsSync(path)) {
    const raw = await readFile(path, 'utf8');
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        throw new Error(`Invalid JSON in inrepo.json: ${err.message}`);
      }
      if (Array.isArray(parsed)) {
        data = { packages: parsed as Record<string, unknown>[] };
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { packages?: unknown }).packages)) {
        data = { packages: (parsed as { packages: Record<string, unknown>[] }).packages };
      } else {
        throw new Error('inrepo.json must be a JSON array or { "packages": [...] }');
      }
    }
  }

  const ix = data.packages.findIndex(
    (p) => p && typeof p === 'object' && p.name === entry.name,
  );
  const next: Record<string, unknown> = { name: entry.name };
  if (entry.git) next.git = entry.git;
  if (entry.ref) next.ref = entry.ref;

  if (ix >= 0) {
    data.packages[ix] = { ...data.packages[ix], ...next };
  } else {
    data.packages.push(next);
  }

  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
