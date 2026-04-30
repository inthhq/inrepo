import { isAbsolute, join } from 'node:path';

function assertSafePackagePathSegment(kind: string, value: string, name: string): void {
  if (!value) {
    throw new Error(`Invalid ${kind} in package name "${name}": segment is empty`);
  }
  if (isAbsolute(value)) {
    throw new Error(`Invalid ${kind} in package name "${name}": absolute paths are not allowed`);
  }

  const parts = value.split(/[\\/]/);
  if (parts.length !== 1) {
    throw new Error(`Invalid ${kind} in package name "${name}": path separators are not allowed`);
  }
  if (parts[0] === '.' || parts[0] === '..') {
    throw new Error(`Invalid ${kind} in package name "${name}": traversal segments are not allowed`);
  }
}

function packageTreePath(root: string, name: string): string {
  if (isAbsolute(name)) {
    throw new Error(`Invalid package name "${name}": absolute paths are not allowed`);
  }
  if (name.startsWith('@')) {
    const i = name.indexOf('/', 1);
    if (i === -1) {
      throw new Error(`Invalid scoped name (missing /): ${name}`);
    }
    const scope = name.slice(0, i);
    const pkg = name.slice(i + 1);
    if (!pkg) throw new Error(`Invalid scoped name: ${name}`);
    assertSafePackagePathSegment('scope', scope, name);
    assertSafePackagePathSegment('package segment', pkg, name);
    return join(root, scope, pkg);
  }
  assertSafePackagePathSegment('package segment', name, name);
  return join(root, name);
}

export function overlayDirPath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, 'inrepo_patches'), name);
}

export function overlayDeletionsPath(cwd: string, name: string): string {
  return join(overlayDirPath(cwd, name), '.inrepo-deletions');
}

export function cacheDirPath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, '.inrepo', 'cache'), name);
}

export function cacheMetaPath(cwd: string, name: string): string {
  return join(cacheDirPath(cwd, name), '.cache-meta.json');
}

export function moduleStatePath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, '.inrepo', 'state'), name) + '.json';
}

export function backupDirPath(cwd: string, name: string, iso: string): string {
  const safeName = name.replaceAll('/', '__');
  return join(cwd, '.inrepo', 'backups', `${safeName}-${iso}`);
}
