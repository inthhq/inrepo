import type { RegistryPackage } from "../registry/load-registry-package.js";
import { maxSatisfyingAll, satisfies } from "../semver/range.js";
import type { PublishedArtifact } from "../types/published-artifact.js";
import { classifyDependencySpecifier } from "./dependency-specifier.js";
import type { VersionTag } from "./resolve-version-tag.js";

/** Thrown for every resolution failure, so callers can report it without a stack. */
export class DependencyResolutionError extends Error {
  override readonly name = "DependencyResolutionError";
}

/** A package already vendored in this project, used to dedupe instead of re-pinning. */
export interface VendoredPackage {
  name: string;
  /** Storage identity under config, lockfile, and inrepo_modules. */
  module?: string;
  /** `version` from the vendored checkout's package.json; null when unreadable. */
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  ref: string | null;
  commit: string;
  /** Runtime dependency specifiers declared by the vendored checkout. */
  dependencies: Record<string, string>;
  artifact?: PublishedArtifact | null;
}

/** The package the user named, already resolved to a pinned upstream checkout. */
export interface GraphRoot {
  name: string;
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  ref: string | null;
  commit: string;
  dependencies: Record<string, string>;
  artifact?: PublishedArtifact | null;
}

export interface ResolvedNode {
  name: string;
  module: string;
  /** Exact published version; null only when the root checkout declares none. */
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  /** Tag or ref to pin. Null keeps the upstream default branch. */
  ref: string | null;
  commit: string;
  /** Runtime dependency specifiers exactly as the package declares them. */
  dependencies: Record<string, string>;
  artifact?: PublishedArtifact | null;
  root: boolean;
  /** True when an existing vendored pin already satisfied every requirement. */
  reused: boolean;
  /** Bare dependency name -> the exact resolved module instance. */
  resolvedDependencies: Record<string, ResolvedDependencyEdge>;
}

export interface ResolvedDependencyEdge {
  range: string;
  module: string;
  version: string | null;
}

export interface DependencyGraph {
  rootName: string;
  rootModule: string;
  /** Root first, then every transitive dependency sorted by name. */
  nodes: ResolvedNode[];
}

export interface GraphResolverIo {
  loadRegistryPackage: (name: string) => Promise<RegistryPackage>;
  resolveVersionPins: (
    manifest: RegistryPackage["manifests"][number],
    name: string
  ) => Promise<VersionTag[]>;
  resolveRepositoryDirectory: (input: {
    name: string;
    version: string;
    gitUrl: string;
    commit: string;
    repositoryDirectory: string | null;
  }) => Promise<string | null>;
}

export interface ResolveDependencyGraphInput {
  root: GraphRoot;
  /** Packages already vendored in this project, keyed by package name. */
  vendored: Map<string, VendoredPackage>;
  io: GraphResolverIo;
}

export const dependencyModuleId = function dependencyModuleId(
  name: string,
  version: string
): string {
  return `${name}@${version}`;
};

/**
 * Runtime dependency edges of one node, with every specifier validated.
 *
 * Only `dependencies` is walked: dev and peer dependencies are deliberately out
 * of scope, because neither is needed to run the vendored source.
 */
export const runtimeEdges = function runtimeEdges(
  name: string,
  dependencies: Record<string, string>
): { dependency: string; range: string }[] {
  const edges: { dependency: string; range: string }[] = [];
  for (const dependency of Object.keys(dependencies).toSorted()) {
    const specifier = dependencies[dependency];
    const classified = classifyDependencySpecifier(specifier);
    if (!classified.supported) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: "${name}" depends on "${dependency}" as "${specifier}" ` +
          `(${classified.reason}). Vendor it by hand with "inrepo add ${dependency} --git <url> --ref <ref>".`
      );
    }
    edges.push({ dependency, range: classified.range });
  }
  return edges;
};

export const resolveDependencyGraph = async function resolveDependencyGraph(
  input: ResolveDependencyGraphInput
): Promise<DependencyGraph> {
  const { root, vendored, io } = input;
  const resolved = new Map<string, ResolvedNode>();
  const registryCache = new Map<string, RegistryPackage>();

  const loadRegistry = async (name: string): Promise<RegistryPackage> => {
    const cached = registryCache.get(name);
    if (cached) {
      return cached;
    }
    const loaded = await io.loadRegistryPackage(name);
    registryCache.set(name, loaded);
    return loaded;
  };

  const resolveOne = async (
    name: string,
    range: string
  ): Promise<ResolvedNode> => {
    const existingCandidates = [...vendored.values()].filter(
      (candidate) => candidate.name === name && candidate.version != null
    );
    const existingVersion = maxSatisfyingAll(
      existingCandidates.flatMap((candidate) =>
        candidate.version == null ? [] : [candidate.version]
      ),
      [range]
    );
    const existing = existingCandidates.find(
      (candidate) => candidate.version === existingVersion
    );
    if (existing?.version != null) {
      const manifest = (await loadRegistry(name)).manifests.find(
        (entry) => entry.version === existing.version
      );
      return {
        artifact: manifest?.artifact ?? existing.artifact,
        commit: existing.commit,
        dependencies: existing.dependencies,
        gitUrl: existing.gitUrl,
        module: existing.module ?? existing.name,
        name,
        ref: existing.ref,
        repositoryDirectory: existing.repositoryDirectory,
        resolvedDependencies: {},
        reused: true,
        root: false,
        version: existing.version,
      };
    }

    const registryPackage = await loadRegistry(name);
    const versions = registryPackage.manifests.map(
      (manifest) => manifest.version
    );
    const picked = maxSatisfyingAll(versions, [range]);
    if (picked == null) {
      throw new DependencyResolutionError(
        `Cannot satisfy "${name}" ${range} in the dependency graph of "${root.name}".`
      );
    }

    const module = dependencyModuleId(name, picked);
    const alreadyResolved = resolved.get(module);
    if (alreadyResolved) {
      return alreadyResolved;
    }

    const manifest = registryPackage.manifests.find(
      (entry) => entry.version === picked
    );
    if (!manifest) {
      throw new DependencyResolutionError(
        `npm registry: no manifest for ${name}@${picked}`
      );
    }
    if (!manifest.gitUrl) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: "${name}@${picked}" has no usable "repository" clone URL on the npm registry. ` +
          `Vendor it by hand with "inrepo add ${name} --git <url> --ref <ref>".`
      );
    }

    const pins = await io.resolveVersionPins(manifest, name);
    if (pins.length === 0) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: no tag for "${name}@${picked}" in ${manifest.gitUrl} ` +
          `while resolving ${range}. ` +
          `Vendor it by hand with "inrepo add ${name} --git ${manifest.gitUrl} --ref <ref>".`
      );
    }
    let selected:
      | { pin: VersionTag; repositoryDirectory: string | null }
      | undefined;
    let lastSelectionError: unknown;
    for (const pin of pins) {
      try {
        const repositoryDirectory = await io.resolveRepositoryDirectory({
          commit: pin.commit,
          gitUrl: manifest.gitUrl,
          name,
          repositoryDirectory: manifest.repositoryDirectory,
          version: picked,
        });
        selected = { pin, repositoryDirectory };
        break;
      } catch (error) {
        lastSelectionError = error;
      }
    }
    if (!selected) {
      throw lastSelectionError instanceof Error
        ? lastSelectionError
        : new DependencyResolutionError(
            `Cannot select source for "${name}@${picked}"`
          );
    }

    // Validate this package's own specifiers now so an unsupported source in a
    // deeper level still fails before anything is written.
    runtimeEdges(name, manifest.dependencies);

    return {
      artifact: manifest.artifact,
      commit: selected.pin.commit,
      dependencies: manifest.dependencies,
      gitUrl: manifest.gitUrl,
      module,
      name,
      ref: selected.pin.ref,
      repositoryDirectory: selected.repositoryDirectory,
      resolvedDependencies: {},
      reused: false,
      root: false,
      version: picked,
    };
  };

  const rootNode: ResolvedNode = {
    artifact: root.artifact ?? null,
    commit: root.commit,
    dependencies: root.dependencies,
    gitUrl: root.gitUrl,
    module: root.name,
    name: root.name,
    ref: root.ref,
    repositoryDirectory: root.repositoryDirectory,
    resolvedDependencies: {},
    reused: false,
    root: true,
    version: root.version,
  };
  resolved.set(rootNode.module, rootNode);
  const queue = [rootNode];
  const expanded = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || expanded.has(current.module)) {
      continue;
    }
    expanded.add(current.module);
    for (const edge of runtimeEdges(current.name, current.dependencies)) {
      let target: ResolvedNode;
      if (
        edge.dependency === root.name &&
        root.version != null &&
        satisfies(root.version, edge.range)
      ) {
        target = rootNode;
      } else {
        const candidate = await resolveOne(edge.dependency, edge.range);
        target = resolved.get(candidate.module) ?? candidate;
        if (!resolved.has(candidate.module)) {
          resolved.set(candidate.module, candidate);
          queue.push(candidate);
        }
      }
      current.resolvedDependencies[edge.dependency] = {
        module: target.module,
        range: edge.range,
        version: target.version,
      };
    }
  }
  const dependencies = [...resolved.values()]
    .filter((node) => !node.root)
    .toSorted((a, b) => a.module.localeCompare(b.module));
  return {
    nodes: [rootNode, ...dependencies],
    rootModule: rootNode.module,
    rootName: root.name,
  };
};
