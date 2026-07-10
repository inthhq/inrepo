import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { packageJsonPath } from '../paths/package-json-path.js';
import type { PackageJsonDependencyTarget } from '../types/inrepo-package.js';

export type PackageJsonDependencyLink = {
  name: string;
  target: PackageJsonDependencyTarget;
};

function localFilePackageSpecifier(cwd: string, packageName: string): string {
  const dest = moduleDestPath(cwd, packageName);
  const rel = relative(cwd, dest);
  const normalized = rel.split(sep).join('/');
  return `file:${normalized}`;
}

function ensureDepObject(
  data: Record<string, unknown>,
  key: PackageJsonDependencyTarget,
): Record<string, unknown> {
  let obj = data[key];
  if (obj === undefined) {
    obj = {};
    data[key] = obj;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`package.json "${key}" must be a JSON object when present`);
  }
  return obj as Record<string, unknown>;
}

async function readRootPackageJson(cwd: string): Promise<{
  data: Record<string, unknown>;
  path: string;
}> {
  const path = packageJsonPath(cwd);
  if (!existsSync(path)) {
    throw new Error('package.json is required when package.json dependency linking is configured');
  }

  const raw = await readFile(path, 'utf8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('package.json must be a JSON object');
  }

  for (const key of ['dependencies', 'devDependencies'] as const) {
    if (data[key] !== undefined) ensureDepObject(data, key);
  }
  if (
    data.packages != null &&
    (typeof data.packages !== 'object' || Array.isArray(data.packages))
  ) {
    throw new Error('package.json "packages" must be a JSON object when present');
  }

  return { data, path };
}

function pruneLegacyPackagesMap(data: Record<string, unknown>, packageName: string): void {
  const pkgs = data.packages;
  if (pkgs == null) return;
  if (typeof pkgs !== 'object' || pkgs === null || Array.isArray(pkgs)) {
    throw new Error('package.json "packages" must be a JSON object when present');
  }
  const packagesObj = pkgs as Record<string, unknown>;
  delete packagesObj[packageName];
  if (Object.keys(packagesObj).length === 0) {
    delete data.packages;
  }
}

/**
 * Validate package.json before vendoring whenever one or more configured packages request linking.
 */
export async function preflightRootPackageJsonDependencyLinks(
  cwd: string,
  links: PackageJsonDependencyLink[],
): Promise<void> {
  if (links.length === 0) return;
  await readRootPackageJson(cwd);
}

/**
 * Link only explicitly selected packages into root package.json in one write.
 * Unselected dependencies and legacy links are left untouched.
 */
export async function syncRootPackageJsonDependencies(
  cwd: string,
  links: PackageJsonDependencyLink[],
): Promise<void> {
  if (links.length === 0) return;
  const { data, path } = await readRootPackageJson(cwd);

  for (const link of links) {
    const primaryKey = link.target;
    const otherKey = primaryKey === 'devDependencies' ? 'dependencies' : 'devDependencies';

    const primary = ensureDepObject(data, primaryKey);
    primary[link.name] = localFilePackageSpecifier(cwd, link.name);

    if (data[otherKey] !== undefined) {
      const other = ensureDepObject(data, otherKey);
      delete other[link.name];
      if (Object.keys(other).length === 0) {
        delete data[otherKey];
      }
    }

    pruneLegacyPackagesMap(data, link.name);
  }

  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Link one package; retained as the focused single-package helper used by callers and tests. */
export async function upsertRootPackageJsonDependency(
  cwd: string,
  packageName: string,
  target: PackageJsonDependencyTarget,
): Promise<void> {
  await syncRootPackageJsonDependencies(cwd, [{ name: packageName, target }]);
}
