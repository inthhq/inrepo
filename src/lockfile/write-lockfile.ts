import { writeFile } from "node:fs/promises";

import { lockfilePath } from "../paths/lockfile-path.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type { LockGraph } from "../types/lock-graph.js";
import type { LockModule } from "../types/lock-module.js";

/**
 * Write the lockfile. A project without a recorded dependency graph keeps
 * producing byte-identical version 1 output. A graph raises it to version 2;
 * any package below a repository root raises it to version 3; version-qualified
 * dependency instances raise it to version 4. Published artifact inputs raise
 * it to version 5 so older clients cannot silently omit required runtime files.
 */
export const writeLockfile = async function writeLockfile(
  cwd: string,
  modules: Record<string, LockModule>,
  graph: LockGraph = {}
): Promise<void> {
  const normalizedModules: Record<string, LockModule> = {};
  for (const [name, module] of Object.entries(modules)) {
    const repositoryDirectory =
      module.repositoryDirectory == null
        ? null
        : normalizeRepositoryDirectory(
            module.repositoryDirectory,
            `inrepo.lock.json modules["${name}"].repositoryDirectory`
          );
    const normalized: LockModule = {
      commit: module.commit,
      gitUrl: module.gitUrl,
      ref: module.ref,
      source: module.source,
      updatedAt: module.updatedAt,
    };
    if (repositoryDirectory != null) {
      normalized.repositoryDirectory = repositoryDirectory;
    }
    if (module.artifact != null) {
      normalized.artifact = module.artifact;
    }
    normalizedModules[name] = normalized;
  }
  const hasGraph = Object.keys(graph).length > 0;
  const hasRepositoryDirectory = Object.values(normalizedModules).some(
    (module) => module.repositoryDirectory != null
  );
  const hasModuleInstances = Object.entries(normalizedModules).some(
    ([module, entry]) => module !== entry.source
  );
  const hasPublishedArtifacts = Object.values(normalizedModules).some(
    (module) => module.artifact != null
  );
  let lockfileVersion = 1;
  if (hasGraph) {
    lockfileVersion = 2;
  }
  if (hasRepositoryDirectory) {
    lockfileVersion = 3;
  }
  if (hasModuleInstances) {
    lockfileVersion = 4;
  }
  if (hasPublishedArtifacts) {
    lockfileVersion = 5;
  }
  const payload = hasGraph
    ? { graph, lockfileVersion, modules: normalizedModules }
    : { lockfileVersion, modules: normalizedModules };
  const p = lockfilePath(cwd);
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
};
