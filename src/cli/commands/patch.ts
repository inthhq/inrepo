import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { diffTreesWithFiles } from "../../diff/diff-trees.js";
import { assembleModuleTree } from "../../overlay/assemble-module.js";
import { buildOverlay } from "../../overlay/build-overlay.js";
import { ensurePristine } from "../../overlay/cache.js";
import { compareTrees } from "../../overlay/compare-trees.js";
import {
  readModuleState,
  writeModuleState,
} from "../../overlay/module-state.js";
import { overlayDirPath, seriesDirPath } from "../../overlay/overlay-paths.js";
import { hashTree } from "../../overlay/tree-hash.js";
import { moduleDestPath } from "../../paths/module-dest-path.js";
import { captureSeriesPatch } from "../../series/capture-series-patch.js";
import { listLegacyOverlayEntries } from "../../series/legacy-overlay.js";
import { readSeries } from "../../series/read-series.js";
import {
  isUpdateInProgress,
  updateInProgressError,
} from "../../series/update-state.js";
import { parsePatchArgs } from "../args.js";
import { InrepoError } from "../errors.js";
import { projectRelativePath, toFileChanges } from "../json-results.js";
import { isDryRun } from "../output.js";
import { requireLockEntry, selectPackages } from "../package-selection.js";
import { printBanner } from "../rendering.js";
import type {
  DispatchOpts,
  FileChange,
  PatchPackageResult,
  PatchResult,
} from "../types.js";
import { intro, outro, spinner, warn } from "../ui.js";
import {
  EMPTY_TREE_HASH,
  hasTreeDrift,
  makeSiblingStage,
  mergedVendorExcludes,
  mergedVendorKeeps,
  overlayConflictMessage,
} from "../vendor.js";

/**
 * A series patch records why it exists, so capture never invents a message.
 * This is a usage error in every session: interactive runs see the same
 * pointer an agent gets as `nextCommand`.
 */
const missingMessageError = function missingMessageError(
  name: string
): InrepoError {
  return new InrepoError(
    "USAGE",
    `Capturing a patch for "${name}" needs a reason: inrepo patch ${name} -m "why this change"`,
    {
      details: { package: name },
      hint: "Pass -m with a one-line reason; it becomes the patch subject.",
      nextCommand: `inrepo patch ${name} -m "<reason>"`,
    }
  );
};

/**
 * `--dry-run` may preview a capture before a reason is chosen. The patch file
 * name derives from the message, so it is reported as unknown in that case.
 */
const DRY_RUN_SUBJECT = "inrepo dry run preview";

const needsSync = function needsSync(message: string): InrepoError {
  return new InrepoError("ERROR", message, { nextCommand: "inrepo sync" });
};

/** Every path the overlay for `moduleRoot` holds relative to upstream. */
const overlayFileChanges = async function overlayFileChanges(
  pristineRoot: string,
  moduleRoot: string
): Promise<FileChange[]> {
  const { files } = await diffTreesWithFiles({
    baseRoot: pristineRoot,
    stat: true,
    targetRoot: moduleRoot,
  });
  return toFileChanges(files);
};

/**
 * Hash of the overlay a capture would write, without touching the real one.
 * Only `--dry-run` asks, so the scratch tree lives outside the project.
 */
const previewOverlayHash = async function previewOverlayHash(opts: {
  moduleRoot: string;
  pristineRoot: string;
}): Promise<string> {
  const work = await mkdtemp(nodePath.join(tmpdir(), "inrepo-patch-preview-"));
  try {
    const overlayRoot = nodePath.join(work, "overlay");
    await buildOverlay({
      moduleRoot: opts.moduleRoot,
      overlayRoot,
      pristineRoot: opts.pristineRoot,
    });
    return await hashTree(overlayRoot);
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};

export const cmdPatch = async function cmdPatch(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {}
): Promise<PatchResult> {
  const args = parsePatchArgs(argv);
  const dryRun = isDryRun();
  if (!opts.suppressBanners) {
    printBanner();
  }

  const {
    packages: packageList,
    modules,
    globalExclude,
    globalKeep,
  } = await selectPackages(cwd, args.name, "patch");

  if (!opts.suppressBanners) {
    intro(`inrepo patch — ${packageList.length} package(s)`);
  }

  const results: PatchPackageResult[] = [];
  for (const pkg of packageList) {
    const module = pkg.module ?? pkg.name;
    const lockEntry = requireLockEntry(
      modules,
      module,
      `Cannot patch "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`
    );
    if (isUpdateInProgress(cwd, pkg.name)) {
      throw updateInProgressError(cwd, pkg.name, "patching");
    }

    const dest = moduleDestPath(cwd, module);
    const overlayRoot = overlayDirPath(cwd, module);
    const s = spinner();
    s.start(`Capturing "${module}"`);

    try {
      if (!existsSync(dest)) {
        throw needsSync(`Missing directory for "${module}": ${dest}`);
      }

      // A package is on the patch series once it has one, and new packages
      // start there too. Only a package that still carries legacy snapshot
      // files keeps the whole-file overlay capture.
      const seriesPatches = await readSeries(seriesDirPath(cwd, module));
      const legacyEntries = await listLegacyOverlayEntries(overlayRoot);
      const useSeries = seriesPatches.length > 0 || legacyEntries.length === 0;

      if (useSeries && !args.message && !dryRun) {
        throw missingMessageError(module);
      }
      if (!useSeries && args.message) {
        warn(
          `Ignoring -m for "${module}": it still uses a legacy overlay, which records no message. Run "inrepo migrate ${module}" to move it to a patch series.`
        );
      }

      const keepList = mergedVendorKeeps(globalKeep, pkg);
      const excludeList = mergedVendorExcludes(globalExclude, pkg);

      s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
      const pristine = await ensurePristine({
        artifact: lockEntry.artifact,
        commit: lockEntry.commit,
        cwd,
        exclude: excludeList,
        gitUrl: lockEntry.gitUrl,
        keep: keepList,
        name: module,
        ref: lockEntry.ref,
        repositoryDirectory:
          pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
      });

      const state = await readModuleState(cwd, module);
      const overlayHashBefore = await hashTree(overlayRoot);
      const moduleHash = await hashTree(dest);

      if (state) {
        const overlayChanged = overlayHashBefore !== state.overlayHash;
        const moduleChanged = moduleHash !== state.moduleHash;
        if (overlayChanged && moduleChanged) {
          throw needsSync(overlayConflictMessage(module));
        }
        if (overlayChanged) {
          throw needsSync(
            `overlay for "${module}" changed since the last sync; run "inrepo sync" before patching`
          );
        }
      } else if (overlayHashBefore !== EMPTY_TREE_HASH) {
        // `--dry-run` must not touch inrepo_modules, not even transiently.
        const stage = dryRun
          ? await mkdtemp(nodePath.join(tmpdir(), "inrepo-patch-check-"))
          : await makeSiblingStage(dest, ".inrepo-patch-check-");
        try {
          await assembleModuleTree({
            commit: pristine.commit,
            cwd,
            gitUrl: lockEntry.gitUrl,
            name: module,
            pristineRoot: pristine.dir,
            repositoryDirectory:
              pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
            targetRoot: stage,
          });
          const drift = await compareTrees(stage, dest);
          if (hasTreeDrift(drift)) {
            throw needsSync(
              `overlay for "${module}" exists but this checkout has no sync state; run "inrepo sync" before patching`
            );
          }
        } finally {
          await rm(stage, { force: true, recursive: true });
        }
      }

      if (useSeries) {
        s.message("Appending a patch to the series");
        const result = await captureSeriesPatch({
          cwd,
          dryRun,
          moduleRoot: dest,
          name: module,
          pristineRoot: pristine.dir,
          subject: args.message ?? DRY_RUN_SUBJECT,
        });

        if (!result.captured) {
          s.stop(`Nothing to capture for "${module}"`);
          results.push({
            captured: false,
            files: [],
            format: "series",
            module,
          });
          continue;
        }
        if (result.droppedEmptyDirectories.length > 0) {
          warn(
            `Empty directories are not part of the patch series (git cannot record them): ${result.droppedEmptyDirectories.join(", ")}`
          );
        }

        const patchFile = args.message
          ? projectRelativePath(cwd, result.patchPath)
          : null;
        results.push({
          captured: true,
          files: toFileChanges(result.files),
          format: "series",
          module,
          patch: {
            file: patchFile,
            number: result.number,
            subject: args.message ?? null,
          },
        });
        if (dryRun) {
          s.stop(
            `Would patch "${module}" → ${patchFile ?? `patch ${String(result.number).padStart(4, "0")} (pass -m to name it)`}`
          );
          continue;
        }

        await writeModuleState(cwd, module, {
          moduleHash,
          overlayHash: await hashTree(overlayRoot),
        });
        s.stop(`Patched "${module}" → ${patchFile ?? result.patchPath}`);
        continue;
      }

      const files = await overlayFileChanges(pristine.dir, dest);
      if (dryRun) {
        const previewHash = await previewOverlayHash({
          moduleRoot: dest,
          pristineRoot: pristine.dir,
        });
        results.push({
          captured: previewHash !== overlayHashBefore,
          files,
          format: "overlay",
          module,
        });
        s.stop(`Would patch "${module}" → ${overlayRoot}`);
        continue;
      }

      s.message("Writing committed overlay");
      await buildOverlay({
        moduleRoot: dest,
        overlayRoot,
        pristineRoot: pristine.dir,
      });
      const overlayHashAfter = await hashTree(overlayRoot);
      await writeModuleState(cwd, module, {
        moduleHash,
        overlayHash: overlayHashAfter,
      });
      results.push({
        captured: overlayHashAfter !== overlayHashBefore,
        files,
        format: "overlay",
        module,
      });
      s.stop(`Patched "${module}" → ${overlayRoot}`);
    } catch (error) {
      s.error(`Failed to patch "${module}"`);
      throw error;
    }
  }

  if (!opts.suppressBanners) {
    outro(
      dryRun
        ? `Dry run: nothing written. ${packageList.length} package(s) checked.`
        : `Done. ${packageList.length} package(s) patched.`
    );
  }
  return { packages: results };
};
