import type { JsonValue } from "../json/unknown.js";
import { isJsonObject, isString } from "../json/unknown.js";
import type { PublishedArtifact } from "../types/published-artifact.js";
import { fetchPackument } from "./fetch-packument.js";
import type { Packument } from "./fetch-packument.js";
import { normalizeRepositoryUrl } from "./normalize-repository-url.js";
import { repositoryToSource } from "./resolve-git-url-from-npm.js";

/** One published version, reduced to what dependency resolution needs. */
export interface RegistryManifest {
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
}

export interface RegistryPackage {
  name: string;
  manifests: RegistryManifest[];
}

const runtimeDependencies = function runtimeDependencies(
  raw: JsonValue | undefined
) {
  if (!isJsonObject(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(raw)) {
    if (isString(range)) {
      out[name] = range;
    }
  }
  return out;
};

/** Normalize a packument into the version list dependency resolution walks. */
export const toRegistryPackage = function toRegistryPackage(
  name: string,
  packument: Packument
): RegistryPackage {
  const fallbackRepo = repositoryToSource(packument.repository);
  const { versions } = packument;
  const manifests: RegistryManifest[] = [];
  if (versions == null) {
    return { manifests, name };
  }
  for (const [version, manifest] of Object.entries(versions)) {
    if (!isJsonObject(manifest)) {
      continue;
    }
    const repo = repositoryToSource(manifest.repository) ?? fallbackRepo;
    const dist = isJsonObject(manifest.dist) ? manifest.dist : null;
    const attestations = isJsonObject(dist?.attestations)
      ? dist.attestations
      : null;
    const gitHead =
      isString(manifest.gitHead) && /^[0-9a-f]{40}$/iu.test(manifest.gitHead)
        ? manifest.gitHead.toLowerCase()
        : null;
    manifests.push({
      artifact:
        isString(dist?.tarball) && isString(dist?.integrity)
          ? { integrity: dist.integrity, tarballUrl: dist.tarball }
          : null,
      attestationsUrl: isString(attestations?.url) ? attestations.url : null,
      dependencies: runtimeDependencies(manifest.dependencies),
      distIntegrity: isString(dist?.integrity) ? dist.integrity : null,
      gitHead,
      gitUrl: repo ? normalizeRepositoryUrl(repo.gitUrl) : null,
      repositoryDirectory: repo?.repositoryDirectory ?? null,
      version,
    });
  }
  return { manifests, name };
};

/** Fetch and normalize registry metadata for one package. */
export const loadRegistryPackage = async function loadRegistryPackage(
  name: string
): Promise<RegistryPackage> {
  return toRegistryPackage(name, await fetchPackument(name));
};
