import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { applyLegacyOverlayTree } from "../overlay/assemble-module.js";
import { overlayDirPath, seriesDirPath } from "../overlay/overlay-paths.js";
import { applySeries } from "./apply-series.js";
import { comparePatchedTrees } from "./compare-patched-trees.js";
import { formatSeriesPatch } from "./format-series-patch.js";
import {
  listLegacyOverlayEntries,
  removeLegacyOverlayEntries,
} from "./legacy-overlay.js";
import { readSeries } from "./read-series.js";
import { resolveSeriesAuthor } from "./resolve-series-author.js";

export interface MigrateResult {
  /** Absolute path of the patch that now carries the package's changes. */
  patchPath: string;
  patchFileName: string;
  /** Legacy overlay entries that were deleted after verification passed. */
  removedLegacyEntries: string[];
  /** Empty directories the overlay used to create that git cannot record. */
  droppedEmptyDirectories: string[];
}

const defaultSubject = function defaultSubject(name: string): string {
  return `Import legacy inrepo overlay for ${name}`;
};

const summarizeDifferences = function summarizeDifferences(
  differences: string[]
): string {
  const shown = differences.slice(0, 5);
  const suffix =
    differences.length > shown.length
      ? `, … (+${differences.length - shown.length} more)`
      : "";
  return shown.join("; ") + suffix;
};

/**
 * Convert a package's legacy whole-file overlay into a single-patch series.
 *
 * The generated patch is only kept when replaying it over the pinned upstream
 * checkout reproduces the legacy result exactly; otherwise the patch is dropped
 * and the legacy overlay is left untouched.
 */
export const migratePackageToSeries =
  async function migratePackageToSeries(opts: {
    cwd: string;
    name: string;
    pristineRoot: string;
    subject?: string;
  }): Promise<MigrateResult> {
    const overlayRoot = overlayDirPath(opts.cwd, opts.name);
    const seriesDir = seriesDirPath(opts.cwd, opts.name);

    if ((await readSeries(seriesDir)).length > 0) {
      throw new Error(
        `"${opts.name}" already has a patch series in ${seriesDir}`
      );
    }
    const legacyEntries = await listLegacyOverlayEntries(overlayRoot);
    if (legacyEntries.length === 0) {
      throw new Error(
        `No legacy overlay to migrate for "${opts.name}" (looked in ${overlayRoot})`
      );
    }

    const workRoot = nodePath.join(opts.cwd, ".inrepo", "migrate");
    await mkdir(workRoot, { recursive: true });
    const work = await mkdtemp(
      nodePath.join(workRoot, `${opts.name.replaceAll("/", "__")}-`)
    );
    const legacyTree = nodePath.join(work, "legacy");
    const seriesTree = nodePath.join(work, "series");

    try {
      await applyLegacyOverlayTree({
        cwd: opts.cwd,
        name: opts.name,
        pristineRoot: opts.pristineRoot,
        targetRoot: legacyTree,
      });

      const patch = await formatSeriesPatch({
        author: await resolveSeriesAuthor(opts.cwd),
        baseRoot: opts.pristineRoot,
        patchedRoot: legacyTree,
        startNumber: 1,
        subject: opts.subject ?? defaultSubject(opts.name),
      });

      await mkdir(seriesDir, { recursive: true });
      const patchPath = nodePath.join(seriesDir, patch.fileName);
      await writeFile(patchPath, patch.content);

      let droppedEmptyDirectories: string[] = [];
      try {
        await applySeries({
          pristineRoot: opts.pristineRoot,
          seriesDir,
          targetRoot: seriesTree,
        });
        const comparison = await comparePatchedTrees(legacyTree, seriesTree);
        if (comparison.differences.length > 0) {
          throw new Error(
            `patched trees differ (${summarizeDifferences(comparison.differences)})`
          );
        }
        ({ droppedEmptyDirectories } = comparison);
      } catch (error) {
        await rm(patchPath, { force: true });
        if (existsSync(seriesDir) && (await readdir(seriesDir)).length === 0) {
          await rm(seriesDir, { force: true, recursive: true });
        }
        const err = error instanceof Error ? error : new Error(String(error));
        throw new Error(
          `Migration of "${opts.name}" did not reproduce the overlay result: ${err.message}. The legacy overlay was left unchanged.`,
          { cause: error }
        );
      }

      const removedLegacyEntries =
        await removeLegacyOverlayEntries(overlayRoot);
      return {
        droppedEmptyDirectories,
        patchFileName: patch.fileName,
        patchPath,
        removedLegacyEntries,
      };
    } finally {
      await rm(work, { force: true, recursive: true });
    }
  };
