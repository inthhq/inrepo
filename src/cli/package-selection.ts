import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from '../config/load-config.js';
import { readLockfile } from '../lockfile/read-lockfile.js';
import { normalizeRepositoryUrlIdentity } from '../registry/normalize-repository-url-identity.js';
import type { LockModule } from '../types/lock-module.js';
import type { PackageSpec } from './types.js';

export type PackageSelection = {
  /** Packages the command should act on, in order. */
  packages: PackageSpec[];
  modules: Record<string, LockModule>;
  globalExclude: string[];
  globalKeep: string[];
};

/**
 * Resolve which vendored packages a per-package command should act on.
 *
 * A named package wins; otherwise the configured package list is used, falling
 * back to whatever the lockfile knows about so the command still works in a
 * checkout without a config file.
 */
export async function selectPackages(
  cwd: string,
  name: string | undefined,
  verb: string,
): Promise<PackageSelection> {
  let configPackages: PackageSpec[] = [];
  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  try {
    const cfg = await loadConfig(cwd);
    configPackages = cfg.packages;
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  const { modules } = await readLockfile(cwd);
  const configByName = new Map(configPackages.map((pkg) => [pkg.name, pkg] as const));

  const fromLock = (packageName: string): PackageSpec => ({
    name: packageName,
    git: modules[packageName]?.gitUrl,
    repositoryDirectory: modules[packageName]?.repositoryDirectory,
    ref: modules[packageName]?.ref ?? undefined,
  });

  const withLockedSource = (pkg: PackageSpec): PackageSpec => {
    const locked = modules[pkg.name];
    if (!locked) return pkg;
    const configGit = pkg.git?.trim();
    const sameRepository =
      !configGit ||
      normalizeRepositoryUrlIdentity(configGit) ===
        normalizeRepositoryUrlIdentity(locked.gitUrl);
    return {
      ...pkg,
      repositoryDirectory:
        pkg.repositoryDirectory ?? (sameRepository ? locked.repositoryDirectory : undefined),
    };
  };

  const packages: PackageSpec[] = name
    ? [withLockedSource(configByName.get(name) ?? fromLock(name))]
    : configPackages.length > 0
      ? configPackages.map(withLockedSource)
      : Object.keys(modules).sort().map(fromLock);

  if (packages.length === 0) {
    throw new Error(`Nothing to ${verb}: no configured or locked packages.`);
  }
  if (name && !configByName.has(name) && !modules[name]) {
    throw new Error(`No configured or locked package named "${name}".`);
  }

  return { packages, modules, globalExclude, globalKeep };
}
