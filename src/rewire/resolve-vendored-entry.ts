import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** The parts of a vendored dependency's package.json that entry resolution needs. */
export type EntryManifest = {
  main: string | null;
  module: string | null;
  /** Conventional source entry used by several package build tools. */
  source?: string | null;
  exports: unknown;
};

/** Which set of `exports` conditions to honor, decided by the importing syntax. */
export type EntryCondition = 'import' | 'require';

/** Node/Bun export conditions. Browser builds are not selected. */
const CONDITION_ORDER: Record<EntryCondition, string[]> = {
  import: ['import', 'module', 'node', 'default'],
  require: ['require', 'node', 'default'],
};

const FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'];
const INDEX_FILES = FILE_EXTENSIONS.map((extension) => `index${extension}`);
const OUTPUT_DIRECTORIES = new Set(['dist', 'build', 'out', 'lib']);

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
    source: typeof rec.source === 'string' ? rec.source : null,
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
  const extension = posix.extname(normalized);
  const withoutExtension = FILE_EXTENSIONS.includes(extension)
    ? normalized.slice(0, -extension.length)
    : normalized;
  const extensionBase = join(depRoot, ...withoutExtension.split('/'));
  for (const candidateExtension of FILE_EXTENSIONS) {
    if (await isFile(`${extensionBase}${candidateExtension}`)) {
      return `${withoutExtension}${candidateExtension}`;
    }
  }
  if (await isDirectory(abs)) {
    for (const index of INDEX_FILES) {
      if (await isFile(join(abs, index))) return `${normalized}/${index}`;
    }
  }
  return null;
}

/**
 * Source-tree alternatives for an entry that names publish-only build output.
 * These are only accepted when a concrete file exists, and explicit package
 * metadata always wins before these fallbacks are tried.
 */
function sourceAlternatives(candidate: string): string[] {
  const normalized = normalizeCandidate(candidate);
  if (normalized == null) return [];
  const segments = normalized.split('/');
  if (!OUTPUT_DIRECTORIES.has(segments[0])) return [];
  const rest = segments.slice(1).join('/');
  return [`src/${rest}`, `source/${rest}`];
}

function withSourceAlternatives(candidates: string[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    out.push(candidate, ...sourceAlternatives(candidate));
  }
  return out;
}

/** Candidate paths for a bare `dep` specifier, best first. */
function rootCandidates(manifest: EntryManifest | null, condition: EntryCondition): string[] {
  if (manifest == null) return ['index.js'];
  const candidates: string[] = [];
  const exportsValue = isSubpathExports(manifest.exports)
    ? (manifest.exports as Record<string, unknown>)['.']
    : manifest.exports;
  candidates.push(...withSourceAlternatives(exportsTargets(exportsValue, condition)));
  if (manifest.source) candidates.push(manifest.source);
  if (condition === 'import') {
    if (manifest.module) candidates.push(manifest.module);
    if (manifest.main) candidates.push(manifest.main);
  } else {
    if (manifest.main) candidates.push(manifest.main);
    if (manifest.module) candidates.push(manifest.module);
  }
  candidates.push('index.js', 'src/index', 'source/index');
  return candidates;
}

function replaceStars(value: unknown, replacement: string): unknown {
  if (typeof value === 'string') return value.replaceAll('*', replacement);
  if (Array.isArray(value)) return value.map((entry) => replaceStars(entry, replacement));
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      replaceStars(entry, replacement),
    ]),
  );
}

function exportedSubpathValue(exports: Record<string, unknown>, subpath: string): unknown {
  const exact = exports[`./${subpath}`];
  if (exact !== undefined) return exact;

  const request = `./${subpath}`;
  for (const key of Object.keys(exports).sort((a, b) => b.length - a.length)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    const replacement = request.slice(prefix.length, request.length - suffix.length);
    return replaceStars(exports[key], replacement);
  }
  return undefined;
}

/** Candidate paths for a `dep/sub/path` specifier, best first. */
function subpathCandidates(
  manifest: EntryManifest | null,
  subpath: string,
  condition: EntryCondition,
): string[] {
  if (manifest != null && isSubpathExports(manifest.exports)) {
    const mapped = exportedSubpathValue(manifest.exports as Record<string, unknown>, subpath);
    // An exports map is an allowlist: unlisted subpaths must not resolve just
    // because a matching file exists on disk. Mapped targets still get the
    // dist → src fallbacks used for missing publish-only output.
    if (mapped === undefined) return [];
    return withSourceAlternatives(exportsTargets(mapped, condition));
  }
  return [subpath, `src/${subpath}`, `source/${subpath}`];
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
