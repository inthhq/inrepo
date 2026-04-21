import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { lockfilePath } from '../paths/lockfile-path.js';
import type { LockModule } from '../types/lock-module.js';

type LockfileShape = {
  lockfileVersion?: unknown;
  modules?: unknown;
};

function assertLockModules(modules: unknown): Record<string, LockModule> {
  if (modules == null || typeof modules !== 'object' || Array.isArray(modules)) {
    throw new Error('inrepo.lock.json "modules" must be an object');
  }
  return modules as Record<string, LockModule>;
}

export async function readLockfile(cwd: string): Promise<{
  lockfileVersion: number;
  modules: Record<string, LockModule>;
}> {
  const p = lockfilePath(cwd);
  if (!existsSync(p)) {
    return { lockfileVersion: 1, modules: {} };
  }
  const raw = await readFile(p, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid inrepo.lock.json: ${err.message}`);
  }
  if (data == null || typeof data !== 'object') {
    throw new Error('inrepo.lock.json must be a JSON object');
  }
  const rec = data as LockfileShape;
  const lockfileVersion = rec.lockfileVersion;
  if (lockfileVersion !== 1) {
    throw new Error(`Unsupported lockfileVersion: ${String(lockfileVersion)}`);
  }
  return { lockfileVersion: 1, modules: assertLockModules(rec.modules) };
}
