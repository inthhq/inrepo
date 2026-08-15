import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from "../config/load-config.js";
import { readLockfile } from "../lockfile/read-lockfile.js";
import { normalizeRepositoryUrlIdentity } from "../registry/normalize-repository-url-identity.js";
import type { LockModule } from "../types/lock-module.js";
import type { PackageSpec } from "./types.js";

export interface PackageSelection {
  /** Packages the command should act on, in order. */
  packages: PackageSpec[];
  modules: Record<string, LockModule>;
  globalExclude: string[];
  globalKeep: string[];
}

/**
 * Resolve which vendored packages a per-package command should act on.
 *
 * A named package wins; otherwise the configured package list is used, falling
 * back to whatever the lockfile knows about so the command still works in a
 * checkout without a config file.
 */
export const selectPackages = async function selectPackages(
  cwd: string,
  name: string | undefined,
  verb: string
): Promise<PackageSelection> {
  let configPackages: PackageSpec[] = [];
  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  try {
    const cfg = await loadConfig(cwd);
    configPackages = cfg.packages;
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
  } catch (error) {
    if (!isLoadConfigNotFoundError(error)) {
      throw error;
    }
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  const { modules } = await readLockfile(cwd);
  const configByName = new Map(
    configPackages.map((pkg) => [pkg.module ?? pkg.name, pkg] as const)
  );

  const fromLock = (module: string): PackageSpec => {
    const source = modules[module]?.source ?? module;
    const spec: PackageSpec = {
      artifact: modules[module]?.artifact,
      git: modules[module]?.gitUrl,
      name: source,
      ref: modules[module]?.ref ?? undefined,
      repositoryDirectory: modules[module]?.repositoryDirectory,
    };
    if (module !== source) {
      spec.module = module;
    }
    return spec;
  };

  const withLockedSource = (pkg: PackageSpec): PackageSpec => {
    const locked = modules[pkg.module ?? pkg.name];
    if (!locked) {
      return pkg;
    }
    const configGit = pkg.git?.trim();
    const sameRepository =
      !configGit ||
      normalizeRepositoryUrlIdentity(configGit) ===
        normalizeRepositoryUrlIdentity(locked.gitUrl);
    return {
      ...pkg,
      artifact: locked.artifact,
      repositoryDirectory:
        pkg.repositoryDirectory ??
        (sameRepository ? locked.repositoryDirectory : undefined),
    };
  };

  let packages: PackageSpec[];
  if (name) {
    packages = [withLockedSource(configByName.get(name) ?? fromLock(name))];
  } else if (configPackages.length > 0) {
    packages = configPackages.map(withLockedSource);
  } else {
    packages = Object.keys(modules).toSorted().map(fromLock);
  }

  if (packages.length === 0) {
    throw new Error(`Nothing to ${verb}: no configured or locked packages.`);
  }
  if (name && !configByName.has(name) && !modules[name]) {
    throw new Error(`No configured or locked package named "${name}".`);
  }

  return { globalExclude, globalKeep, modules, packages };
};
