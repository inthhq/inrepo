import type { RegistryManifest } from '../registry/load-registry-package.js';
import { fetchNpmProvenanceCommit } from '../registry/fetch-npm-provenance.js';
import { resolveVersionTag, type VersionTag } from './resolve-version-tag.js';

/** Resolve immutable candidates, strongest first, without using a moving branch. */
export async function resolveVersionPins(
  name: string,
  manifest: RegistryManifest,
): Promise<VersionTag[]> {
  if (manifest.gitUrl == null) return [];
  const pins: VersionTag[] = [];
  // npm records gitHead from the exact checkout it packed. Prefer it over a
  // generic vX.Y.Z tag, which can name another package in a monorepo.
  if (manifest.gitHead) {
    pins.push({ ref: manifest.gitHead, commit: manifest.gitHead });
  }
  const tag = await resolveVersionTag(manifest.gitUrl, name, manifest.version);
  if (tag && !pins.some((pin) => pin.commit === tag.commit)) pins.push(tag);
  if (pins.length === 0 && manifest.distIntegrity && manifest.attestationsUrl) {
    const commit = await fetchNpmProvenanceCommit({
      name,
      version: manifest.version,
      gitUrl: manifest.gitUrl,
      integrity: manifest.distIntegrity,
      attestationsUrl: manifest.attestationsUrl,
    });
    if (commit) pins.push({ ref: commit, commit });
  }
  return pins;
}
