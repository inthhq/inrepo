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

/**
 * Set package.json#packages[name] to a file: URL pointing at inrepo_modules.
 * No-op if package.json is missing (e.g. vendoring outside an npm project).
 */
export async function upsertRootPackageJsonFilePackage(
  cwd: string,
  packageName: string,
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

  let pkgs = data.packages;
  if (pkgs == null) {
    pkgs = {};
    data.packages = pkgs;
  }
  if (typeof pkgs !== 'object' || pkgs === null || Array.isArray(pkgs)) {
    throw new Error('package.json "packages" must be a JSON object when present');
  }

  const packagesObj = pkgs as Record<string, unknown>;
  packagesObj[packageName] = localFilePackageSpecifier(cwd, packageName);

  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
