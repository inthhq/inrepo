import { join } from 'node:path';

export function inrepoConfigPath(cwd: string): string {
  return join(cwd, 'inrepo.json');
}
