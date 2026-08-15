import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { relative } from 'node:path';
import { assembleModuleTree } from '../../overlay/assemble-module.js';
import { buildOverlay } from '../../overlay/build-overlay.js';
import { ensurePristine } from '../../overlay/cache.js';
import { compareTrees } from '../../overlay/compare-trees.js';
import { readModuleState, writeModuleState } from '../../overlay/module-state.js';
import { overlayDirPath, seriesDirPath } from '../../overlay/overlay-paths.js';
import { hashTree } from '../../overlay/tree-hash.js';
import { captureSeriesPatch } from '../../series/capture-series-patch.js';
import { listLegacyOverlayEntries } from '../../series/legacy-overlay.js';
import { readSeries } from '../../series/read-series.js';
import { isUpdateInProgress, updateInProgressError } from '../../series/update-state.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import { parsePatchArgs } from '../args.js';
import { selectPackages } from '../package-selection.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts } from '../types.js';
import { intro, outro, spinner, warn } from '../ui.js';
import {
  EMPTY_TREE_HASH,
  hasTreeDrift,
  makeSiblingStage,
  mergedVendorExcludes,
  mergedVendorKeeps,
  overlayConflictMessage,
} from '../vendor.js';

function missingMessageError(name: string): Error {
  return new Error(
    `Capturing a patch for "${name}" needs a reason: inrepo patch ${name} -m "why this change"`,
  );
}

export async function cmdPatch(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {},
): Promise<void> {
  const args = parsePatchArgs(argv);
  if (!opts.suppressBanners) printBanner();

  const {
    packages: packageList,
    modules,
    globalExclude,
    globalKeep,
  } = await selectPackages(cwd, args.name, 'patch');

  if (!opts.suppressBanners) intro(`inrepo patch — ${packageList.length} package(s)`);

  for (const pkg of packageList) {
    const module = pkg.module ?? pkg.name;
    const lockEntry = modules[module];
    if (!lockEntry) {
      throw new Error(
        `Cannot patch "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`,
      );
    }
    if (isUpdateInProgress(cwd, pkg.name)) {
      throw updateInProgressError(cwd, pkg.name, 'patching');
    }

    const dest = moduleDestPath(cwd, module);
    const overlayRoot = overlayDirPath(cwd, module);
    const s = spinner();
    s.start(`Capturing "${module}"`);

    try {
      if (!existsSync(dest)) {
        throw new Error(`Missing directory for "${module}": ${dest}`);
      }

      // A package is on the patch series once it has one, and new packages
      // start there too. Only a package that still carries legacy snapshot
      // files keeps the whole-file overlay capture.
      const seriesPatches = await readSeries(seriesDirPath(cwd, module));
      const legacyEntries = await listLegacyOverlayEntries(overlayRoot);
      const useSeries = seriesPatches.length > 0 || legacyEntries.length === 0;

      if (useSeries && !args.message) throw missingMessageError(module);
      if (!useSeries && args.message) {
        warn(
          `Ignoring -m for "${module}": it still uses a legacy overlay, which records no message. Run "inrepo migrate ${module}" to move it to a patch series.`,
        );
      }

      const keepList = mergedVendorKeeps(globalKeep, pkg);
      const excludeList = mergedVendorExcludes(globalExclude, pkg);

      s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
      const pristine = await ensurePristine({
        cwd,
        name: module,
        gitUrl: lockEntry.gitUrl,
        repositoryDirectory: pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
        ref: lockEntry.ref,
        commit: lockEntry.commit,
        keep: keepList,
        exclude: excludeList,
        artifact: lockEntry.artifact,
      });

      const state = await readModuleState(cwd, module);
      const overlayHashBefore = await hashTree(overlayRoot);
      const moduleHash = await hashTree(dest);

      if (state) {
        const overlayChanged = overlayHashBefore !== state.overlayHash;
        const moduleChanged = moduleHash !== state.moduleHash;
        if (overlayChanged && moduleChanged) {
          throw new Error(overlayConflictMessage(module));
        }
        if (overlayChanged) {
          throw new Error(
            `overlay for "${module}" changed since the last sync; run "inrepo sync" before patching`,
          );
        }
      } else if (overlayHashBefore !== EMPTY_TREE_HASH) {
        const stage = await makeSiblingStage(dest, '.inrepo-patch-check-');
        try {
          await assembleModuleTree({
            cwd,
            name: module,
            pristineRoot: pristine.dir,
            commit: pristine.commit,
            gitUrl: lockEntry.gitUrl,
            repositoryDirectory: pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
            targetRoot: stage,
          });
          const drift = await compareTrees(stage, dest);
          if (hasTreeDrift(drift)) {
            throw new Error(
              `overlay for "${module}" exists but this checkout has no sync state; run "inrepo sync" before patching`,
            );
          }
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }

      if (useSeries) {
        s.message('Appending a patch to the series');
        const result = await captureSeriesPatch({
          cwd,
          name: module,
          pristineRoot: pristine.dir,
          moduleRoot: dest,
          subject: args.message ?? '',
        });

        if (!result.captured) {
          s.stop(`Nothing to capture for "${module}"`);
          continue;
        }
        if (result.droppedEmptyDirectories.length > 0) {
          warn(
            `Empty directories are not part of the patch series (git cannot record them): ${result.droppedEmptyDirectories.join(', ')}`,
          );
        }

        await writeModuleState(cwd, module, {
          overlayHash: await hashTree(overlayRoot),
          moduleHash,
        });
        s.stop(`Patched "${module}" → ${relative(cwd, result.patchPath)}`);
        continue;
      }

      s.message('Writing committed overlay');
      await buildOverlay({
        pristineRoot: pristine.dir,
        moduleRoot: dest,
        overlayRoot,
      });
      const overlayHashAfter = await hashTree(overlayRoot);
      await writeModuleState(cwd, module, {
        overlayHash: overlayHashAfter,
        moduleHash,
      });
      s.stop(`Patched "${module}" → ${overlayRoot}`);
    } catch (e) {
      s.error(`Failed to patch "${module}"`);
      throw e;
    }
  }

  if (!opts.suppressBanners) outro(`Done. ${packageList.length} package(s) patched.`);
}
