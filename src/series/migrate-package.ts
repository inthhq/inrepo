import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGitCapture } from '../git/run-git-capture.js';
import { applyLegacyOverlayTree } from '../overlay/assemble-module.js';
import { overlayDirPath, seriesDirPath } from '../overlay/overlay-paths.js';
import { applySeries } from './apply-series.js';
import { comparePatchedTrees } from './compare-patched-trees.js';
import { formatSeriesPatch } from './format-series-patch.js';
import { listLegacyOverlayEntries, removeLegacyOverlayEntries } from './legacy-overlay.js';
import { readSeries } from './read-series.js';
import { DEFAULT_SERIES_AUTHOR, type SeriesAuthor } from './series-git.js';

export type MigrateResult = {
  /** Absolute path of the patch that now carries the package's changes. */
  patchPath: string;
  patchFileName: string;
  /** Legacy overlay entries that were deleted after verification passed. */
  removedLegacyEntries: string[];
  /** Empty directories the overlay used to create that git cannot record. */
  droppedEmptyDirectories: string[];
};

function defaultSubject(name: string): string {
  return `Import legacy inrepo overlay for ${name}`;
}

async function resolveRepoAuthor(cwd: string): Promise<SeriesAuthor> {
  const read = async (key: string): Promise<string> => {
    try {
      return await runGitCapture(['config', '--get', key], { cwd });
    } catch {
      return '';
    }
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return {
    name: name || DEFAULT_SERIES_AUTHOR.name,
    email: email || DEFAULT_SERIES_AUTHOR.email,
  };
}

function summarizeDifferences(differences: string[]): string {
  const shown = differences.slice(0, 5);
  const suffix =
    differences.length > shown.length ? `, … (+${differences.length - shown.length} more)` : '';
  return shown.join('; ') + suffix;
}

/**
 * Convert a package's legacy whole-file overlay into a single-patch series.
 *
 * The generated patch is only kept when replaying it over the pinned upstream
 * checkout reproduces the legacy result exactly; otherwise the patch is dropped
 * and the legacy overlay is left untouched.
 */
export async function migratePackageToSeries(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  subject?: string;
}): Promise<MigrateResult> {
  const overlayRoot = overlayDirPath(opts.cwd, opts.name);
  const seriesDir = seriesDirPath(opts.cwd, opts.name);

  if ((await readSeries(seriesDir)).length > 0) {
    throw new Error(`"${opts.name}" already has a patch series in ${seriesDir}`);
  }
  const legacyEntries = await listLegacyOverlayEntries(overlayRoot);
  if (legacyEntries.length === 0) {
    throw new Error(`No legacy overlay to migrate for "${opts.name}" (looked in ${overlayRoot})`);
  }

  const workRoot = join(opts.cwd, '.inrepo', 'migrate');
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(join(workRoot, `${opts.name.replaceAll('/', '__')}-`));
  const legacyTree = join(work, 'legacy');
  const seriesTree = join(work, 'series');

  try {
    await applyLegacyOverlayTree({
      cwd: opts.cwd,
      name: opts.name,
      pristineRoot: opts.pristineRoot,
      targetRoot: legacyTree,
    });

    const patch = await formatSeriesPatch({
      baseRoot: opts.pristineRoot,
      patchedRoot: legacyTree,
      subject: opts.subject ?? defaultSubject(opts.name),
      author: await resolveRepoAuthor(opts.cwd),
      startNumber: 1,
    });

    await mkdir(seriesDir, { recursive: true });
    const patchPath = join(seriesDir, patch.fileName);
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
        throw new Error(`patched trees differ (${summarizeDifferences(comparison.differences)})`);
      }
      droppedEmptyDirectories = comparison.droppedEmptyDirectories;
    } catch (e) {
      await rm(patchPath, { force: true });
      if (existsSync(seriesDir) && (await readdir(seriesDir)).length === 0) {
        await rm(seriesDir, { recursive: true, force: true });
      }
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(
        `Migration of "${opts.name}" did not reproduce the overlay result: ${err.message}. The legacy overlay was left unchanged.`,
      );
    }

    const removedLegacyEntries = await removeLegacyOverlayEntries(overlayRoot);
    return {
      patchPath,
      patchFileName: patch.fileName,
      removedLegacyEntries,
      droppedEmptyDirectories,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
