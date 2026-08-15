import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { applySeries } from './apply-series.js';
import { formatSeriesPatch } from './format-series-patch.js';
import { parsePatchHeader } from './read-patch-header.js';
import { readSeries } from './read-series.js';
import {
  continueSeriesRebase,
  rebaseInProgress,
  startSeriesRebase,
  writeRebasedSeries,
  type RebasedPatch,
} from './rebase-series.js';
import type { SeriesAuthor } from './series-git.js';

const AUTHOR: SeriesAuthor = { name: 'Series Author', email: 'series@example.com' };

const BASE_FILES = {
  'a.txt': 'a1\na2\na3\n',
  'b.txt': 'b1\n',
};

async function writeTree(root: string, files: Record<string, string>): Promise<string> {
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, 'utf8');
  }
  return root;
}

describe('startSeriesRebase / continueSeriesRebase', () => {
  let tmp: string;
  let seriesDir: string;
  let oldRoot: string;
  let repoRoot: string;

  /** A two-patch series over {@link BASE_FILES}, numbered 0003 and 0007. */
  async function seedSeries(): Promise<void> {
    const t1 = await writeTree(join(tmp, 't1'), { ...BASE_FILES, 'a.txt': 'a1\nPATCHED\na3\n' });
    const t2 = await writeTree(join(tmp, 't2'), {
      ...BASE_FILES,
      'a.txt': 'a1\nPATCHED\na3\n',
      'b.txt': 'b1\nb2\n',
    });

    await mkdir(seriesDir, { recursive: true });
    for (const [base, patched, subject, number] of [
      [oldRoot, t1, 'Patch the middle line', 3],
      [t1, t2, 'Extend b', 7],
    ] as const) {
      const patch = await formatSeriesPatch({
        baseRoot: base,
        patchedRoot: patched,
        subject,
        author: AUTHOR,
        startNumber: number,
      });
      await writeFile(join(seriesDir, patch.fileName), patch.content);
    }
  }

  beforeEach(async () => {
    tmp = await makeTmpDir('inrepo-rebase-unit-');
    seriesDir = join(tmp, 'series');
    repoRoot = join(tmp, 'update', 'repo');
    oldRoot = await writeTree(join(tmp, 'old'), BASE_FILES);
    await seedSeries();
  });

  afterEach(async () => {
    await cleanupTmpDir(tmp);
  });

  test('a clean rebase renumbers the series and keeps subject, author, and date', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), { ...BASE_FILES, 'c.txt': 'from upstream\n' });

    const { result } = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });

    expect(result.status).toBe('rebased');
    if (result.status !== 'rebased') return;
    expect(result.patches.map((patch) => patch.number)).toEqual([1, 2]);
    expect(result.patches.map((patch) => patch.subject)).toEqual([
      'Patch the middle line',
      'Extend b',
    ]);
    expect(result.patches.map((patch) => patch.fileName)).toEqual([
      '0001-Patch-the-middle-line.patch',
      '0002-Extend-b.patch',
    ]);

    const before = parsePatchHeader(
      { fileName: 'x', path: 'x', index: 3 },
      await readFile(join(seriesDir, '0003-Patch-the-middle-line.patch'), 'utf8'),
    );
    const after = parsePatchHeader(
      { fileName: 'x', path: 'x', index: 1 },
      result.patches[0].content.toString('utf8'),
    );
    expect(after.authorName).toBe(AUTHOR.name);
    expect(after.authorEmail).toBe(AUTHOR.email);
    expect(after.date).toBe(before.date);
  });

  test('the rebased series replays onto the new upstream tree', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), { ...BASE_FILES, 'c.txt': 'from upstream\n' });
    const { result } = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });
    if (result.status !== 'rebased') throw new Error('expected a clean rebase');

    const nextSeries = join(tmp, 'next-series');
    await writeRebasedSeries(nextSeries, result.patches);
    const patched = join(tmp, 'patched');
    await applySeries({ pristineRoot: newRoot, seriesDir: nextSeries, targetRoot: patched });

    expect(await readFile(join(patched, 'a.txt'), 'utf8')).toBe('a1\nPATCHED\na3\n');
    expect(await readFile(join(patched, 'b.txt'), 'utf8')).toBe('b1\nb2\n');
    expect(await readFile(join(patched, 'c.txt'), 'utf8')).toBe('from upstream\n');
  });

  test('a patch upstream already carries is dropped from the series', async () => {
    // Upstream made the exact change patch 0003 made.
    const newRoot = await writeTree(join(tmp, 'new'), {
      ...BASE_FILES,
      'a.txt': 'a1\nPATCHED\na3\n',
    });

    const { result } = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });

    expect(result.status).toBe('rebased');
    if (result.status !== 'rebased') return;
    expect(result.patches.map((patch) => patch.subject)).toEqual(['Extend b']);
    expect(result.patches[0].fileName).toBe('0001-Extend-b.patch');
  });

  test('a conflicting upstream change stops the rebase with the failing patch and files', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), {
      ...BASE_FILES,
      'a.txt': 'a1\nUPSTREAM\na3\n',
    });

    const { result } = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.number).toBe(1);
    expect(result.subject).toBe('Patch the middle line');
    expect(result.files).toEqual(['a.txt']);

    // The work tree carries ordinary git conflict markers.
    const conflicted = await readFile(join(repoRoot, 'a.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('UPSTREAM');
    expect(conflicted).toContain('PATCHED');
  });

  test('continue refuses to stage unresolved conflict markers', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), {
      ...BASE_FILES,
      'a.txt': 'a1\nUPSTREAM\na3\n',
    });
    const started = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });
    expect(started.result.status).toBe('conflict');

    await expect(
      continueSeriesRebase({ repoRoot, newBase: started.newBase, author: AUTHOR }),
    ).rejects.toThrow(/unresolved conflicts remain:[\s\S]*a\.txt/);

    expect(rebaseInProgress(repoRoot)).toBe(true);
    const conflicted = await readFile(join(repoRoot, 'a.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('UPSTREAM');
    expect(conflicted).toContain('PATCHED');
  });

  test('continue finishes the rebase once the conflict is resolved by hand', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), {
      ...BASE_FILES,
      'a.txt': 'a1\nUPSTREAM\na3\n',
    });
    const started = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });
    expect(started.result.status).toBe('conflict');

    await writeFile(join(repoRoot, 'a.txt'), 'a1\nRESOLVED\na3\n', 'utf8');
    const result = await continueSeriesRebase({
      repoRoot,
      newBase: started.newBase,
      author: AUTHOR,
    });

    expect(result.status).toBe('rebased');
    if (result.status !== 'rebased') return;
    expect(result.patches.map((patch) => patch.subject)).toEqual([
      'Patch the middle line',
      'Extend b',
    ]);

    const nextSeries = join(tmp, 'next-series');
    await writeRebasedSeries(nextSeries, result.patches);
    const patched = join(tmp, 'patched');
    await applySeries({ pristineRoot: newRoot, seriesDir: nextSeries, targetRoot: patched });
    expect(await readFile(join(patched, 'a.txt'), 'utf8')).toBe('a1\nRESOLVED\na3\n');
    expect(await readFile(join(patched, 'b.txt'), 'utf8')).toBe('b1\nb2\n');
  });

  test('continue drops a patch whose resolution left nothing to apply', async () => {
    const newRoot = await writeTree(join(tmp, 'new'), {
      ...BASE_FILES,
      'a.txt': 'a1\nUPSTREAM\na3\n',
    });
    const started = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot,
      resolveNewRoot: async () => newRoot,
      author: AUTHOR,
    });
    expect(started.result.status).toBe('conflict');

    // Resolving in favor of upstream leaves the patch with no effect.
    await writeFile(join(repoRoot, 'a.txt'), 'a1\nUPSTREAM\na3\n', 'utf8');
    const result = await continueSeriesRebase({ repoRoot, newBase: started.newBase });

    expect(result.status).toBe('rebased');
    if (result.status !== 'rebased') return;
    expect(result.patches.map((patch) => patch.subject)).toEqual(['Extend b']);
  });

  test('a series that does not apply to its own pin is refused', async () => {
    const wrongOld = await writeTree(join(tmp, 'wrong'), { 'a.txt': 'totally different\n' });
    await expect(
      startSeriesRebase({
        repoRoot,
        seriesDir,
        oldRoot: wrongOld,
        resolveNewRoot: async () => wrongOld,
        author: AUTHOR,
      }),
    ).rejects.toThrow(/does not apply to the pinned commit/);
  });

  test('the new upstream tree is only materialized after the old one is captured', async () => {
    const shared = join(tmp, 'shared');
    await writeTree(shared, BASE_FILES);
    const { result } = await startSeriesRebase({
      repoRoot,
      seriesDir,
      oldRoot: shared,
      // Stand-in for the pristine cache being refreshed in place.
      resolveNewRoot: async () => writeTree(shared, { ...BASE_FILES, 'c.txt': 'new\n' }),
      author: AUTHOR,
    });

    expect(result.status).toBe('rebased');
    if (result.status !== 'rebased') return;
    expect(result.patches).toHaveLength(2);
  });
});

describe('writeRebasedSeries', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmpDir('inrepo-write-series-');
  });

  afterEach(async () => {
    await cleanupTmpDir(tmp);
  });

  function patch(number: number, subject: string): RebasedPatch {
    const name = `${String(number).padStart(4, '0')}-${subject.replaceAll(' ', '-')}.patch`;
    return {
      number,
      subject,
      fileName: name,
      content: Buffer.from(`From 0 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] ${subject}\n`),
    };
  }

  test('replaces the previous series rather than merging with it', async () => {
    const seriesDir = join(tmp, 'series');
    await mkdir(seriesDir, { recursive: true });
    await writeFile(join(seriesDir, '0009-stale.patch'), 'stale\n', 'utf8');

    await writeRebasedSeries(seriesDir, [patch(1, 'first'), patch(2, 'second')]);

    expect((await readdir(seriesDir)).sort()).toEqual(['0001-first.patch', '0002-second.patch']);
    expect((await readSeries(seriesDir)).map((entry) => entry.index)).toEqual([1, 2]);
    expect((await readdir(tmp)).filter((name) => name.startsWith('.series-'))).toEqual([]);
  });

  test('removes the directory when every patch became redundant', async () => {
    const seriesDir = join(tmp, 'series');
    await mkdir(seriesDir, { recursive: true });
    await writeFile(join(seriesDir, '0001-old.patch'), 'old\n', 'utf8');

    await writeRebasedSeries(seriesDir, []);

    expect(existsSync(seriesDir)).toBe(false);
  });
});
