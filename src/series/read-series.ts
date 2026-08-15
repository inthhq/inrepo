import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

/** `0001-short-subject.patch`: four digits, a dash, then a slug. */
const SERIES_PATCH_NAME = /^(?<g1>\d{4})-.+\.patch$/u;

export interface SeriesPatch {
  /** File name inside the series directory, e.g. `0001-fix-types.patch`. */
  fileName: string;
  /** Absolute path to the patch file. */
  path: string;
  /** Numeric prefix, used for ordering diagnostics and for numbering new patches. */
  index: number;
}

export const isSeriesPatchFileName = function isSeriesPatchFileName(
  fileName: string
): boolean {
  return SERIES_PATCH_NAME.test(fileName);
};

/**
 * `git format-patch` derives the file name from the subject, which can collapse
 * to nothing for a subject made entirely of punctuation. The series reader
 * requires `NNNN-<slug>.patch`, so fall back to a generic slug.
 */
export const seriesPatchFileName = function seriesPatchFileName(
  produced: string,
  number: number
): string {
  if (isSeriesPatchFileName(produced)) {
    return produced;
  }
  return `${String(number).padStart(4, "0")}-patch.patch`;
};

/**
 * Read a package's patch series in filename order. Ordering is the file name
 * itself; there is no separate series manifest. Any `.patch` file that does not
 * follow the naming convention is an error rather than a silently skipped
 * patch.
 */
export const readSeries = async function readSeries(
  seriesDir: string
): Promise<SeriesPatch[]> {
  if (!existsSync(seriesDir)) {
    return [];
  }

  const entries = await readdir(seriesDir, { withFileTypes: true });
  const patches: SeriesPatch[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".patch")) {
      continue;
    }
    const match = SERIES_PATCH_NAME.exec(entry.name);
    if (!match) {
      throw new Error(
        `Invalid patch name in ${seriesDir}: ${JSON.stringify(entry.name)} (expected NNNN-<slug>.patch)`
      );
    }
    patches.push({
      fileName: entry.name,
      index: Math.trunc(Number(match[1])),
      path: nodePath.join(seriesDir, entry.name),
    });
  }

  patches.sort((a, b) => a.fileName.localeCompare(b.fileName));

  const seen = new Set<number>();
  for (const patch of patches) {
    if (seen.has(patch.index)) {
      throw new Error(
        `Duplicate patch number ${String(patch.index).padStart(4, "0")} in ${seriesDir}: ${patch.fileName}`
      );
    }
    seen.add(patch.index);
  }

  return patches;
};

/** Next free patch number for a series (1-based). */
export const nextSeriesNumber = function nextSeriesNumber(
  patches: SeriesPatch[]
): number {
  let max = 0;
  for (const patch of patches) {
    max = Math.max(max, patch.index);
  }
  return max + 1;
};
