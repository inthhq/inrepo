import { InrepoError } from "../cli/errors.js";
import {
  isLoadConfigNotFoundError,
  loadConfig,
} from "../config/load-config.js";
import { readLockfile } from "../lockfile/read-lockfile.js";
import type { LoadedConfig } from "../types/loaded-config.js";

/** Config, if any, plus the names a per-package command accepts. */
export interface KnownPackages {
  config: LoadedConfig | null;
  /** Names accepted as `<name>`: config module identities and lockfile modules. */
  names: string[];
}

/** Read config (when present) and lockfile names without writing anything. */
export const readKnownPackages = async function readKnownPackages(
  cwd: string
): Promise<KnownPackages> {
  let config: LoadedConfig | null = null;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    if (!isLoadConfigNotFoundError(error)) {
      throw error;
    }
  }
  const { modules } = await readLockfile(cwd);
  const names = new Set<string>(Object.keys(modules));
  for (const pkg of config?.packages ?? []) {
    names.add(pkg.module ?? pkg.name);
  }
  return { config, names: [...names].toSorted() };
};

/**
 * Throw `PACKAGE_NOT_FOUND` when `name` is neither configured nor locked. The
 * message matches what package selection reports for the same case.
 */
export const assertKnownPackage = async function assertKnownPackage(
  cwd: string,
  name: string
): Promise<KnownPackages> {
  const known = await readKnownPackages(cwd);
  if (!known.names.includes(name)) {
    throw new InrepoError(
      "PACKAGE_NOT_FOUND",
      `No configured or locked package named "${name}".`,
      { details: { known: known.names, package: name } }
    );
  }
  return known;
};
