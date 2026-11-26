import { InrepoError } from "../cli/errors.js";
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

/**
 * Fetch a package document from the npm registry.
 *
 * A 404 throws `PACKAGE_NOT_FOUND`; network failures and other HTTP errors
 * throw `UPSTREAM_UNAVAILABLE`. Both carry `details.url`.
 */
export const fetchPackument = async function fetchPackument(
  packageName: string
): Promise<Packument> {
  const url = packumentUrl(packageName);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InrepoError(
      "UPSTREAM_UNAVAILABLE",
      `npm registry: request failed for ${packageName}: ${reason}`,
      {
        cause: error,
        details: { package: packageName, url },
        hint: "Check your network or INREPO_REGISTRY, then retry.",
      }
    );
  }
  if (res.status === 404) {
    throw new InrepoError(
      "PACKAGE_NOT_FOUND",
      `npm registry: package not found: ${packageName}`,
      {
        details: { package: packageName, url },
        hint: "Check the package name, or pass --git <url> to vendor straight from git.",
      }
    );
  }
  if (!res.ok) {
    throw new InrepoError(
      "UPSTREAM_UNAVAILABLE",
      `npm registry: HTTP ${res.status} for ${packageName}`,
      {
        details: { package: packageName, status: res.status, url },
        hint: "The registry may be down or rate-limiting; retry later.",
      }
    );
  }
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return (await res.json()) as Packument;
};
