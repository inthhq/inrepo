import { fetchPackument, type Packument, type PackumentVersion } from './fetch-packument.js';
import { normalizeRepositoryUrl } from './normalize-repository-url.js';
import { repositoryToSource } from './resolve-git-url-from-npm.js';
import type { PublishedArtifact } from '../types/published-artifact.js';

/** One published version, reduced to what dependency resolution needs. */
export type RegistryManifest = {
  version: string;
  /** Runtime `dependencies` only; dev and peer dependencies are never vendored. */
  dependencies: Record<string, string>;
  /** Clone URL, or null when the manifest has no usable repository. */
  gitUrl: string | null;
  /** Package root within the repository; null means the repository root. */
  repositoryDirectory: string | null;
  /** Exact source commit recorded by npm at publish time, when present. */
  gitHead: string | null;
  /** Integrity of the published tarball bound by npm provenance. */
  distIntegrity: string | null;
  /** Registry endpoint returning signed attestations for this version. */
  attestationsUrl: string | null;
  /** Immutable published package payload, when npm supplies URL and integrity together. */
  artifact?: PublishedArtifact | null;
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
      const dist =
        manifest.dist != null && typeof manifest.dist === 'object' && !Array.isArray(manifest.dist)
          ? (manifest.dist as Record<string, unknown>)
          : null;
      const attestations =
        dist?.attestations != null &&
        typeof dist.attestations === 'object' &&
        !Array.isArray(dist.attestations)
          ? (dist.attestations as Record<string, unknown>)
          : null;
      const gitHead =
        typeof manifest.gitHead === 'string' && /^[0-9a-f]{40}$/i.test(manifest.gitHead)
          ? manifest.gitHead.toLowerCase()
          : null;
      manifests.push({
        version,
        dependencies: runtimeDependencies(manifest),
        gitUrl: repo ? normalizeRepositoryUrl(repo.gitUrl) : null,
        repositoryDirectory: repo?.repositoryDirectory ?? null,
        gitHead,
        distIntegrity: typeof dist?.integrity === 'string' ? dist.integrity : null,
        attestationsUrl: typeof attestations?.url === 'string' ? attestations.url : null,
        artifact:
          typeof dist?.tarball === 'string' && typeof dist?.integrity === 'string'
            ? { tarballUrl: dist.tarball, integrity: dist.integrity }
            : null,
      });
    }
  }
  return { name, manifests };
}

/** Fetch and normalize registry metadata for one package. */
export async function loadRegistryPackage(name: string): Promise<RegistryPackage> {
  return toRegistryPackage(name, await fetchPackument(name));
}
