import { ensureInrepoInitialized } from '../../config/ensure-inrepo-initialized.js';
import { loadConfig } from '../../config/load-config.js';
import { readLockfile } from '../../lockfile/read-lockfile.js';
import {
  preflightRootPackageJsonDependencyLinks,
  syncRootPackageJsonDependencies,
  type PackageJsonDependencyLink,
} from '../../package-json/upsert-vendored-package-ref.js';
import { parseSyncArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts } from '../types.js';
import { intro, outro } from '../ui.js';
import { materializePackage } from '../vendor.js';

export async function cmdSync(
  cwd: string,
  argv: string[] = [],
  opts: DispatchOpts = {},
): Promise<void> {
  const args = parseSyncArgs(argv, opts.force);
  if (!opts.suppressBanners) printBanner();

  await ensureInrepoInitialized(cwd);
  const { packages, exclude: globalExclude, keep: globalKeep } = await loadConfig(cwd);
  const { modules } = await readLockfile(cwd);
  if (packages.length === 0) {
    throw new Error('Config has an empty "packages" array. Add at least one package.');
  }
  const packageJsonLinks: PackageJsonDependencyLink[] = packages.flatMap((pkg) =>
    pkg.packageJson ? [{ name: pkg.name, target: pkg.packageJson }] : [],
  );
  await preflightRootPackageJsonDependencyLinks(cwd, packageJsonLinks);

  if (!opts.suppressBanners) intro(`inrepo sync — ${packages.length} package(s)`);
  for (const pkg of packages) {
    await materializePackage(cwd, pkg, globalExclude, globalKeep, {
      mode: 'sync',
      force: args.force,
      lockEntry: modules[pkg.name],
    });
  }
  await syncRootPackageJsonDependencies(cwd, packageJsonLinks);
  if (!opts.suppressBanners) outro(`Done. ${packages.length} package(s) synced.`);
}
