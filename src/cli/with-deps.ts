import { existsSync } from "node:fs";

import {
  DependencyResolutionError,
  resolveDependencyGraph,
} from "../deps/resolve-dependency-graph.js";
import type {
  DependencyGraph,
  ResolvedNode,
  VendoredPackage,
} from "../deps/resolve-dependency-graph.js";
import { resolveVersionPins } from "../deps/resolve-version-pin.js";
import { readLockfile } from "../lockfile/read-lockfile.js";
import {
  discoverRepositoryDirectory,
  ensurePristine,
} from "../overlay/cache.js";
import { readPackageManifest } from "../package-json/read-package-manifest.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { loadRegistryPackage } from "../registry/load-registry-package.js";
import { resolvePackageSourceFromNpm } from "../registry/resolve-git-url-from-npm.js";
import type { InrepoPackage } from "../types/inrepo-package.js";
import type { LockGraph, LockGraphNode } from "../types/lock-graph.js";
import type { LockModule } from "../types/lock-module.js";
import type { PackageSpec } from "./types.js";
import { mergedVendorExcludes, mergedVendorKeeps } from "./vendor.js";

export interface WithDepsPlan {
  graph: DependencyGraph;
  /** Dependencies that still need vendoring, in a stable order. */
  pending: ResolvedNode[];
  /** Dependencies an existing vendored pin already satisfied. */
  reused: ResolvedNode[];
}

export interface PlanWithDepsInput {
  root: PackageSpec;
  globalExclude: string[];
  globalKeep: string[];
}

export interface ExistingRootPin {
  gitUrl?: string;
  ref?: string | null;
  commit?: string;
}

export interface ResolvedRootPin {
  git?: string;
  ref?: string;
  commit: string | null;
}

/**
 * Prefer an explicit CLI git/ref (a moving tip). Otherwise stay on the
 * recorded lock/config pin, including its commit.
 */
export const resolveExistingRootPin = function resolveExistingRootPin(
  requested: Pick<PackageSpec, "git" | "ref" | "commit">,
  existing?: ExistingRootPin
): ResolvedRootPin {
  const explicitGit = requested.git?.trim() || undefined;
  const explicitRef = requested.ref?.trim() || undefined;
  const git = explicitGit ?? existing?.gitUrl?.trim() ?? undefined;
  // A new --git retargets the repo; do not keep the previous ref pin.
  const ref =
    explicitRef ??
    (explicitGit == null ? existing?.ref?.trim() || undefined : undefined);
  const movingTip = explicitGit != null || explicitRef != null;
  const commit =
    requested.commit ?? (movingTip ? null : (existing?.commit ?? null));
  return { commit, git, ref };
};

/** Reconstruct declared ranges from a recorded graph node. */
const lockGraphDependencyRanges = function lockGraphDependencyRanges(
  node: LockGraphNode | undefined
): Record<string, string> | null {
  if (node == null) {
    return null;
  }
  const dependencies: Record<string, string> = {};
  for (const [name, edge] of Object.entries(node.dependencies ?? {})) {
    dependencies[name] = edge.range;
  }
  return dependencies;
};

const publishedManifestDependencies =
  async function publishedManifestDependencies(
    name: string,
    version: string | null
  ): Promise<Record<string, string> | null> {
    if (version == null) {
      return null;
    }
    try {
      const registryPackage = await loadRegistryPackage(name);
      return (
        registryPackage.manifests.find(
          (manifest) => manifest.version === version
        )?.dependencies ?? null
      );
    } catch {
      // Offline and unpublished packages fall back to the lock graph or checkout.
      return null;
    }
  };

/**
 * Prefer already-published dependency ranges for a reused node:
 * lock-graph edges, then the packument, then the checkout manifest.
 *
 * Registry-sourced monorepo packages are planned from rewritten published
 * ranges and materialized from git, so the checkout may still say `workspace:*`.
 */
const describeVendored = async function describeVendored(
  cwd: string,
  module: string,
  entry: LockModule,
  graph: LockGraph
): Promise<VendoredPackage> {
  const name = entry.source;
  const dest = moduleDestPath(cwd, module);
  const graphNode = graph[module];
  let version: string | null = graphNode?.version ?? null;
  let checkoutDependencies: Record<string, string> = {};
  if (existsSync(dest)) {
    try {
      const manifest = await readPackageManifest(dest);
      version = manifest?.version ?? version;
      checkoutDependencies = manifest?.dependencies ?? {};
    } catch {
      // Keep the lock-graph version when the checkout manifest is unreadable.
    }
  }
  const dependencies =
    lockGraphDependencyRanges(graphNode) ??
    (await publishedManifestDependencies(name, version)) ??
    checkoutDependencies;
  return {
    artifact: entry.artifact ?? null,
    commit: entry.commit,
    dependencies,
    gitUrl: entry.gitUrl,
    module,
    name,
    ref: entry.ref,
    repositoryDirectory: entry.repositoryDirectory ?? null,
    version,
  };
};

/**
 * Resolve the whole runtime dependency closure of `root` before anything is
 * written. Conflicts and unsupported sources throw here, so a failed
 * `--with-deps` leaves the project exactly as it was.
 */
export const planWithDeps = async function planWithDeps(
  cwd: string,
  input: PlanWithDepsInput
): Promise<WithDepsPlan> {
  const { root, globalExclude, globalKeep } = input;
  const { modules, graph: lockGraph } = await readLockfile(cwd);
  const lockEntry = modules[root.name];
  const pin = resolveExistingRootPin(
    root,
    lockEntry == null
      ? undefined
      : {
          commit: lockEntry.commit,
          gitUrl: lockEntry.gitUrl,
          ref: lockEntry.ref,
        }
  );
  const source = pin.git
    ? { gitUrl: pin.git, repositoryDirectory: root.repositoryDirectory ?? null }
    : await resolvePackageSourceFromNpm(root.name);
  const repositoryDirectory =
    root.repositoryDirectory ?? source.repositoryDirectory;
  const { gitUrl } = source;
  const ref = pin.ref ?? null;

  const pristine = await ensurePristine({
    commit: pin.commit,
    cwd,
    exclude: mergedVendorExcludes(globalExclude, root),
    gitUrl,
    keep: mergedVendorKeeps(globalKeep, root),
    name: root.name,
    ref,
    repositoryDirectory,
  });
  const manifest = await readPackageManifest(pristine.dir);
  if (manifest == null) {
    throw new DependencyResolutionError(
      repositoryDirectory == null
        ? `Cannot resolve dependencies for "${root.name}": its pinned checkout has no package.json at the repository root. ` +
            "Monorepo package subdirectories are not supported yet."
        : `Cannot resolve dependencies for "${root.name}": its selected repository directory has no package.json.`
    );
  }
  if (manifest.name !== root.name) {
    let nameMismatch: string;
    if (manifest.name == null) {
      nameMismatch = `Cannot resolve dependencies for "${root.name}": its selected package.json has no name.`;
    } else if (repositoryDirectory == null) {
      nameMismatch =
        `Cannot resolve dependencies for "${root.name}": the repository root declares package "${manifest.name}". ` +
        "Monorepo package subdirectories are not supported yet.";
    } else {
      nameMismatch = `Cannot resolve dependencies for "${root.name}": the selected repository directory declares package "${manifest.name}".`;
    }
    throw new DependencyResolutionError(nameMismatch);
  }
  // `root.git` is only set when the user passed --git. A reused lock pin is
  // resolved above and must not flip this onto checkout workspace:/file: ranges.
  let dependencies =
    (root.git?.trim()
      ? null
      : (lockGraphDependencyRanges(lockGraph[root.name]) ??
        (await publishedManifestDependencies(root.name, manifest.version)))) ??
    manifest.dependencies;

  const dest = moduleDestPath(cwd, root.name);
  if (existsSync(dest)) {
    try {
      const patched = await readPackageManifest(dest);
      const patchedDeps = patched?.dependencies ?? {};
      const usesWorkspaceProtocol = Object.values(patchedDeps).some(
        (range) => range.startsWith("workspace:") || range.startsWith("file:")
      );
      if (patched != null && !usesWorkspaceProtocol) {
        dependencies = patchedDeps;
      }
    } catch {
      // Unreadable checkout: keep lock-graph / published / pristine ranges.
    }
  }

  const vendored = new Map<string, VendoredPackage>();
  for (const [module, entry] of Object.entries(modules)) {
    if (module === root.name) {
      continue;
    }
    vendored.set(module, await describeVendored(cwd, module, entry, lockGraph));
  }

  const graph = await resolveDependencyGraph({
    io: {
      loadRegistryPackage,
      resolveRepositoryDirectory: async (candidate) =>
        candidate.repositoryDirectory ??
        (await discoverRepositoryDirectory({ cwd, ...candidate })),
      resolveVersionPins: (packageManifest, name) =>
        resolveVersionPins(name, packageManifest),
    },
    root: {
      commit: pristine.commit,
      dependencies,
      gitUrl: pristine.gitUrl,
      name: root.name,
      ref,
      repositoryDirectory,
      version: manifest.version,
    },
    vendored,
  });

  return {
    graph,
    pending: graph.nodes.filter((node) => !node.root && !node.reused),
    reused: graph.nodes.filter((node) => node.reused),
  };
};

/** Turn a resolved dependency into the spec `materializePackage` expects. */
export const dependencySpec = function dependencySpec(
  node: ResolvedNode,
  dev: boolean,
  config: InrepoPackage | undefined
): PackageSpec {
  const spec: PackageSpec = {
    dev,
    git: node.gitUrl,
    module: node.module,
    name: node.name,
  };
  if (node.artifact != null) {
    spec.artifact = node.artifact;
  }
  if (config?.exclude !== undefined) {
    spec.exclude = config.exclude;
  }
  if (config?.keep !== undefined) {
    spec.keep = config.keep;
  }
  if (node.ref != null) {
    spec.ref = node.ref;
  }
  if (node.repositoryDirectory != null) {
    spec.repositoryDirectory = node.repositoryDirectory;
  }
  return spec;
};

/**
 * Prepare and validate every newly selected dependency subtree before config,
 * graph, or generated module state is mutated.
 */
export const preflightWithDeps = async function preflightWithDeps(
  cwd: string,
  plan: WithDepsPlan,
  input: {
    dev: boolean;
    globalExclude: string[];
    globalKeep: string[];
    configByName: Map<string, InrepoPackage>;
  }
): Promise<void> {
  for (const node of plan.pending) {
    const spec = dependencySpec(
      node,
      input.dev,
      input.configByName.get(node.module)
    );
    const pristine = await ensurePristine({
      artifact: node.artifact,
      commit: node.commit,
      cwd,
      exclude: mergedVendorExcludes(input.globalExclude, spec),
      gitUrl: node.gitUrl,
      keep: mergedVendorKeeps(input.globalKeep, spec),
      name: node.name,
      ref: node.ref,
      repositoryDirectory: node.repositoryDirectory,
    });
    const manifest = await readPackageManifest(pristine.dir);
    if (manifest == null) {
      if (node.repositoryDirectory == null) {
        continue;
      }
      throw new DependencyResolutionError(
        `Cannot vendor "${node.name}": its selected repository directory has no package.json.`
      );
    }
    if (manifest.name !== node.name) {
      throw new DependencyResolutionError(
        manifest.name == null
          ? `Cannot vendor "${node.name}": its selected repository directory package.json has no name.`
          : `Cannot vendor "${node.name}": its selected repository directory declares package "${manifest.name}".`
      );
    }
  }
};
