import { relative } from 'node:path';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from '../../config/load-config.js';
import { readLockfile } from '../../lockfile/read-lockfile.js';
import { ensurePristine } from '../../overlay/cache.js';
import { readModuleState, writeModuleState } from '../../overlay/module-state.js';
import { overlayDirPath } from '../../overlay/overlay-paths.js';
import { hashTree } from '../../overlay/tree-hash.js';
import { migratePackageToSeries } from '../../series/migrate-package.js';
import { parseMigrateArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts, PackageSpec } from '../types.js';
import { intro, outro, spinner, warn } from '../ui.js';
import { mergedVendorExcludes, mergedVendorKeeps } from '../vendor.js';

/**
 * Convert a package's legacy whole-file overlay into an ordered patch series.
 * The legacy overlay is only removed once the series reproduces the identical
 * patched tree.
 */
export async function cmdMigrate(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {},
): Promise<void> {
  const args = parseMigrateArgs(argv);
  if (!opts.suppressBanners) printBanner();

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
  const lockEntry = modules[args.name];
  if (!lockEntry) {
    throw new Error(
      `Cannot migrate "${args.name}" without a lockfile entry. Run "inrepo add ${args.name}" or "inrepo sync" first.`,
    );
  }
  const pkg = configPackages.find((entry) => entry.name === args.name) ?? { name: args.name };

  if (!opts.suppressBanners) intro(`inrepo migrate — ${args.name}`);

  const s = spinner();
  s.start(`Migrating "${args.name}" to a patch series`);
  try {
    s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
    const pristine = await ensurePristine({
      cwd,
      name: args.name,
      gitUrl: lockEntry.gitUrl,
      ref: lockEntry.ref,
      commit: lockEntry.commit,
      keep: mergedVendorKeeps(globalKeep, pkg),
      exclude: mergedVendorExcludes(globalExclude, pkg),
    });

    s.message('Generating patch series');
    const result = await migratePackageToSeries({
      cwd,
      name: args.name,
      pristineRoot: pristine.dir,
    });

    if (result.droppedEmptyDirectories.length > 0) {
      warn(
        `Empty directories are not part of the patch series (git cannot record them): ${result.droppedEmptyDirectories.join(', ')}`,
      );
    }

    // The overlay directory now holds the series instead of snapshot files;
    // refresh the recorded hash so the next sync/patch does not read the
    // migration as an out-of-band overlay edit.
    const state = await readModuleState(cwd, args.name);
    if (state) {
      await writeModuleState(cwd, args.name, {
        overlayHash: await hashTree(overlayDirPath(cwd, args.name)),
        moduleHash: state.moduleHash,
      });
    }

    s.stop(`Migrated "${args.name}" → ${relative(cwd, result.patchPath)}`);
  } catch (e) {
    s.error(`Failed to migrate "${args.name}"`);
    throw e;
  }

  if (!opts.suppressBanners) {
    outro(`Legacy overlay for "${args.name}" replaced by a patch series.`);
  }
}
