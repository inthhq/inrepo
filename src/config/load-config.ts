import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig as c12LoadConfig } from 'c12';
import type { LoadConfigOptions } from 'c12';
import { packageJsonPath } from '../paths/package-json-path.js';
import type { InrepoPackage } from '../types/inrepo-package.js';
import type { LoadedConfig } from '../types/loaded-config.js';
import { validateExcludeList } from './validate-exclude-list.js';
import { validateKeepList } from './validate-keep-list.js';

/** Thrown when neither inrepo.* nor package.json#inrepo declares inrepo config. */
export class LoadConfigNotFoundError extends Error {
  override readonly name = 'LoadConfigNotFoundError';
  constructor(message: string) {
    super(message);
  }
}

const ALLOWED_ROOT_KEYS = new Set(['packages', 'exclude', 'keep']);

/**
 * c12 may surface unrelated keys after merging layers (for example a `$env`
 * block when envName is disabled, or an unknown typo). We refuse those up
 * front so the documented schema stays the contract.
 */
function assertStrictInrepoRoot(parsed: unknown, label: string): void {
  if (parsed == null) return;
  if (Array.isArray(parsed)) return;
  if (typeof parsed !== 'object') {
    throw new Error(`${label} must be a JSON array or an object with a "packages" array`);
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      throw new Error(
        `${label} has unknown top-level key "${key}". Allowed keys: ${[...ALLOWED_ROOT_KEYS].join(', ')}.`,
      );
    }
  }
}

function rootExcludeFromParsed(parsed: unknown, label: string): string[] {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  return validateExcludeList((parsed as Record<string, unknown>).exclude, label);
}

function rootKeepFromParsed(parsed: unknown, label: string): string[] {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  return validateKeepList((parsed as Record<string, unknown>).keep, label);
}

function normalizePackagesArray(raw: unknown): unknown[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { packages?: unknown }).packages)) {
    return (raw as { packages: unknown[] }).packages;
  }
  throw new Error('Config must be a JSON array or an object with a "packages" array');
}

function validatePackage(entry: unknown, index: number): InrepoPackage {
  if (entry == null || typeof entry !== 'object') {
    throw new Error(`packages[${index}] must be an object`);
  }
  const rec = entry as Record<string, unknown>;
  const name = rec.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`packages[${index}].name is required and must be a non-empty string`);
  }
  const pkg: InrepoPackage = { name: name.trim() };
  if (rec.git != null) {
    if (typeof rec.git !== 'string' || !rec.git.trim()) {
      throw new Error(`packages[${index}].git must be a non-empty string when set`);
    }
    pkg.git = rec.git.trim();
  }
  if (rec.ref != null) {
    if (typeof rec.ref !== 'string' || !rec.ref.trim()) {
      throw new Error(`packages[${index}].ref must be a non-empty string when set`);
    }
    pkg.ref = rec.ref.trim();
  }
  if (rec.dev != null) {
    if (typeof rec.dev !== 'boolean') {
      throw new Error(`packages[${index}].dev must be a boolean when set`);
    }
    pkg.dev = rec.dev;
  }
  if (rec.exclude != null) {
    pkg.exclude = validateExcludeList(rec.exclude, `packages[${index}].exclude`);
  }
  if (rec.keep != null) {
    pkg.keep = validateKeepList(rec.keep, `packages[${index}].keep`);
  }
  return pkg;
}

/**
 * c12 options that pin inrepo's documented surface: configs live under the
 * `inrepo.{ext}` basename (or `.config/inrepo.{ext}`), no rcfile, no dotenv,
 * and no `$env`/`$development`/`$production` merging. Set per branch whether
 * the file or the `package.json#inrepo` field is the source of truth.
 */
const BASE_C12_OPTIONS: Partial<LoadConfigOptions> = {
  name: 'inrepo',
  configFile: 'inrepo',
  rcFile: false,
  dotenv: false,
  envName: false,
  globalRc: false,
};

type FileLayer = {
  parsed: unknown;
  configFile: string;
};

/**
 * Load via c12 from an `inrepo.*` file (any supported format). Returns null
 * when no such file resolves. We intentionally keep `packageJson` disabled so
 * the file branch never silently merges with `package.json#inrepo`.
 */
async function loadFromInrepoFile(cwd: string): Promise<FileLayer | null> {
  const r = await c12LoadConfig({
    ...BASE_C12_OPTIONS,
    cwd,
    packageJson: false,
  });
  if (!r._configFile) return null;
  return { parsed: r.config as unknown, configFile: r._configFile };
}

type PackageJsonLayer = {
  parsed: unknown;
};

/**
 * Read `package.json#inrepo` directly. The package.json branch never honours
 * c12 features like `extends` or extra formats — it is documented as a plain
 * JSON field and we keep it that way.
 */
async function loadFromPackageJson(cwd: string): Promise<PackageJsonLayer | null> {
  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) return null;
  let pkgJson: unknown;
  try {
    pkgJson = JSON.parse(await readFile(pkgPath, 'utf8')) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (pkgJson == null || typeof pkgJson !== 'object') {
    throw new Error('package.json must be a JSON object');
  }
  const inrepo = (pkgJson as Record<string, unknown>).inrepo;
  if (inrepo == null) return null;
  return { parsed: inrepo };
}

type RawConfigLayer = {
  parsed: unknown;
  /** Basename used in error messages and on `LoadedConfig.source`. */
  source: string;
  /** Label prefix for `exclude` / `keep` validation errors. */
  label: string;
};

async function readInrepoConfigLayer(cwd: string): Promise<RawConfigLayer | null> {
  const file = await loadFromInrepoFile(cwd);
  if (file) {
    const source = basename(file.configFile);
    return { parsed: file.parsed, source, label: source };
  }
  const pkg = await loadFromPackageJson(cwd);
  if (pkg) {
    return { parsed: pkg.parsed, source: 'package.json', label: 'package.json "inrepo"' };
  }
  return null;
}

/** Load declarative config from inrepo.* (preferred) or package.json#inrepo. */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const layer = await readInrepoConfigLayer(cwd);
  if (!layer) {
    throw new LoadConfigNotFoundError(
      'No inrepo config found. Create inrepo.json (or another supported inrepo.* file) or add an "inrepo" field to package.json.',
    );
  }
  assertStrictInrepoRoot(layer.parsed, layer.label);
  const packagesRaw = normalizePackagesArray(layer.parsed);
  const packages = packagesRaw.map((p, i) => validatePackage(p, i));
  const exclude = rootExcludeFromParsed(layer.parsed, `${layer.label} "exclude"`);
  const keep = rootKeepFromParsed(layer.parsed, `${layer.label} "keep"`);
  return { packages, exclude, keep, source: layer.source };
}

/**
 * Root `exclude` list only (no `packages` required). Used by `inrepo add` so
 * global excludes apply even when sync has not been run.
 */
export async function loadGlobalExclude(cwd: string): Promise<string[]> {
  const layer = await readInrepoConfigLayer(cwd);
  if (!layer) return [];
  assertStrictInrepoRoot(layer.parsed, layer.label);
  return rootExcludeFromParsed(layer.parsed, `${layer.label} "exclude"`);
}

/** Root `keep` list only. Used by `inrepo add` when full `loadConfig` is unavailable. */
export async function loadGlobalKeep(cwd: string): Promise<string[]> {
  const layer = await readInrepoConfigLayer(cwd);
  if (!layer) return [];
  assertStrictInrepoRoot(layer.parsed, layer.label);
  return rootKeepFromParsed(layer.parsed, `${layer.label} "keep"`);
}

/** True when loadConfig failed because no config file/field exists (safe to fall back to globals-only). */
export function isLoadConfigNotFoundError(e: unknown): boolean {
  return e instanceof LoadConfigNotFoundError;
}
