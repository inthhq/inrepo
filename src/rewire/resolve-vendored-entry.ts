import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** The parts of a vendored dependency's package.json that entry resolution needs. */
export type EntryManifest = {
  main: string | null;
  module: string | null;
  exports: unknown;
};

/** Which set of `exports` conditions to honor, decided by the importing syntax. */
export type EntryCondition = 'import' | 'require';

const CONDITION_ORDER: Record<EntryCondition, string[]> = {
  import: ['import', 'module', 'browser', 'node', 'default', 'require'],
  require: ['require', 'node', 'default', 'browser', 'import'],
};

const FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];
const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.json'];

/** Read `<dir>/package.json` for entry resolution. Null when it is absent or unreadable. */
export async function loadEntryManifest(dir: string): Promise<EntryManifest | null> {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  return {
    main: typeof rec.main === 'string' ? rec.main : null,
    module: typeof rec.module === 'string' ? rec.module : null,
    exports: rec.exports,
  };
}

/**
 * Reduce one `exports` value to the file paths it can resolve to, best first.
 *
 * Conditions are walked in a fixed order per {@link CONDITION_ORDER} so the
 * result only depends on committed files, never on the host runtime.
 */
function exportsTargets(value: unknown, condition: EntryCondition, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => exportsTargets(entry, condition, depth + 1));
  }
  if (value == null || typeof value !== 'object') return [];

  const rec = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of CONDITION_ORDER[condition]) {
    if (key in rec) out.push(...exportsTargets(rec[key], condition, depth + 1));
  }
  return out;
}

/** True when `exports` maps subpaths (`"."`, `"./sub"`) rather than conditions. */
function isSubpathExports(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((key) => key.startsWith('.'));
}

function normalizeCandidate(candidate: string): string | null {
  const cleaned = candidate.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned.startsWith('/') || cleaned.includes('*')) return null;
  const parts = posix.normalize(cleaned).split('/');
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turn one candidate path into a concrete file inside `depRoot`, applying the
 * extension and directory-index lookups a bundler-free resolver would.
 */
async function resolveCandidate(depRoot: string, candidate: string): Promise<string | null> {
  const normalized = normalizeCandidate(candidate);
  if (normalized == null) return null;
  const abs = join(depRoot, ...normalized.split('/'));

  if (await isFile(abs)) return normalized;
  for (const extension of FILE_EXTENSIONS) {
    if (await isFile(`${abs}${extension}`)) return `${normalized}${extension}`;
  }
  if (await isDirectory(abs)) {
    for (const index of INDEX_FILES) {
      if (await isFile(join(abs, index))) return `${normalized}/${index}`;
    }
  }
  return null;
}

/** Candidate paths for a bare `dep` specifier, best first. */
function rootCandidates(manifest: EntryManifest | null, condition: EntryCondition): string[] {
  if (manifest == null) return ['index.js'];
  const candidates: string[] = [];
  const exportsValue = isSubpathExports(manifest.exports)
    ? (manifest.exports as Record<string, unknown>)['.']
    : manifest.exports;
  candidates.push(...exportsTargets(exportsValue, condition));
  if (condition === 'import') {
    if (manifest.module) candidates.push(manifest.module);
    if (manifest.main) candidates.push(manifest.main);
  } else {
    if (manifest.main) candidates.push(manifest.main);
    if (manifest.module) candidates.push(manifest.module);
  }
  candidates.push('index.js');
  return candidates;
}

/** Candidate paths for a `dep/sub/path` specifier, best first. */
function subpathCandidates(
  manifest: EntryManifest | null,
  subpath: string,
  condition: EntryCondition,
): string[] {
  const candidates: string[] = [];
  if (manifest != null && isSubpathExports(manifest.exports)) {
    const mapped = (manifest.exports as Record<string, unknown>)[`./${subpath}`];
    candidates.push(...exportsTargets(mapped, condition));
  }
  candidates.push(subpath);
  return candidates;
}

/**
 * Resolve a bare specifier's target inside a vendored dependency to a concrete
 * file, returned as a POSIX path relative to `depRoot`.
 *
 * The result is a file rather than the package directory because Node's ESM
 * resolver performs neither directory-index nor `main` lookups for relative
 * specifiers: `import "../picocolors"` fails where `import
 * "../picocolors/picocolors.js"` works. Returns null when nothing resolves, in
 * which case the caller leaves the specifier alone.
 */
export async function resolveVendoredEntry(opts: {
  depRoot: string;
  manifest: EntryManifest | null;
  /** Everything after the package name, without a leading slash. `''` for the package itself. */
  subpath: string;
  condition: EntryCondition;
}): Promise<string | null> {
  const candidates =
    opts.subpath === ''
      ? rootCandidates(opts.manifest, opts.condition)
      : subpathCandidates(opts.manifest, opts.subpath, opts.condition);

  for (const candidate of candidates) {
    const resolved = await resolveCandidate(opts.depRoot, candidate);
    if (resolved != null) return resolved;
  }
  return null;
}
