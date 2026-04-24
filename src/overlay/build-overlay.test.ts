import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyOverlay } from './apply-overlay.js';
import { buildOverlay } from './build-overlay.js';
import { readDeletionsFile } from './deletions-file.js';
import { compareTrees } from './compare-trees.js';
import { copyTree } from './tree-utils.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

describe('buildOverlay', () => {
  let cwd: string;
  let pristine: string;
  let moduleRoot: string;
  let overlay: string;
  let applied: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-overlay-build-');
    pristine = join(cwd, 'pristine');
    moduleRoot = join(cwd, 'module');
    overlay = join(cwd, 'inrepo_patches', 'upstream');
    applied = join(cwd, 'applied');

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
    await writeFile(join(pristine, 'assets', 'logo.bin'), new Uint8Array([0, 1, 2, 3]));
    await symlink('./README.md', join(pristine, 'readme-link'));

    await copyTree(pristine, moduleRoot);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('round-trips modified files, binaries, deletions, exec bits, and symlinks', async () => {
    await writeFile(join(moduleRoot, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(moduleRoot, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await writeFile(join(moduleRoot, 'assets', 'logo.bin'), new Uint8Array([9, 8, 7, 6]));
    await writeFile(join(moduleRoot, 'bin', 'tool.sh'), '#!/bin/sh\necho patched\n', 'utf8');
    await chmod(join(moduleRoot, 'bin', 'tool.sh'), 0o644);
    await rm(join(moduleRoot, 'docs', 'guide.md'));
    await rm(join(moduleRoot, 'readme-link'));
    await symlink('./src/index.ts', join(moduleRoot, 'readme-link'));

    await buildOverlay({
      pristineRoot: pristine,
      moduleRoot,
      overlayRoot: overlay,
    });

    expect(await readDeletionsFile(join(overlay, '.inrepo-deletions'))).toEqual(['docs/guide.md']);

    const deletions = await readDeletionsFile(join(overlay, '.inrepo-deletions'));
    await applyOverlay({
      pristineRoot: pristine,
      overlayRoot: overlay,
      deletions,
      targetRoot: applied,
    });

    const drift = await compareTrees(applied, moduleRoot);
    expect(drift.added).toEqual([]);
    expect(drift.modified).toEqual([]);
    expect(drift.removed).toEqual([]);
    expect(drift.typeChanges).toEqual([]);
    expect(await readlink(join(applied, 'readme-link'))).toBe('./src/index.ts');
  });

  test('collapses full-directory deletions into a single entry', async () => {
    await rm(join(moduleRoot, 'docs'), { recursive: true, force: true });

    await buildOverlay({
      pristineRoot: pristine,
      moduleRoot,
      overlayRoot: overlay,
    });

    expect(await readDeletionsFile(join(overlay, '.inrepo-deletions'))).toEqual(['docs/']);
  });
});
