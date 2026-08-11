import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSeriesPatch } from '../series/format-series-patch.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { assemblePatchedTree } from './assemble-module.js';
import { overlayDirPath, seriesDirPath } from './overlay-paths.js';
import { copyTree } from './tree-utils.js';

const NAME = 'upstream';

describe('assemblePatchedTree', () => {
  let cwd: string;
  let pristine: string;
  let overlayRoot: string;
  let target: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-assemble-');
    pristine = join(cwd, 'pristine');
    overlayRoot = overlayDirPath(cwd, NAME);
    target = join(cwd, 'target');

    await mkdir(join(pristine, 'src'), { recursive: true });
    await mkdir(join(pristine, 'docs'), { recursive: true });
    await writeFile(join(pristine, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(pristine, 'docs', 'guide.md'), '# guide\n', 'utf8');
    await writeFile(join(pristine, 'docs', 'faq.md'), '# faq\n', 'utf8');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  async function writeLegacyOverlay(): Promise<void> {
    await mkdir(join(overlayRoot, 'src'), { recursive: true });
    await writeFile(join(overlayRoot, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(overlayRoot, '.inrepo-deletions'), 'docs/guide.md\n', 'utf8');
  }

  async function writeSeries(): Promise<void> {
    const patched = join(cwd, 'patched');
    await copyTree(pristine, patched);
    await writeFile(join(patched, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');
    await rm(join(patched, 'docs', 'faq.md'));

    const patch = await formatSeriesPatch({
      baseRoot: pristine,
      patchedRoot: patched,
      subject: 'Set value to three',
      startNumber: 1,
    });
    await mkdir(seriesDirPath(cwd, NAME), { recursive: true });
    await writeFile(join(seriesDirPath(cwd, NAME), patch.fileName), patch.content);
  }

  test('uses the legacy overlay when no series exists', async () => {
    await writeLegacyOverlay();

    await assemblePatchedTree({ cwd, name: NAME, pristineRoot: pristine, targetRoot: target });

    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 2;\n',
    );
    expect(existsSync(join(target, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(join(target, 'docs', 'faq.md'))).toBe(true);
  });

  test('uses the series when one exists and ignores leftover overlay files', async () => {
    await writeLegacyOverlay();
    await writeSeries();

    await assemblePatchedTree({ cwd, name: NAME, pristineRoot: pristine, targetRoot: target });

    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 3;\n',
    );
    expect(existsSync(join(target, 'docs', 'guide.md'))).toBe(true);
    expect(existsSync(join(target, 'docs', 'faq.md'))).toBe(false);
    expect(existsSync(join(target, 'series'))).toBe(false);
  });

  test('never copies the series directory into the patched tree', async () => {
    await writeLegacyOverlay();
    await mkdir(seriesDirPath(cwd, NAME), { recursive: true });
    await writeFile(join(seriesDirPath(cwd, NAME), 'notes.txt'), 'not a patch\n', 'utf8');

    await assemblePatchedTree({ cwd, name: NAME, pristineRoot: pristine, targetRoot: target });

    expect(existsSync(join(target, 'series'))).toBe(false);
    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 2;\n',
    );
  });
});
