export type PackumentVersion = {
  version?: unknown;
  repository?: unknown;
  dependencies?: unknown;
};

export type Packument = {
  repository?: unknown;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
};

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Registry root. `INREPO_REGISTRY` exists so tests (and private mirrors) can
 * point the resolver somewhere other than the public npm registry.
 */
export function registryBaseUrl(): string {
  const configured = process.env.INREPO_REGISTRY?.trim();
  return (configured || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

export function packumentUrl(packageName: string): string {
  return `${registryBaseUrl()}/${encodeURIComponent(packageName)}`;
}

/** Fetch a package document from the npm registry. */
export async function fetchPackument(packageName: string): Promise<Packument> {
  const res = await fetch(packumentUrl(packageName), {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) {
    throw new Error(`npm registry: package not found: ${packageName}`);
  }
  if (!res.ok) {
    throw new Error(`npm registry: HTTP ${res.status} for ${packageName}`);
  }
  return (await res.json()) as Packument;
}
