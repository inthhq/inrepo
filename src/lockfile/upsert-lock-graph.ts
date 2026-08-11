import type { LockGraph } from '../types/lock-graph.js';
import { readLockfile } from './read-lockfile.js';
import { writeLockfile } from './write-lockfile.js';

/**
 * Merge nodes into `inrepo.lock.json#graph`, replacing any node of the same
 * name and leaving unrelated nodes (other roots and their closures) alone.
 */
export async function upsertLockGraph(cwd: string, nodes: LockGraph): Promise<void> {
  const { modules, graph } = await readLockfile(cwd);
  for (const [name, node] of Object.entries(nodes)) {
    graph[name] = node;
  }
  await writeLockfile(cwd, modules, graph);
}
