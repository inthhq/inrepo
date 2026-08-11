import { writeFile } from 'node:fs/promises';
import { lockfilePath } from '../paths/lockfile-path.js';
import type { LockGraph } from '../types/lock-graph.js';
import type { LockModule } from '../types/lock-module.js';

/**
 * Write the lockfile. A project without a recorded dependency graph keeps
 * producing byte-identical version 1 output; the version is only raised to 2
 * once there is a `graph` section to describe.
 */
export async function writeLockfile(
  cwd: string,
  modules: Record<string, LockModule>,
  graph: LockGraph = {},
): Promise<void> {
  const hasGraph = Object.keys(graph).length > 0;
  const payload = hasGraph
    ? { lockfileVersion: 2, modules, graph }
    : { lockfileVersion: 1, modules };
  const p = lockfilePath(cwd);
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
