import type {
  LockGraph,
  LockGraphEdge,
  LockGraphNode,
} from "../types/lock-graph.js";
import type { DependencyGraph } from "./resolve-dependency-graph.js";

/**
 * Flatten a resolved closure into the `graph` section of `inrepo.lock.json`.
 *
 * Every edge names the module directory that holds the resolved version, so a
 * later pass can map a bare specifier to a vendored package without consulting
 * the registry.
 */
export const buildLockGraph = function buildLockGraph(
  graph: DependencyGraph
): LockGraph {
  const out: LockGraph = {};

  for (const node of graph.nodes) {
    const entry: LockGraphNode = {};
    if (node.version != null) {
      entry.version = node.version;
    }
    if (node.root) {
      entry.root = true;
    }

    const dependencies: Record<string, LockGraphEdge> = {};
    for (const [dependency, edge] of Object.entries(
      node.resolvedDependencies
    )) {
      const graphEdge: LockGraphEdge = {
        module: edge.module,
        range: edge.range,
      };
      if (edge.version != null) {
        graphEdge.version = edge.version;
      }
      dependencies[dependency] = graphEdge;
    }
    if (Object.keys(dependencies).length > 0) {
      entry.dependencies = dependencies;
    }

    out[node.module] = entry;
  }

  return out;
};
