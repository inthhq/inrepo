import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** `0001-short-subject.patch`: four digits, a dash, then a slug. */
const SERIES_PATCH_NAME = /^(\d{4})-.+\.patch$/;

export type SeriesPatch = {
  /** File name inside the series directory, e.g. `0001-fix-types.patch`. */
  fileName: string;
  /** Absolute path to the patch file. */
  path: string;
  /** Numeric prefix, used for ordering diagnostics and for numbering new patches. */
  index: number;
};

export function isSeriesPatchFileName(fileName: string): boolean {
  return SERIES_PATCH_NAME.test(fileName);
}

/**
 * Read a package's patch series in filename order. Ordering is the file name
 * itself; there is no separate series manifest. Any `.patch` file that does not
 * follow the naming convention is an error rather than a silently skipped
 * patch.
 */
export async function readSeries(seriesDir: string): Promise<SeriesPatch[]> {
  if (!existsSync(seriesDir)) return [];

  const entries = await readdir(seriesDir, { withFileTypes: true });
  const patches: SeriesPatch[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.patch')) continue;
    const match = SERIES_PATCH_NAME.exec(entry.name);
    if (!match) {
      throw new Error(
        `Invalid patch name in ${seriesDir}: ${JSON.stringify(entry.name)} (expected NNNN-<slug>.patch)`,
      );
    }
    patches.push({
      fileName: entry.name,
      path: join(seriesDir, entry.name),
      index: Number.parseInt(match[1], 10),
    });
  }

  patches.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));

  const seen = new Set<number>();
  for (const patch of patches) {
    if (seen.has(patch.index)) {
      throw new Error(
        `Duplicate patch number ${String(patch.index).padStart(4, '0')} in ${seriesDir}: ${patch.fileName}`,
      );
    }
    seen.add(patch.index);
  }

  return patches;
}

/** Next free patch number for a series (1-based). */
export function nextSeriesNumber(patches: SeriesPatch[]): number {
  return patches.reduce((max, patch) => Math.max(max, patch.index), 0) + 1;
}
