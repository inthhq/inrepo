import { join } from 'node:path';

function packageTreePath(root: string, name: string): string {
  if (name.startsWith('@')) {
    const i = name.indexOf('/', 1);
    if (i === -1) {
      throw new Error(`Invalid scoped name (missing /): ${name}`);
    }
    const scope = name.slice(0, i);
    const pkg = name.slice(i + 1);
    if (!pkg) throw new Error(`Invalid scoped name: ${name}`);
    return join(root, scope, pkg);
  }
  return join(root, name);
}

export function overlayDirPath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, 'inrepo_patches'), name);
}

export function overlayDeletionsPath(cwd: string, name: string): string {
  return join(overlayDirPath(cwd, name), '.inrepo-deletions');
}

export function pristineDirPath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, '.inrepo', 'pristine'), name);
}

export function pristineMetaPath(cwd: string, name: string): string {
  return join(pristineDirPath(cwd, name), '.pristine-meta.json');
}

export function moduleStatePath(cwd: string, name: string): string {
  return packageTreePath(join(cwd, '.inrepo', 'state'), name) + '.json';
}

export function discardedDirPath(cwd: string, name: string, iso: string): string {
  const safeName = name.replaceAll('/', '__');
  return join(cwd, '.inrepo', 'discarded', `${safeName}-${iso}`);
}
