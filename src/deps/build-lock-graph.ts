import type { LockGraph, LockGraphEdge, LockGraphNode } from '../types/lock-graph.js';
import { runtimeEdges, type DependencyGraph } from './resolve-dependency-graph.js';

/**
 * Flatten a resolved closure into the `graph` section of `inrepo.lock.json`.
 *
 * Every edge names the module directory that holds the resolved version, so a
 * later pass can map a bare specifier to a vendored package without consulting
 * the registry.
 */
export function buildLockGraph(graph: DependencyGraph): LockGraph {
  const versions = new Map(graph.nodes.map((node) => [node.name, node.version] as const));
  const out: LockGraph = {};

  for (const node of graph.nodes) {
    const entry: LockGraphNode = {};
    if (node.version != null) entry.version = node.version;
    if (node.root) entry.root = true;

    const dependencies: Record<string, LockGraphEdge> = {};
    for (const edge of runtimeEdges(node.name, node.dependencies)) {
      if (!versions.has(edge.dependency)) continue;
      const version = versions.get(edge.dependency) ?? null;
      dependencies[edge.dependency] = {
        range: edge.range,
        module: edge.dependency,
        ...(version == null ? {} : { version }),
      };
    }
    if (Object.keys(dependencies).length > 0) entry.dependencies = dependencies;

    out[node.name] = entry;
  }

  return out;
}
