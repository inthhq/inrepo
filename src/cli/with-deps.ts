import { existsSync } from 'node:fs';
import {
  DependencyResolutionError,
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

export type ExistingRootPin = {
  gitUrl?: string;
  ref?: string | null;
  commit?: string;
};

/**
 * Prefer an explicit CLI git/ref (a moving tip). Otherwise stay on the
 * recorded lock/config pin, including its commit.
 */
export function resolveExistingRootPin(
  requested: Pick<PackageSpec, 'git' | 'ref' | 'commit'>,
  existing?: ExistingRootPin,
): { git?: string; ref?: string; commit: string | null } {
  const explicitGit = requested.git?.trim() || undefined;
  const explicitRef = requested.ref?.trim() || undefined;
  const git = explicitGit ?? existing?.gitUrl?.trim() ?? undefined;
  // A new --git retargets the repo; do not keep the previous ref pin.
  const ref =
    explicitRef ?? (explicitGit != null ? undefined : (existing?.ref?.trim() || undefined));
  const movingTip = explicitGit != null || explicitRef != null;
  const commit = requested.commit ?? (movingTip ? null : (existing?.commit ?? null));
  return { git, ref, commit };
}

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
    repositoryDirectory: entry.repositoryDirectory ?? null,
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
  const { modules } = await readLockfile(cwd);
  const lockEntry = modules[root.name];
  const pin = resolveExistingRootPin(
    root,
    lockEntry == null
      ? undefined
      : { gitUrl: lockEntry.gitUrl, ref: lockEntry.ref, commit: lockEntry.commit },
  );
  const gitUrl = pin.git || (await resolveGitUrlFromNpm(root.name));
  const ref = pin.ref ?? null;

  const pristine = await ensurePristine({
    cwd,
    name: root.name,
    gitUrl,
    ref,
    commit: pin.commit,
    keep: mergedVendorKeeps(globalKeep, root),
    exclude: mergedVendorExcludes(globalExclude, root),
  });
  const manifest = await readPackageManifest(pristine.dir);
  if (manifest == null) {
    throw new DependencyResolutionError(
      `Cannot resolve dependencies for "${root.name}": its pinned checkout has no package.json at the repository root. ` +
        'Monorepo package subdirectories are not supported yet.',
    );
  }
  if (manifest.name != null && manifest.name !== root.name) {
    throw new DependencyResolutionError(
      `Cannot resolve dependencies for "${root.name}": the repository root declares package "${manifest.name}". ` +
        'Monorepo package subdirectories are not supported yet.',
    );
  }

  // The generated checkout is the patched tree (series already applied). Prefer
  // its dependencies over the pristine cache so a committed series that edits
  // package.json#dependencies is visible to graph resolution.
  const dest = moduleDestPath(cwd, root.name);
  let dependencies = manifest.dependencies;
  if (existsSync(dest)) {
    try {
      const patched = await readPackageManifest(dest);
      if (patched != null) dependencies = patched.dependencies;
    } catch {
      // Unreadable checkout: fall back to the pristine manifest.
    }
  }

  const vendored = new Map<string, VendoredPackage>();
  for (const [name, entry] of Object.entries(modules)) {
    if (name === root.name) continue;
    vendored.set(name, await describeVendored(cwd, name, entry));
  }

  const graph = await resolveDependencyGraph({
    root: {
      name: root.name,
      version: manifest.version,
      gitUrl: pristine.gitUrl,
      repositoryDirectory: root.repositoryDirectory ?? null,
      ref,
      commit: pristine.commit,
      dependencies,
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
    ...(node.repositoryDirectory == null
      ? {}
      : { repositoryDirectory: node.repositoryDirectory }),
    ...(node.ref == null ? {} : { ref: node.ref }),
    dev,
    ...(config?.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config?.keep === undefined ? {} : { keep: config.keep }),
  };
}
