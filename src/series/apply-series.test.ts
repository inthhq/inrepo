import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyTree } from '../overlay/tree-utils.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { applySeries } from './apply-series.js';
import { comparePatchedTrees } from './compare-patched-trees.js';
import { formatSeriesPatch } from './format-series-patch.js';

async function writePatch(
  seriesDir: string,
  opts: { baseRoot: string; patchedRoot: string; subject: string; startNumber: number },
): Promise<string> {
  const patch = await formatSeriesPatch(opts);
  await mkdir(seriesDir, { recursive: true });
  await writeFile(join(seriesDir, patch.fileName), patch.content);
  return patch.fileName;
}

describe('applySeries', () => {
  let cwd: string;
  let pristine: string;
  let seriesDir: string;
  let target: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-series-apply-');
    pristine = join(cwd, 'pristine');
    seriesDir = join(cwd, 'series');
    target = join(cwd, 'target');

    await mkdir(join(pristine, 'src'), { recursive: true });
    await mkdir(join(pristine, 'docs'), { recursive: true });
    await mkdir(join(pristine, 'bin'), { recursive: true });
    await mkdir(join(pristine, 'assets'), { recursive: true });
    await writeFile(join(pristine, 'README.md'), '# upstream\n', 'utf8');
    await writeFile(join(pristine, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(pristine, 'docs', 'guide.md'), '# guide\n', 'utf8');
    await writeFile(join(pristine, 'docs', 'faq.md'), '# faq\n', 'utf8');
    await writeFile(join(pristine, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n', 'utf8');
    await chmod(join(pristine, 'bin', 'tool.sh'), 0o755);
    await writeFile(join(pristine, 'bin', 'plain.sh'), '#!/bin/sh\necho plain\n', 'utf8');
    await writeFile(join(pristine, 'assets', 'logo.bin'), new Uint8Array([0, 1, 2, 3, 255, 0]));
    await symlink('./README.md', join(pristine, 'readme-link'));
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('applies an ordered series covering text, binary, deletions, symlinks, and modes', async () => {
    const first = join(cwd, 'first');
    await copyTree(pristine, first);
    await writeFile(join(first, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(first, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await rm(join(first, 'docs', 'guide.md'));

    const second = join(cwd, 'second');
    await copyTree(first, second);
    await writeFile(join(second, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');
    await writeFile(join(second, 'assets', 'logo.bin'), new Uint8Array([9, 8, 7, 6, 0, 254]));
    await chmod(join(second, 'bin', 'plain.sh'), 0o755);
    await chmod(join(second, 'bin', 'tool.sh'), 0o644);
    await rm(join(second, 'readme-link'));
    await symlink('./src/index.ts', join(second, 'readme-link'));

    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      subject: 'Bump value and drop the guide',
      startNumber: 1,
    });
    await writePatch(seriesDir, {
      baseRoot: first,
      patchedRoot: second,
      subject: 'Swap the binary asset and flip modes',
      startNumber: 2,
    });

    const { applied } = await applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target });
    expect(applied.map((patch) => patch.fileName)).toEqual([
      '0001-Bump-value-and-drop-the-guide.patch',
      '0002-Swap-the-binary-asset-and-flip-modes.patch',
    ]);

    expect((await comparePatchedTrees(second, target)).differences).toEqual([]);
    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 3;\n',
    );
    expect(new Uint8Array(await readFile(join(target, 'assets', 'logo.bin')))).toEqual(
      new Uint8Array([9, 8, 7, 6, 0, 254]),
    );
    expect(existsSync(join(target, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(join(target, 'docs', 'faq.md'))).toBe(true);
    expect(await readlink(join(target, 'readme-link'))).toBe('./src/index.ts');
    expect(((await lstat(join(target, 'bin', 'plain.sh'))).mode & 0o111) !== 0).toBe(true);
    expect(((await lstat(join(target, 'bin', 'tool.sh'))).mode & 0o111) !== 0).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(false);
  });

  test('applies patches in filename order, not creation order', async () => {
    const first = join(cwd, 'first');
    await copyTree(pristine, first);
    await writeFile(join(first, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');

    const second = join(cwd, 'second');
    await copyTree(first, second);
    await writeFile(join(second, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');

    const one = await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      subject: 'Set value to two',
      startNumber: 1,
    });
    const two = await writePatch(seriesDir, {
      baseRoot: first,
      patchedRoot: second,
      subject: 'Set value to three',
      startNumber: 2,
    });

    // Applied in order this series is fine; swapping the numeric prefixes makes
    // the dependent patch run first, which cannot apply to the upstream tree.
    expect(
      (await applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target })).applied.map(
        (patch) => patch.fileName,
      ),
    ).toEqual([one, two]);
    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe(
      'export const value = 3;\n',
    );

    await rename(join(seriesDir, one), join(seriesDir, 'staged.tmp'));
    await rename(join(seriesDir, two), join(seriesDir, '0001-set-value-to-three.patch'));
    await rename(join(seriesDir, 'staged.tmp'), join(seriesDir, '0002-set-value-to-two.patch'));

    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target }),
    ).rejects.toThrow(/Failed to apply 0001-set-value-to-three\.patch/);
  });

  test('reports which patch failed and leaves no in-flight git am state', async () => {
    const first = join(cwd, 'first');
    await copyTree(pristine, first);
    await writeFile(join(first, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      subject: 'Set value to two',
      startNumber: 1,
    });

    // The patch was generated against a file that no longer exists upstream.
    const movedUpstream = join(cwd, 'moved-upstream');
    await copyTree(pristine, movedUpstream);
    await rm(join(movedUpstream, 'src', 'index.ts'));

    await expect(
      applySeries({ pristineRoot: movedUpstream, seriesDir, targetRoot: target }),
    ).rejects.toThrow(/Failed to apply 0001-Set-value-to-two\.patch/);
    expect(existsSync(join(target, '.git', 'rebase-apply'))).toBe(false);
  });

  test('rejects a patch that introduces a symlink escaping the module root', async () => {
    const escaping = join(cwd, 'escaping');
    await copyTree(pristine, escaping);
    await symlink('../../etc/passwd', join(escaping, 'src', 'escape-link'));
    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: escaping,
      subject: 'Add an escaping symlink',
      startNumber: 1,
    });

    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target }),
    ).rejects.toThrow(/Refusing to apply symlink escaping module root at "src\/escape-link"/);
  });

  test('rejects a series directory with no patches', async () => {
    await mkdir(seriesDir, { recursive: true });
    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target }),
    ).rejects.toThrow(/No patches found/);
  });
});
