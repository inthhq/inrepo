import { join } from 'node:path';

export function lockfilePath(cwd: string): string {
  return join(cwd, 'inrepo.lock.json');
}
