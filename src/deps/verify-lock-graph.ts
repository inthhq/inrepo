import { satisfies } from '../semver/range.js';
import type { LockGraph } from '../types/lock-graph.js';

export type VerifyLockGraphInput = {
  graph: LockGraph;
  /** Package names present in `inrepo.lock.json#modules`. */
  moduleNames: Set<string>;
  /**
   * `version` read from each vendored checkout's package.json. A null value
   * means the file is absent or declares no version, which `keep`/`exclude`
   * can legitimately cause, so it is not treated as drift.
   */
  vendoredVersions: Map<string, string | null>;
};

/**
 * Check a committed dependency graph against the lockfile and the vendored
 * checkouts. Purely offline: every input is read from files this project
 * already commits, so `inrepo verify` never contacts the npm registry.
 */
export function verifyLockGraph(input: VerifyLockGraphInput): string[] {
  const { graph, moduleNames, vendoredVersions } = input;
  const errors: string[] = [];

  for (const name of Object.keys(graph).sort()) {
    const node = graph[name];
    if (!moduleNames.has(name)) {
      errors.push(`"${name}" is in the dependency graph but not in inrepo.lock.json "modules"`);
    }

    const vendoredVersion = vendoredVersions.get(name) ?? null;
    if (node.version != null && vendoredVersion != null && vendoredVersion !== node.version) {
      errors.push(
        `"${name}": vendored version ${vendoredVersion} does not match graph version ${node.version}`,
      );
    }

    for (const [dependency, edge] of Object.entries(node.dependencies ?? {}).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const target = graph[edge.module];
      if (!target) {
        errors.push(
          `"${name}" depends on "${dependency}" resolved to module "${edge.module}", which is not in the dependency graph`,
        );
        continue;
      }
      if (edge.version != null && target.version != null && edge.version !== target.version) {
        errors.push(
          `"${name}" depends on "${dependency}" at ${edge.version}, but "${edge.module}" is vendored at ${target.version}`,
        );
      }
      const resolvedVersion = edge.version ?? target.version;
      if (resolvedVersion != null && !satisfies(resolvedVersion, edge.range)) {
        errors.push(
          `"${name}" depends on "${dependency}" ${edge.range}, which ${resolvedVersion} does not satisfy`,
        );
      }
    }
  }

  return errors;
}
