import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inrepoConfigPath } from '../paths/inrepo-config-path.js';
import { packageJsonPath } from '../paths/package-json-path.js';
import type { InrepoPackage } from '../types/inrepo-package.js';
import type { LoadedConfig } from '../types/loaded-config.js';
import { validateExcludeList } from './validate-exclude-list.js';
import { validateKeepList } from './validate-keep-list.js';

/** Thrown when neither inrepo.json nor package.json declares inrepo config. */
export class LoadConfigNotFoundError extends Error {
  override readonly name = 'LoadConfigNotFoundError';
  constructor(message: string) {
    super(message);
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
  if (typeof raw === 'object' && raw !== null) {
    const pkgs = (raw as { packages?: unknown }).packages;
    if (pkgs == null) return [];
    if (Array.isArray(pkgs)) return pkgs;
    throw new Error('Config "packages" must be a JSON array');
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

/** Load declarative config from inrepo.json (preferred) or package.json#inrepo. */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const inrepoPath = inrepoConfigPath(cwd);
  if (existsSync(inrepoPath)) {
    const contents = await readFile(inrepoPath, 'utf8');
    if (!contents.trim()) {
      throw new Error(`${inrepoPath} is empty`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`Invalid JSON in inrepo.json: ${err.message}`);
    }
    const packagesRaw = Array.isArray(parsed) ? parsed : normalizePackagesArray(parsed);
    const packages = packagesRaw.map((p, i) => validatePackage(p, i));
    const exclude = rootExcludeFromParsed(parsed, 'inrepo.json "exclude"');
    const keep = rootKeepFromParsed(parsed, 'inrepo.json "keep"');
    return { packages, exclude, keep, source: 'inrepo.json' };
  }

  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) {
    throw new LoadConfigNotFoundError(
      'No inrepo.json or package.json found. Create inrepo.json or add an "inrepo" field to package.json.',
    );
  }
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
  if (inrepo == null) {
    throw new LoadConfigNotFoundError('No inrepo.json and package.json has no "inrepo" field.');
  }
  const packagesRaw = Array.isArray(inrepo) ? inrepo : normalizePackagesArray(inrepo);
  const packages = packagesRaw.map((p, i) => validatePackage(p, i));
  const exclude = rootExcludeFromParsed(inrepo, 'package.json "inrepo.exclude"');
  const keep = rootKeepFromParsed(inrepo, 'package.json "inrepo.keep"');
  return { packages, exclude, keep, source: 'package.json' };
}

/**
 * Parsed root for global `exclude` / `keep`: prefer inrepo.json, else package.json#inrepo object.
 * Returns null when there is nothing to read (same empty-array behavior as before).
 */
async function readGlobalInrepoRaw(
  cwd: string,
): Promise<{ parsed: unknown; source: 'inrepo.json' | 'package.json' } | null> {
  const inrepoPath = inrepoConfigPath(cwd);
  if (existsSync(inrepoPath)) {
    const contents = await readFile(inrepoPath, 'utf8');
    if (!contents.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`Invalid JSON in inrepo.json: ${err.message}`);
    }
    return { parsed, source: 'inrepo.json' };
  }

  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) return null;
  let pkgJson: unknown;
  try {
    pkgJson = JSON.parse(await readFile(pkgPath, 'utf8')) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (pkgJson == null || typeof pkgJson !== 'object') return null;
  const inrepo = (pkgJson as Record<string, unknown>).inrepo;
  if (inrepo == null || typeof inrepo !== 'object' || Array.isArray(inrepo)) {
    return null;
  }
  return { parsed: inrepo, source: 'package.json' };
}

/**
 * Root `exclude` list only (no `packages` required). Used by `inrepo add` so global
 * excludes apply even when sync has not been run.
 */
export async function loadGlobalExclude(cwd: string): Promise<string[]> {
  const ctx = await readGlobalInrepoRaw(cwd);
  if (!ctx) return [];
  const label =
    ctx.source === 'inrepo.json' ? 'inrepo.json "exclude"' : 'package.json "inrepo.exclude"';
  return rootExcludeFromParsed(ctx.parsed, label);
}

/**
 * Root `keep` list only. Used by `inrepo add` when full `loadConfig` is unavailable.
 */
export async function loadGlobalKeep(cwd: string): Promise<string[]> {
  const ctx = await readGlobalInrepoRaw(cwd);
  if (!ctx) return [];
  const label =
    ctx.source === 'inrepo.json' ? 'inrepo.json "keep"' : 'package.json "inrepo.keep"';
  return rootKeepFromParsed(ctx.parsed, label);
}

/** True when loadConfig failed because no config file/field exists (safe to fall back to globals-only). */
export function isLoadConfigNotFoundError(e: unknown): boolean {
  return e instanceof LoadConfigNotFoundError;
}
