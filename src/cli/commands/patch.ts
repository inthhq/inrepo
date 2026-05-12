import { intro, outro, spinner } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from '../../config/load-config.js';
import { assembleModuleTree } from '../../overlay/assemble-module.js';
import { buildOverlay } from '../../overlay/build-overlay.js';
import { ensurePristine } from '../../overlay/cache.js';
import { compareTrees } from '../../overlay/compare-trees.js';
import { readModuleState, writeModuleState } from '../../overlay/module-state.js';
import { overlayDirPath } from '../../overlay/overlay-paths.js';
import { hashTree } from '../../overlay/tree-hash.js';
import { readLockfile } from '../../lockfile/read-lockfile.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import { parsePatchArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts, PackageSpec } from '../types.js';
import {
  EMPTY_TREE_HASH,
  hasTreeDrift,
  makeSiblingStage,
  mergedVendorExcludes,
  mergedVendorKeeps,
  overlayConflictMessage,
} from '../vendor.js';

export async function cmdPatch(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {},
): Promise<void> {
  const args = parsePatchArgs(argv);
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
  const configByName = new Map(configPackages.map((pkg) => [pkg.name, pkg] as const));

  const packageList: PackageSpec[] = args.name
    ? [
        configByName.get(args.name) ?? {
          name: args.name,
          git: modules[args.name]?.gitUrl,
          ref: modules[args.name]?.ref ?? undefined,
        },
      ]
    : configPackages.length > 0
      ? configPackages
      : Object.keys(modules)
          .sort()
          .map((name) => ({
            name,
            git: modules[name]?.gitUrl,
            ref: modules[name]?.ref ?? undefined,
          }));

  if (packageList.length === 0) {
    throw new Error('Nothing to patch: no configured or locked packages.');
  }
  if (args.name && !configByName.has(args.name) && !modules[args.name]) {
    throw new Error(`No configured or locked package named "${args.name}".`);
  }

  if (!opts.suppressBanners) intro(`inrepo patch — ${packageList.length} package(s)`);

  for (const pkg of packageList) {
    const lockEntry = modules[pkg.name];
    if (!lockEntry) {
      throw new Error(
        `Cannot patch "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`,
      );
    }

    const dest = moduleDestPath(cwd, pkg.name);
    const s = spinner();
    s.start(`Capturing "${pkg.name}"`);

    try {
      if (!existsSync(dest)) {
        throw new Error(`Missing directory for "${pkg.name}": ${dest}`);
      }

      const keepList = mergedVendorKeeps(globalKeep, pkg);
      const excludeList = mergedVendorExcludes(globalExclude, pkg);

      s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
      const pristine = await ensurePristine({
        cwd,
        name: pkg.name,
        gitUrl: lockEntry.gitUrl,
        ref: lockEntry.ref,
        commit: lockEntry.commit,
        keep: keepList,
        exclude: excludeList,
      });

      const state = await readModuleState(cwd, pkg.name);
      const overlayHashBefore = await hashTree(overlayDirPath(cwd, pkg.name));
      const moduleHash = await hashTree(dest);

      if (state) {
        const overlayChanged = overlayHashBefore !== state.overlayHash;
        const moduleChanged = moduleHash !== state.moduleHash;
        if (overlayChanged && moduleChanged) {
          throw new Error(overlayConflictMessage(pkg.name));
        }
        if (overlayChanged) {
          throw new Error(
            `overlay for "${pkg.name}" changed since the last sync; run "inrepo sync" before patching`,
          );
        }
      } else if (overlayHashBefore !== EMPTY_TREE_HASH) {
        const stage = await makeSiblingStage(dest, '.inrepo-patch-check-');
        try {
          await assembleModuleTree({
            cwd,
            name: pkg.name,
            pristineRoot: pristine.dir,
            commit: pristine.commit,
            gitUrl: lockEntry.gitUrl,
            targetRoot: stage,
          });
          const drift = await compareTrees(stage, dest);
          if (hasTreeDrift(drift)) {
            throw new Error(
              `overlay for "${pkg.name}" exists but this checkout has no sync state; run "inrepo sync" before patching`,
            );
          }
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }

      s.message('Writing committed overlay');
      await buildOverlay({
        pristineRoot: pristine.dir,
        moduleRoot: dest,
        overlayRoot: overlayDirPath(cwd, pkg.name),
      });
      const overlayHashAfter = await hashTree(overlayDirPath(cwd, pkg.name));
      await writeModuleState(cwd, pkg.name, {
        overlayHash: overlayHashAfter,
        moduleHash,
      });
      s.stop(`Patched "${pkg.name}" → ${overlayDirPath(cwd, pkg.name)}`);
    } catch (e) {
      s.error(`Failed to patch "${pkg.name}"`);
      throw e;
    }
  }

  if (!opts.suppressBanners) outro(`Done. ${packageList.length} package(s) patched.`);
}
