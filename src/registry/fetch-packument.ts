import type { JsonValue } from "../json/unknown.js";

/** One version entry from an npm packument, before field-level parsing. */
export interface PackumentVersion {
  version?: JsonValue;
  repository?: JsonValue;
  dependencies?: JsonValue;
  gitHead?: JsonValue;
  dist?: JsonValue;
}

/** npm registry package document after JSON parse, before normalization. */
export interface Packument {
  repository?: JsonValue;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Registry root. `INREPO_REGISTRY` exists so tests (and private mirrors) can
 * point the resolver somewhere other than the public npm registry.
 */
export const registryBaseUrl = function registryBaseUrl(): string {
  const configured = process.env.INREPO_REGISTRY?.trim();
  return (configured || DEFAULT_REGISTRY).replace(/\/+$/u, "");
};

export const packumentUrl = function packumentUrl(packageName: string): string {
  return `${registryBaseUrl()}/${encodeURIComponent(packageName)}`;
};

/** Fetch a package document from the npm registry. */
export const fetchPackument = async function fetchPackument(
  packageName: string
): Promise<Packument> {
  const res = await fetch(packumentUrl(packageName), {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) {
    throw new Error(`npm registry: package not found: ${packageName}`);
  }
  if (!res.ok) {
    throw new Error(`npm registry: HTTP ${res.status} for ${packageName}`);
  }
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return (await res.json()) as Packument;
};
