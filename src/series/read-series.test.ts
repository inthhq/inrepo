import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { isSeriesPatchFileName, nextSeriesNumber, readSeries } from './read-series.js';

describe('readSeries', () => {
  let cwd: string;
  let seriesDir: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-series-read-');
    seriesDir = join(cwd, 'series');
    await mkdir(seriesDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('returns an empty list when the series directory is missing', async () => {
    expect(await readSeries(join(cwd, 'nope'))).toEqual([]);
  });

  test('orders patches by filename and ignores non-patch files', async () => {
    await writeFile(join(seriesDir, '0010-tenth.patch'), '', 'utf8');
    await writeFile(join(seriesDir, '0002-second.patch'), '', 'utf8');
    await writeFile(join(seriesDir, '0001-first.patch'), '', 'utf8');
    await writeFile(join(seriesDir, 'README.md'), 'notes\n', 'utf8');

    const patches = await readSeries(seriesDir);
    expect(patches.map((patch) => patch.fileName)).toEqual([
      '0001-first.patch',
      '0002-second.patch',
      '0010-tenth.patch',
    ]);
    expect(patches.map((patch) => patch.index)).toEqual([1, 2, 10]);
    expect(nextSeriesNumber(patches)).toBe(11);
  });

  test('rejects patch files that do not follow the numbering convention', async () => {
    await writeFile(join(seriesDir, 'fixup.patch'), '', 'utf8');
    await expect(readSeries(seriesDir)).rejects.toThrow(/expected NNNN-<slug>\.patch/);
  });

  test('rejects duplicate patch numbers', async () => {
    await writeFile(join(seriesDir, '0001-first.patch'), '', 'utf8');
    await writeFile(join(seriesDir, '0001-also-first.patch'), '', 'utf8');
    await expect(readSeries(seriesDir)).rejects.toThrow(/Duplicate patch number 0001/);
  });

  test('recognizes conventional patch names', () => {
    expect(isSeriesPatchFileName('0001-fix.patch')).toBe(true);
    expect(isSeriesPatchFileName('1-fix.patch')).toBe(false);
    expect(isSeriesPatchFileName('0001-fix.txt')).toBe(false);
  });

  test('numbers the first patch as 0001', () => {
    expect(nextSeriesNumber([])).toBe(1);
  });
});
