import { isLoadConfigNotFoundError, loadConfig } from '../config/load-config.js';
import { dependencyModules, readVendoredGraph } from '../deps/vendored-graph.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { loadEntryManifest } from './resolve-vendored-entry.js';
import type { RewireDependency, RewirePlan } from './rewire-tree.js';

/**
 * Resolve the import-rewiring plan for one package, or null when the transform
 * is switched off or the package has no vendored dependencies to point at.
 *
 * Every input is committed state — the inrepo config, `inrepo.lock.json#graph`,
 * and the vendored dependency checkouts — so `sync` and `verify` derive the same
 * plan offline.
 */
export async function loadRewirePlan(cwd: string, name: string): Promise<RewirePlan | null> {
  let enabled: boolean;
  try {
    const config = await loadConfig(cwd);
    const pkg = config.packages.find((entry) => entry.name === name);
    enabled = pkg?.rewireImports ?? config.rewireImports;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    return null;
  }
  if (!enabled) return null;

  const graph = await readVendoredGraph(cwd);
  const modules = dependencyModules(graph, name);
  const names = Object.keys(modules).sort();
  if (names.length === 0) return null;

  const dependencies = new Map<string, RewireDependency>();
  for (const dependency of names) {
    const moduleName = modules[dependency];
    const root = moduleDestPath(cwd, moduleName);
    dependencies.set(dependency, {
      modulePath: moduleName,
      root,
      manifest: await loadEntryManifest(root),
    });
  }

  return { name, modulePath: name, dependencies };
}
