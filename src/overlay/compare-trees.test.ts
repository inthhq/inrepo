import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareTrees } from './compare-trees.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

describe('compareTrees', () => {
  let cwd: string;
  let left: string;
  let right: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-compare-');
    left = join(cwd, 'left');
    right = join(cwd, 'right');
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('detects added, removed, and modified files while ignoring vendor metadata', async () => {
    await writeFile(join(left, 'same.txt'), 'same\n', 'utf8');
    await writeFile(join(right, 'same.txt'), 'same\n', 'utf8');

    await writeFile(join(left, 'remove.txt'), 'gone\n', 'utf8');
    await writeFile(join(left, 'modify.txt'), 'left\n', 'utf8');
    await writeFile(join(right, 'modify.txt'), 'right\n', 'utf8');
    await writeFile(join(right, 'add.txt'), 'new\n', 'utf8');

    await writeFile(join(left, '.inrepo-vendor.json'), '{"commit":"a"}\n', 'utf8');
    await writeFile(join(right, '.inrepo-vendor.json'), '{"commit":"b"}\n', 'utf8');
    await mkdir(join(right, '.git'), { recursive: true });

    const result = await compareTrees(left, right);
    expect(result.added).toEqual(['add.txt']);
    expect(result.modified).toEqual(['modify.txt']);
    expect(result.removed).toEqual(['remove.txt']);
    expect(result.typeChanges).toEqual([]);
    expect(result.unchanged).toEqual(['same.txt']);
  });

  test('detects binary, executable-bit, and symlink target changes', async () => {
    await writeFile(join(left, 'bin.dat'), new Uint8Array([0, 1, 2]));
    await writeFile(join(right, 'bin.dat'), new Uint8Array([0, 1, 3]));

    await writeFile(join(left, 'script.sh'), '#!/bin/sh\necho left\n', 'utf8');
    await writeFile(join(right, 'script.sh'), '#!/bin/sh\necho left\n', 'utf8');
    await chmod(join(left, 'script.sh'), 0o644);
    await chmod(join(right, 'script.sh'), 0o755);

    await writeFile(join(left, 'target-a.txt'), 'a\n', 'utf8');
    await writeFile(join(left, 'target-b.txt'), 'b\n', 'utf8');
    await writeFile(join(right, 'target-a.txt'), 'a\n', 'utf8');
    await writeFile(join(right, 'target-b.txt'), 'b\n', 'utf8');
    await symlink('./target-a.txt', join(left, 'link.txt'));
    await symlink('./target-b.txt', join(right, 'link.txt'));

    const result = await compareTrees(left, right);
    expect(result.modified.sort()).toEqual(['bin.dat', 'link.txt', 'script.sh']);
  });

  test('reports file-to-directory type changes', async () => {
    await writeFile(join(left, 'swap'), 'file\n', 'utf8');
    await mkdir(join(right, 'swap'), { recursive: true });
    await writeFile(join(right, 'swap', 'nested.txt'), 'nested\n', 'utf8');

    const result = await compareTrees(left, right);
    expect(result.typeChanges).toEqual(['swap']);
    expect(result.added).toEqual(['swap/nested.txt']);
  });
});
