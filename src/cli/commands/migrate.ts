import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";

import { assembleModuleTree } from "../../overlay/assemble-module.js";
import { ensurePristine } from "../../overlay/cache.js";
import { writeModuleState } from "../../overlay/module-state.js";
import { overlayDirPath } from "../../overlay/overlay-paths.js";
import { hashTree } from "../../overlay/tree-hash.js";
import { moduleDestPath } from "../../paths/module-dest-path.js";
import { migratePackageToSeries } from "../../series/migrate-package.js";
import {
  isUpdateInProgress,
  updateInProgressError,
} from "../../series/update-state.js";
import { parseMigrateArgs } from "../args.js";
import { InrepoError, isInrepoError } from "../errors.js";
import { projectRelativePath, toFileChanges } from "../json-results.js";
import type { PackageSelection } from "../package-selection.js";
import { requireLockEntry, selectPackages } from "../package-selection.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts, MigrateResult } from "../types.js";
import { intro, outro, spinner, warn } from "../ui.js";
import {
  makeSiblingStage,
  mergedVendorExcludes,
  mergedVendorKeeps,
} from "../vendor.js";

/**
 * Convert a package's legacy whole-file overlay into an ordered patch series.
 * The legacy overlay is only removed once the series reproduces the identical
 * patched tree.
 */
export const cmdMigrate = async function cmdMigrate(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {}
): Promise<MigrateResult> {
  const args = parseMigrateArgs(argv);
  if (!opts.suppressBanners) {
    printBanner();
  }

  const notLocked = `Cannot migrate "${args.name}" without a lockfile entry. Run "inrepo add ${args.name}" or "inrepo sync" first.`;
  let selection: PackageSelection;
  try {
    selection = await selectPackages(cwd, args.name, "migrate");
  } catch (error) {
    if (
      error instanceof Error &&
      isInrepoError(error) &&
      error.code === "PACKAGE_NOT_FOUND"
    ) {
      throw new InrepoError("PACKAGE_NOT_FOUND", notLocked, {
        cause: error,
        details: { package: args.name },
      });
    }
    throw error;
  }
  const { packages, modules, globalExclude, globalKeep } = selection;
  const [pkg] = packages;
  const module = pkg.module ?? pkg.name;
  const lockEntry = requireLockEntry(modules, module, notLocked);
  if (isUpdateInProgress(cwd, module)) {
    throw updateInProgressError(cwd, module, "migrating");
  }

  if (!opts.suppressBanners) {
    intro(`inrepo migrate — ${module}`);
  }

  const s = spinner();
  s.start(`Migrating "${module}" to a patch series`);
  let data: MigrateResult;
  try {
    s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
    const pristine = await ensurePristine({
      artifact: lockEntry.artifact,
      commit: lockEntry.commit,
      cwd,
      exclude: mergedVendorExcludes(globalExclude, pkg),
      gitUrl: lockEntry.gitUrl,
      keep: mergedVendorKeeps(globalKeep, pkg),
      name: module,
      ref: lockEntry.ref,
      repositoryDirectory:
        pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
    });

    s.message("Generating patch series");
    const result = await migratePackageToSeries({
      cwd,
      name: module,
      pristineRoot: pristine.dir,
    });

    if (result.droppedEmptyDirectories.length > 0) {
      warn(
        `Empty directories are not part of the patch series (git cannot record them): ${result.droppedEmptyDirectories.join(", ")}`
      );
    }

    // Git cannot record empty directories, so the leftover checkout may still
    // contain ones the series omitted. Rebuild dest the same way sync/verify
    // do and record hashes of the post-rebuild trees.
    s.message("Rebuilding generated vendor tree");
    const dest = moduleDestPath(cwd, module);
    const stage = await makeSiblingStage(dest, ".inrepo-next-");
    try {
      await assembleModuleTree({
        commit: lockEntry.commit,
        cwd,
        gitUrl: lockEntry.gitUrl,
        name: module,
        pristineRoot: pristine.dir,
        targetRoot: stage,
      });
      if (existsSync(dest)) {
        await rm(dest, { force: true, recursive: true });
      }
      await rename(stage, dest);
    } catch (error) {
      await rm(stage, { force: true, recursive: true });
      throw error;
    }

    await writeModuleState(cwd, module, {
      moduleHash: await hashTree(dest),
      overlayHash: await hashTree(overlayDirPath(cwd, module)),
    });

    const patchFile = projectRelativePath(cwd, result.patchPath);
    data = {
      droppedEmptyDirectories: result.droppedEmptyDirectories,
      files: toFileChanges(result.files),
      module,
      patches: [
        { file: patchFile, number: result.number, subject: result.subject },
      ],
      removedOverlayEntries: result.removedLegacyEntries,
    };
    s.stop(`Migrated "${module}" → ${patchFile}`);
  } catch (error) {
    s.error(`Failed to migrate "${module}"`);
    throw error;
  }

  if (!opts.suppressBanners) {
    outro(`Legacy overlay for "${module}" replaced by a patch series.`);
  }
  return data;
};
