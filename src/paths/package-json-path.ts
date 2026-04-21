import { join } from 'node:path';

export function packageJsonPath(cwd: string): string {
  return join(cwd, 'package.json');
}
