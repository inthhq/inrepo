import { writeFile } from 'node:fs/promises';
import { lockfilePath } from '../paths/lockfile-path.js';
import type { LockModule } from '../types/lock-module.js';

export async function writeLockfile(
  cwd: string,
  modules: Record<string, LockModule>,
): Promise<void> {
  const payload = {
    lockfileVersion: 1,
    modules,
  };
  const p = lockfilePath(cwd);
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
