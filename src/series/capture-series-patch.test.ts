import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seriesDirPath } from '../overlay/overlay-paths.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { applySeries } from './apply-series.js';
import { captureSeriesPatch } from './capture-series-patch.js';
import { comparePatchedTrees } from './compare-patched-trees.js';
import { readPatchHeader } from './read-patch-header.js';
import { readSeries } from './read-series.js';

const AUTHOR = { name: 'Test Author', email: 'test@example.com' };

describe('captureSeriesPatch', () => {
  let cwd: string;
  let pristine: string;
  let module: string;
  let seriesDir: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-capture-');
    pristine = join(cwd, 'pristine');
    module = join(cwd, 'inrepo_modules', 'upstream');
    seriesDir = seriesDirPath(cwd, 'upstream');

    await mkdir(join(pristine, 'src'), { recursive: true });
    await writeFile(join(pristine, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
    await writeFile(join(pristine, 'README.md'), '# upstream\n', 'utf8');
    // Cache metadata sits next to a real pristine checkout and must stay out of
    // the patch surface.
    await writeFile(join(pristine, '.cache-meta.json'), '{}\n', 'utf8');

    await mkdir(join(module, 'src'), { recursive: true });
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
    await writeFile(join(module, 'README.md'), '# upstream\n', 'utf8');
    // The generated marker sync writes into inrepo_modules must not be captured.
    await writeFile(join(module, '.inrepo-vendor.json'), '{"commit":"abc"}\n', 'utf8');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  function capture(subject: string) {
    return captureSeriesPatch({
      cwd,
      name: 'upstream',
      pristineRoot: pristine,
      moduleRoot: module,
      subject,
      author: AUTHOR,
    });
  }

  test('reports nothing to capture when the module matches the patched tree', async () => {
    expect(await capture('No-op')).toEqual({ captured: false });
    expect(existsSync(seriesDir)).toBe(false);
  });

  test('ignores the generated vendor marker and cache metadata', async () => {
    await writeFile(join(module, '.inrepo-vendor.json'), '{"commit":"changed"}\n', 'utf8');
    expect(await capture('No-op')).toEqual({ captured: false });
  });

  test('writes the first capture as 0001 with the message as the subject', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');

    const result = await capture('Bump the exported version');
    expect(result.captured).toBe(true);
    if (!result.captured) throw new Error('unreachable');

    expect(result.number).toBe(1);
    expect(result.patchFileName).toBe('0001-Bump-the-exported-version.patch');
    expect(await readdir(seriesDir)).toEqual(['0001-Bump-the-exported-version.patch']);

    const header = await readPatchHeader((await readSeries(seriesDir))[0]);
    expect(header.subject).toBe('Bump the exported version');
    expect(header.authorName).toBe('Test Author');
    expect(header.authorEmail).toBe('test@example.com');
    expect(header.files).toEqual(['src/index.ts']);
  });

  test('replaying the captured series reproduces the module tree', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await writeFile(join(module, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await writeFile(join(module, 'logo.bin'), new Uint8Array([9, 8, 7, 6]));
    await rm(join(module, 'README.md'));

    expect((await capture('Capture edits')).captured).toBe(true);

    const replayed = join(cwd, 'replayed');
    await applySeries({ pristineRoot: pristine, seriesDir, targetRoot: replayed });
    expect((await comparePatchedTrees(replayed, module)).differences).toEqual([]);
  });

  test('numbers sequential captures and records only the new delta', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    expect((await capture('First change')).captured).toBe(true);

    await writeFile(join(module, 'src', 'other.ts'), 'export const other = 1;\n', 'utf8');
    const second = await capture('Second change');
    if (!second.captured) throw new Error('unreachable');
    expect(second.number).toBe(2);

    await writeFile(join(module, 'README.md'), '# patched\n', 'utf8');
    const third = await capture('Third change');
    if (!third.captured) throw new Error('unreachable');
    expect(third.number).toBe(3);

    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-First-change.patch',
      '0002-Second-change.patch',
      '0003-Third-change.patch',
    ]);

    const headers = [];
    for (const patch of await readSeries(seriesDir)) headers.push(await readPatchHeader(patch));
    expect(headers.map((header) => header.files)).toEqual([
      ['src/index.ts'],
      ['src/other.ts'],
      ['README.md'],
    ]);

    const replayed = join(cwd, 'replayed');
    await applySeries({ pristineRoot: pristine, seriesDir, targetRoot: replayed });
    expect((await comparePatchedTrees(replayed, module)).differences).toEqual([]);
  });

  test('captures nothing when a later run reverts back to the patched tree', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    expect((await capture('First change')).captured).toBe(true);
    expect(await capture('Nothing new')).toEqual({ captured: false });
    expect((await readdir(seriesDir)).length).toBe(1);
  });

  test('rejects an empty message', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await expect(capture('   ')).rejects.toThrow(/without a patch message/);
  });

  test('falls back to a usable file name when the subject has no slug', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    const result = await capture('...');
    if (!result.captured) throw new Error('unreachable');
    expect(result.patchFileName).toBe('0001-patch.patch');
    expect((await readSeries(seriesDir)).map((patch) => patch.fileName)).toEqual([
      '0001-patch.patch',
    ]);
  });

  test('reports empty directories git cannot record', async () => {
    await mkdir(join(module, 'generated'), { recursive: true });
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');

    const result = await capture('Add an empty directory');
    if (!result.captured) throw new Error('unreachable');
    expect(result.droppedEmptyDirectories).toEqual(['generated']);
  });

  test('records the patch as standard format-patch output', async () => {
    await writeFile(join(module, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    const result = await capture('Bump the exported version');
    if (!result.captured) throw new Error('unreachable');

    const content = await readFile(result.patchPath, 'utf8');
    expect(content).toMatch(/^From /);
    expect(content).toContain('From: Test Author <test@example.com>');
    expect(content).toContain('Subject: [PATCH] Bump the exported version');
    expect(content).not.toContain('.inrepo-vendor.json');
    expect(content).not.toContain('.cache-meta.json');
  });
});
