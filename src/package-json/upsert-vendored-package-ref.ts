import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { packageJsonPath } from '../paths/package-json-path.js';

function localFilePackageSpecifier(cwd: string, packageName: string): string {
  const dest = moduleDestPath(cwd, packageName);
  const rel = relative(cwd, dest);
  const normalized = rel.split(sep).join('/');
  return `file:${normalized}`;
}

function ensureDepObject(
  data: Record<string, unknown>,
  key: 'dependencies' | 'devDependencies',
): Record<string, unknown> {
  let obj = data[key];
  if (obj == null) {
    obj = {};
    data[key] = obj;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`package.json "${key}" must be a JSON object when present`);
  }
  return obj as Record<string, unknown>;
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
 * Set package.json#dependencies or #devDependencies[name] to a file: URL pointing at inrepo_modules.
 * Removes the name from the other deps bucket and from legacy package.json#packages.
 * No-op if package.json is missing (e.g. vendoring outside an npm project).
 */
export async function upsertRootPackageJsonDependency(
  cwd: string,
  packageName: string,
  dev: boolean,
): Promise<void> {
  const path = packageJsonPath(cwd);
  if (!existsSync(path)) return;

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

  const primaryKey = dev ? 'devDependencies' : 'dependencies';
  const otherKey = dev ? 'dependencies' : 'devDependencies';

  const primary = ensureDepObject(data, primaryKey);
  const specifier = localFilePackageSpecifier(cwd, packageName);
  primary[packageName] = specifier;

  if (data[otherKey] != null) {
    const other = data[otherKey];
    if (typeof other === 'object' && other !== null && !Array.isArray(other)) {
      delete (other as Record<string, unknown>)[packageName];
      if (Object.keys(other as Record<string, unknown>).length === 0) {
        delete data[otherKey];
      }
    }
  }

  pruneLegacyPackagesMap(data, packageName);

  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
