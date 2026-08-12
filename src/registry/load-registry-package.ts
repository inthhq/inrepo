import { fetchPackument, type Packument, type PackumentVersion } from './fetch-packument.js';
import { normalizeRepositoryUrl } from './normalize-repository-url.js';
import { repositoryToSource } from './resolve-git-url-from-npm.js';

/** One published version, reduced to what dependency resolution needs. */
export type RegistryManifest = {
  version: string;
  /** Runtime `dependencies` only; dev and peer dependencies are never vendored. */
  dependencies: Record<string, string>;
  /** Clone URL, or null when the manifest has no usable repository. */
  gitUrl: string | null;
  /** Package root within the repository; null means the repository root. */
  repositoryDirectory: string | null;
};

export type RegistryPackage = {
  name: string;
  manifests: RegistryManifest[];
};

function runtimeDependencies(manifest: PackumentVersion): Record<string, string> {
  const raw = manifest.dependencies;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof range === 'string') out[name] = range;
  }
  return out;
}

/** Normalize a packument into the version list dependency resolution walks. */
export function toRegistryPackage(name: string, packument: Packument): RegistryPackage {
  const fallbackRepo = repositoryToSource(packument.repository);
  const versions = packument.versions;
  const manifests: RegistryManifest[] = [];
  if (versions != null && typeof versions === 'object' && !Array.isArray(versions)) {
    for (const [version, manifest] of Object.entries(versions)) {
      if (manifest == null || typeof manifest !== 'object') continue;
      const repo = repositoryToSource(manifest.repository) ?? fallbackRepo;
      manifests.push({
        version,
        dependencies: runtimeDependencies(manifest),
        gitUrl: repo ? normalizeRepositoryUrl(repo.gitUrl) : null,
        repositoryDirectory: repo?.repositoryDirectory ?? null,
      });
    }
  }
  return { name, manifests };
}

/** Fetch and normalize registry metadata for one package. */
export async function loadRegistryPackage(name: string): Promise<RegistryPackage> {
  return toRegistryPackage(name, await fetchPackument(name));
}
