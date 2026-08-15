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

/**
 * Reorder packages so every recorded dependency is vendored before the package
 * that needs it.
 *
 * Import rewiring resolves a dependency's entry point from its vendored
 * checkout, so a dependent must never be assembled first; ordering the work this
 * way keeps the generated result identical whether `inrepo_modules/` was already
 * populated or is being rebuilt from nothing. Packages outside the graph keep
 * their original order, and a dependency cycle falls back to it rather than
 * dropping a package.
 */
export function orderByDependencies<T extends { name: string; module?: string }>(
  packages: T[],
  graph: LockGraph,
): T[] {
  const byName = new Map(packages.map((pkg) => [pkg.module ?? pkg.name, pkg] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const out: T[] = [];

  const visit = (name: string): void => {
    if (state.has(name)) return;
    state.set(name, 'visiting');
    for (const dependency of Object.keys(graph[name]?.dependencies ?? {}).sort()) {
      const edge = graph[name]?.dependencies?.[dependency];
      if (edge && byName.has(edge.module)) visit(edge.module);
    }
    state.set(name, 'done');
    const pkg = byName.get(name);
    if (pkg) out.push(pkg);
  };

  for (const pkg of packages) visit(pkg.module ?? pkg.name);
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
