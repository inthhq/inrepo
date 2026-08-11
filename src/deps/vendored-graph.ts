import { readLockfile } from '../lockfile/read-lockfile.js';
import type { LockGraph } from '../types/lock-graph.js';

/**
 * Read the recorded dependency graph. This is the offline entry point: it only
 * touches `inrepo.lock.json`, so `sync` and `verify` can replay a committed
 * graph with no registry or network access.
 */
export async function readVendoredGraph(cwd: string): Promise<LockGraph> {
  return (await readLockfile(cwd)).graph;
}

/** Packages the user vendored by name, as opposed to pulling in as a dependency. */
export function graphRoots(graph: LockGraph): string[] {
  return Object.keys(graph)
    .filter((name) => graph[name].root === true)
    .sort();
}

/**
 * Map one package's runtime dependency names onto the vendored module that
 * holds each of them: `{ "picocolors": "picocolors" }`. Returns an empty map
 * for a package that is not in the graph or has no recorded dependencies.
 */
export function dependencyModules(graph: LockGraph, name: string): Record<string, string> {
  const dependencies = graph[name]?.dependencies ?? {};
  const out: Record<string, string> = {};
  for (const [dependency, edge] of Object.entries(dependencies)) {
    out[dependency] = edge.module;
  }
  return out;
}

/** Every package in the graph reachable from `name`, including `name` itself. */
export function graphClosure(graph: LockGraph, name: string): string[] {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current) || graph[current] == null) continue;
    seen.add(current);
    for (const edge of Object.values(graph[current].dependencies ?? {})) {
      queue.push(edge.module);
    }
  }
  return [...seen].sort();
}
