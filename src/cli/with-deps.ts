import { existsSync } from 'node:fs';
import {
  resolveDependencyGraph,
  type DependencyGraph,
  type ResolvedNode,
  type VendoredPackage,
} from '../deps/resolve-dependency-graph.js';
import { resolveVersionTag } from '../deps/resolve-version-tag.js';
import { readLockfile } from '../lockfile/read-lockfile.js';
import { ensurePristine } from '../overlay/cache.js';
import { readPackageManifest } from '../package-json/read-package-manifest.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { loadRegistryPackage } from '../registry/load-registry-package.js';
import { resolveGitUrlFromNpm } from '../registry/resolve-git-url-from-npm.js';
import type { InrepoPackage } from '../types/inrepo-package.js';
import type { LockModule } from '../types/lock-module.js';
import { mergedVendorExcludes, mergedVendorKeeps } from './vendor.js';
import type { PackageSpec } from './types.js';

export type WithDepsPlan = {
  graph: DependencyGraph;
  /** Dependencies that still need vendoring, in a stable order. */
  pending: ResolvedNode[];
  /** Dependencies an existing vendored pin already satisfied. */
  reused: ResolvedNode[];
};

export type PlanWithDepsInput = {
  root: PackageSpec;
  globalExclude: string[];
  globalKeep: string[];
};

/**
 * Describe an already vendored package well enough to dedupe against it, using
 * only committed state: its lockfile pin plus the checkout's package.json.
 */
async function describeVendored(
  cwd: string,
  name: string,
  entry: LockModule,
): Promise<VendoredPackage> {
  const dest = moduleDestPath(cwd, name);
  let version: string | null = null;
  let dependencies: Record<string, string> = {};
  if (existsSync(dest)) {
    try {
      const manifest = await readPackageManifest(dest);
      version = manifest?.version ?? null;
      dependencies = manifest?.dependencies ?? {};
    } catch {
      version = null;
    }
  }
  return {
    name,
    version,
    gitUrl: entry.gitUrl,
    ref: entry.ref,
    commit: entry.commit,
    dependencies,
  };
}

/**
 * Resolve the whole runtime dependency closure of `root` before anything is
 * written. Conflicts and unsupported sources throw here, so a failed
 * `--with-deps` leaves the project exactly as it was.
 */
export async function planWithDeps(
  cwd: string,
  input: PlanWithDepsInput,
): Promise<WithDepsPlan> {
  const { root, globalExclude, globalKeep } = input;
  const gitUrl = root.git?.trim() ? root.git.trim() : await resolveGitUrlFromNpm(root.name);

  const pristine = await ensurePristine({
    cwd,
    name: root.name,
    gitUrl,
    ref: root.ref?.trim() || null,
    commit: null,
    keep: mergedVendorKeeps(globalKeep, root),
    exclude: mergedVendorExcludes(globalExclude, root),
  });
  const manifest = await readPackageManifest(pristine.dir);

  const { modules } = await readLockfile(cwd);
  const vendored = new Map<string, VendoredPackage>();
  for (const [name, entry] of Object.entries(modules)) {
    if (name === root.name) continue;
    vendored.set(name, await describeVendored(cwd, name, entry));
  }

  const graph = await resolveDependencyGraph({
    root: {
      name: root.name,
      version: manifest?.version ?? null,
      gitUrl: pristine.gitUrl,
      ref: root.ref?.trim() || null,
      commit: pristine.commit,
      dependencies: manifest?.dependencies ?? {},
    },
    vendored,
    io: {
      loadRegistryPackage,
      resolveVersionTag: (url, name, version) => resolveVersionTag(url, name, version),
    },
  });

  return {
    graph,
    pending: graph.nodes.filter((node) => !node.root && !node.reused),
    reused: graph.nodes.filter((node) => node.reused),
  };
}

/** Turn a resolved dependency into the spec `materializePackage` expects. */
export function dependencySpec(
  node: ResolvedNode,
  dev: boolean,
  config: InrepoPackage | undefined,
): PackageSpec {
  return {
    name: node.name,
    git: node.gitUrl,
    ...(node.ref == null ? {} : { ref: node.ref }),
    dev,
    ...(config?.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config?.keep === undefined ? {} : { keep: config.keep }),
  };
}
