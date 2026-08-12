import type { RegistryPackage } from '../registry/load-registry-package.js';
import { maxSatisfyingAll, satisfies } from '../semver/range.js';
import { classifyDependencySpecifier } from './dependency-specifier.js';
import type { VersionTag } from './resolve-version-tag.js';

/** Thrown for every resolution failure, so callers can report it without a stack. */
export class DependencyResolutionError extends Error {
  override readonly name = 'DependencyResolutionError';
}

/** A package already vendored in this project, used to dedupe instead of re-pinning. */
export type VendoredPackage = {
  name: string;
  /** `version` from the vendored checkout's package.json; null when unreadable. */
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  ref: string | null;
  commit: string;
  /** Runtime dependency specifiers declared by the vendored checkout. */
  dependencies: Record<string, string>;
};

/** The package the user named, already resolved to a pinned upstream checkout. */
export type GraphRoot = {
  name: string;
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  ref: string | null;
  commit: string;
  dependencies: Record<string, string>;
};

export type ResolvedNode = {
  name: string;
  /** Exact published version; null only when the root checkout declares none. */
  version: string | null;
  gitUrl: string;
  repositoryDirectory: string | null;
  /** Tag or ref to pin. Null keeps the upstream default branch. */
  ref: string | null;
  commit: string;
  /** Runtime dependency specifiers exactly as the package declares them. */
  dependencies: Record<string, string>;
  root: boolean;
  /** True when an existing vendored pin already satisfied every requirement. */
  reused: boolean;
};

export type DependencyGraph = {
  rootName: string;
  /** Root first, then every transitive dependency sorted by name. */
  nodes: ResolvedNode[];
};

export type DependencyOrigin = {
  /** Package that declared the requirement. */
  from: string;
  /** Specifier it declared, normalized to a semver range. */
  range: string;
};

export type GraphResolverIo = {
  loadRegistryPackage(name: string): Promise<RegistryPackage>;
  resolveVersionTag(gitUrl: string, name: string, version: string): Promise<VersionTag | null>;
};

export type ResolveDependencyGraphInput = {
  root: GraphRoot;
  /** Packages already vendored in this project, keyed by package name. */
  vendored: Map<string, VendoredPackage>;
  io: GraphResolverIo;
};

// Each pass may only change resolutions that a previous pass pulled in, so the
// loop converges quickly; the cap only guards against pathological metadata.
const MAX_PASSES = 64;

function formatOrigins(origins: DependencyOrigin[]): string {
  return origins.map((origin) => `  ${origin.from} requires ${origin.range}`).join('\n');
}

/**
 * Runtime dependency edges of one node, with every specifier validated.
 *
 * Only `dependencies` is walked: dev and peer dependencies are deliberately out
 * of scope, because neither is needed to run the vendored source.
 */
export function runtimeEdges(
  name: string,
  dependencies: Record<string, string>,
): Array<{ dependency: string; range: string }> {
  const edges: Array<{ dependency: string; range: string }> = [];
  for (const dependency of Object.keys(dependencies).sort()) {
    const specifier = dependencies[dependency];
    const classified = classifyDependencySpecifier(specifier);
    if (!classified.supported) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: "${name}" depends on "${dependency}" as "${specifier}" ` +
          `(${classified.reason}). Vendor it by hand with "inrepo add ${dependency} --git <url> --ref <ref>".`,
      );
    }
    edges.push({ dependency, range: classified.range });
  }
  return edges;
}

/**
 * Requirements reachable from the root through the packages resolved so far.
 * Rebuilt from scratch on every pass so a changed version never leaves stale
 * edges behind.
 */
function collectRequirements(
  root: GraphRoot,
  resolved: Map<string, ResolvedNode>,
): Map<string, DependencyOrigin[]> {
  const requirements = new Map<string, DependencyOrigin[]>();
  const queue: Array<{ name: string; dependencies: Record<string, string> }> = [
    { name: root.name, dependencies: root.dependencies },
  ];
  const seen = new Set<string>([root.name]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const edge of runtimeEdges(current.name, current.dependencies)) {
      if (edge.dependency === root.name) continue;
      const origins = requirements.get(edge.dependency) ?? [];
      origins.push({ from: current.name, range: edge.range });
      requirements.set(edge.dependency, origins);
      if (seen.has(edge.dependency)) continue;
      seen.add(edge.dependency);
      const node = resolved.get(edge.dependency);
      if (node) queue.push({ name: node.name, dependencies: node.dependencies });
    }
  }
  return requirements;
}

function satisfiesAll(version: string | null, ranges: string[]): boolean {
  if (version == null) return false;
  return ranges.every((range) => satisfies(version, range));
}

export async function resolveDependencyGraph(
  input: ResolveDependencyGraphInput,
): Promise<DependencyGraph> {
  const { root, vendored, io } = input;
  const resolved = new Map<string, ResolvedNode>();
  const registryCache = new Map<string, RegistryPackage>();

  const loadRegistry = async (name: string): Promise<RegistryPackage> => {
    const cached = registryCache.get(name);
    if (cached) return cached;
    const loaded = await io.loadRegistryPackage(name);
    registryCache.set(name, loaded);
    return loaded;
  };

  const resolveOne = async (
    name: string,
    origins: DependencyOrigin[],
  ): Promise<ResolvedNode> => {
    const ranges = origins.map((origin) => origin.range);
    const existing = vendored.get(name);
    if (existing?.version != null) {
      if (satisfiesAll(existing.version, ranges)) {
        return {
          name,
          version: existing.version,
          gitUrl: existing.gitUrl,
          repositoryDirectory: existing.repositoryDirectory,
          ref: existing.ref,
          commit: existing.commit,
          dependencies: existing.dependencies,
          root: false,
          reused: true,
        };
      }
      throw new DependencyResolutionError(
        `"${name}" is already vendored at ${existing.version}, which does not satisfy every requirement in the dependency graph of "${root.name}":\n` +
          `${formatOrigins(origins)}\n` +
          `Run "inrepo update ${name} --ref <tag>" to move it, or remove it before retrying.`,
      );
    }

    const registryPackage = await loadRegistry(name);
    const versions = registryPackage.manifests.map((manifest) => manifest.version);
    const picked = maxSatisfyingAll(versions, ranges);
    if (picked == null) {
      throw new DependencyResolutionError(
        `Cannot satisfy "${name}" in the dependency graph of "${root.name}":\n` +
          `${formatOrigins(origins)}\n` +
          `No published version satisfies every range. Resolving version conflicts is out of scope; vendor the conflicting packages separately.`,
      );
    }

    const manifest = registryPackage.manifests.find((entry) => entry.version === picked);
    if (!manifest) {
      throw new DependencyResolutionError(`npm registry: no manifest for ${name}@${picked}`);
    }
    if (!manifest.gitUrl) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: "${name}@${picked}" (required by ${origins
          .map((origin) => origin.from)
          .join(', ')}) has no usable "repository" clone URL on the npm registry. ` +
          `Vendor it by hand with "inrepo add ${name} --git <url> --ref <ref>".`,
      );
    }

    const tag = await io.resolveVersionTag(manifest.gitUrl, name, picked);
    if (!tag) {
      throw new DependencyResolutionError(
        `Unsupported dependency source: no tag for "${name}@${picked}" in ${manifest.gitUrl} ` +
          `(required by ${origins.map((origin) => origin.from).join(', ')}). ` +
          `Vendor it by hand with "inrepo add ${name} --git ${manifest.gitUrl} --ref <ref>".`,
      );
    }

    // Validate this package's own specifiers now so an unsupported source in a
    // deeper level still fails before anything is written.
    runtimeEdges(name, manifest.dependencies);

    return {
      name,
      version: picked,
      gitUrl: manifest.gitUrl,
      repositoryDirectory: manifest.repositoryDirectory,
      ref: tag.ref,
      commit: tag.commit,
      dependencies: manifest.dependencies,
      root: false,
      reused: false,
    };
  };

  for (let pass = 0; ; pass++) {
    if (pass >= MAX_PASSES) {
      throw new DependencyResolutionError(
        `Dependency resolution for "${root.name}" did not settle after ${MAX_PASSES} passes.`,
      );
    }

    const requirements = collectRequirements(root, resolved);
    for (const name of [...resolved.keys()]) {
      if (!requirements.has(name)) resolved.delete(name);
    }

    let changed = false;
    for (const [name, origins] of [...requirements].sort((a, b) => a[0].localeCompare(b[0]))) {
      const current = resolved.get(name);
      if (current && satisfiesAll(current.version, origins.map((origin) => origin.range))) {
        continue;
      }
      resolved.set(name, await resolveOne(name, origins));
      changed = true;
    }
    if (!changed) break;
  }

  const rootNode: ResolvedNode = {
    name: root.name,
    version: root.version,
    gitUrl: root.gitUrl,
    repositoryDirectory: root.repositoryDirectory,
    ref: root.ref,
    commit: root.commit,
    dependencies: root.dependencies,
    root: true,
    reused: false,
  };
  const dependencies = [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { rootName: root.name, nodes: [rootNode, ...dependencies] };
}
