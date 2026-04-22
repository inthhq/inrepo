import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inrepoConfigPath } from '../paths/inrepo-config-path.js';
import { defaultInrepoJsonSchemaRef } from './default-inrepo-json-schema-ref.js';

export type InrepoJsonEntry = {
  name: string;
  git?: string;
  ref?: string;
  dev?: boolean;
};

/** Upsert a package entry into inrepo.json. Adds `$schema` at the end when the file did not already define it. */
export async function upsertInrepoJson(cwd: string, entry: InrepoJsonEntry): Promise<void> {
  const path = inrepoConfigPath(cwd);
  let data: {
    packages: Record<string, unknown>[];
    exclude?: unknown;
    keep?: unknown;
    schemaRef?: string;
    /** Top-level key order from object-shaped config (stable round-trip for `$schema` placement). */
    topLevelKeyOrder?: string[];
  } = {
    packages: [],
  };

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
        const obj = parsed as {
          packages: Record<string, unknown>[];
          exclude?: unknown;
          keep?: unknown;
          $schema?: unknown;
        };
        const topLevelKeyOrder = Object.keys(obj).filter(
          (k) => k === 'packages' || k === 'exclude' || k === 'keep' || k === '$schema',
        );
        data = {
          packages: obj.packages,
          topLevelKeyOrder,
        };
        if ('exclude' in obj) data.exclude = obj.exclude;
        if ('keep' in obj) data.keep = obj.keep;
        if (typeof obj.$schema === 'string' && obj.$schema.trim()) {
          data.schemaRef = obj.$schema.trim();
        }
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
    const merged = { ...data.packages[ix], ...next };
    if (entry.dev === true) merged.dev = true;
    else delete merged.dev;
    data.packages[ix] = merged;
  } else {
    if (entry.dev === true) next.dev = true;
    data.packages.push(next);
  }

  const schemaRef = data.schemaRef ?? defaultInrepoJsonSchemaRef;

  let out: Record<string, unknown>;
  if (data.topLevelKeyOrder && data.topLevelKeyOrder.length > 0) {
    out = {};
    for (const k of data.topLevelKeyOrder) {
      if (k === 'packages') out.packages = data.packages;
      else if (k === 'exclude' && 'exclude' in data) out.exclude = data.exclude;
      else if (k === 'keep' && 'keep' in data) out.keep = data.keep;
      else if (k === '$schema') out.$schema = schemaRef;
    }
    if (!('$schema' in out)) out.$schema = schemaRef;
  } else {
    out = { packages: data.packages };
    if ('exclude' in data) out.exclude = data.exclude;
    if ('keep' in data) out.keep = data.keep;
    out.$schema = schemaRef;
  }

  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}
