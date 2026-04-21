import { join } from 'node:path';

/**
 * @param cwd Project root
 * @param name npm package / module name (e.g. lodash, @babel/core)
 */
export function moduleDestPath(cwd: string, name: string): string {
  if (name.startsWith('@')) {
    const i = name.indexOf('/', 1);
    if (i === -1) {
      throw new Error(`Invalid scoped name (missing /): ${name}`);
    }
    const scope = name.slice(0, i);
    const pkg = name.slice(i + 1);
    if (!pkg) throw new Error(`Invalid scoped name: ${name}`);
    return join(cwd, 'inrepo_modules', scope, pkg);
  }
  return join(cwd, 'inrepo_modules', name);
}
