import { satisfies } from '../semver/range.js';
import type { LockGraph } from '../types/lock-graph.js';

/** A recorded requirement the moved package's new version no longer meets. */
export type GraphRangeViolation = {
  /** Package that declares the requirement. */
  dependent: string;
  /** Name it depends on, which is the key of the edge that moved. */
  dependency: string;
  /** Range the dependent declares for it. */
  range: string;
};

export type RefreshGraphVersionInput = {
  graph: LockGraph;
  /** Package whose pin just moved; a key of `graph`. */
  name: string;
  /** `version` the rebuilt checkout's package.json now declares. */
  version: string;
};

export type RefreshGraphVersionResult = {
  /** Nodes to merge into `inrepo.lock.json#graph`; empty when nothing moved. */
  nodes: LockGraph;
  /** Dependents `version` no longer satisfies, ordered by dependent name. */
  violations: GraphRangeViolation[];
};

/**
 * Re-state one package's version in a recorded graph after its pin moved: the
 * node itself, plus the resolved version on every edge pointing at it.
 *
 * Ranges and the shape of the closure are deliberately left alone — only
 * `inrepo add --with-deps` re-resolves those — so a new version that falls
 * outside a dependent's range is reported back rather than papered over.
 */
export function refreshGraphVersion(input: RefreshGraphVersionInput): RefreshGraphVersionResult {
  const { graph, name, version } = input;
  const node = graph[name];
  if (!node) return { nodes: {}, violations: [] };

  const nodes: LockGraph = {};
  if (node.version !== version) nodes[name] = { ...node, version };

  const violations: GraphRangeViolation[] = [];
  for (const dependent of Object.keys(graph).sort()) {
    // A node updated above is the base for its own edges (a self-dependency).
    const current = nodes[dependent] ?? graph[dependent];
    const edges = current.dependencies;
    if (!edges) continue;

    const next = { ...edges };
    let changed = false;
    for (const dependency of Object.keys(edges).sort()) {
      const edge = edges[dependency];
      if (edge.module !== name) continue;
      if (!satisfies(version, edge.range)) {
        violations.push({ dependent, dependency, range: edge.range });
      }
      if (edge.version === version) continue;
      next[dependency] = { ...edge, version };
      changed = true;
    }
    if (changed) nodes[dependent] = { ...current, dependencies: next };
  }

  return { nodes, violations };
}
