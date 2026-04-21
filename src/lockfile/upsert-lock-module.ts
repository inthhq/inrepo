import type { LockModule } from '../types/lock-module.js';
import { readLockfile } from './read-lockfile.js';
import { writeLockfile } from './write-lockfile.js';

export async function upsertLockModule(
  cwd: string,
  name: string,
  entry: LockModule,
): Promise<void> {
  const { modules } = await readLockfile(cwd);
  modules[name] = entry;
  await writeLockfile(cwd, modules);
}
