import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The parts of a package's own package.json that dependency vendoring needs. */
export type PackageManifest = {
  name: string | null;
  version: string | null;
  /** Runtime `dependencies` only; dev and peer dependencies are never vendored. */
  dependencies: Record<string, string>;
};

function stringRecord(raw: unknown): Record<string, string> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Read `<dir>/package.json`. Returns null when the file is absent, which is a
 * legitimate outcome for a checkout narrowed by `keep` or `exclude`.
 */
export async function readPackageManifest(dir: string): Promise<PackageManifest | null> {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json in ${dir}: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  return {
    name: typeof rec.name === 'string' ? rec.name : null,
    version: typeof rec.version === 'string' ? rec.version : null,
    dependencies: stringRecord(rec.dependencies),
  };
}
