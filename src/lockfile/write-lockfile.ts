import { writeFile } from 'node:fs/promises';
import { lockfilePath } from '../paths/lockfile-path.js';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';
import type { LockGraph } from '../types/lock-graph.js';
import type { LockModule } from '../types/lock-module.js';

/**
 * Write the lockfile. A project without a recorded dependency graph keeps
 * producing byte-identical version 1 output. A graph raises it to version 2;
 * any package below a repository root raises it to version 3; version-qualified
 * dependency instances raise it to version 4. Published artifact inputs raise
 * it to version 5 so older clients cannot silently omit required runtime files.
 */
export async function writeLockfile(
  cwd: string,
  modules: Record<string, LockModule>,
  graph: LockGraph = {},
): Promise<void> {
  const normalizedModules: Record<string, LockModule> = {};
  for (const [name, module] of Object.entries(modules)) {
    const repositoryDirectory =
      module.repositoryDirectory == null
        ? null
        : normalizeRepositoryDirectory(
            module.repositoryDirectory,
            `inrepo.lock.json modules["${name}"].repositoryDirectory`,
          );
    normalizedModules[name] = {
      ...module,
      ...(repositoryDirectory == null ? {} : { repositoryDirectory }),
    };
    if (repositoryDirectory == null) delete normalizedModules[name].repositoryDirectory;
  }
  const hasGraph = Object.keys(graph).length > 0;
  const hasRepositoryDirectory = Object.values(normalizedModules).some(
    (module) => module.repositoryDirectory != null,
  );
  const hasModuleInstances = Object.entries(normalizedModules).some(
    ([module, entry]) => module !== entry.source,
  );
  const hasPublishedArtifacts = Object.values(normalizedModules).some(
    (module) => module.artifact != null,
  );
  const lockfileVersion = hasPublishedArtifacts
    ? 5
    : hasModuleInstances
    ? 4
    : hasRepositoryDirectory
      ? 3
      : hasGraph
        ? 2
        : 1;
  const payload = hasGraph
    ? { lockfileVersion, modules: normalizedModules, graph }
    : { lockfileVersion, modules: normalizedModules };
  const p = lockfilePath(cwd);
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
