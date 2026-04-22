import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listRelativePathsRecursive, pathDepth } from './vendor-tree-paths.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

describe('vendor-tree-paths', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-tree-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('listRelativePathsRecursive lists files and directories with POSIX separators', async () => {
    await mkdir(join(cwd, 'a', 'b'), { recursive: true });
    await writeFile(join(cwd, 'a', 'b', 'c.txt'), 'x', 'utf8');
    await writeFile(join(cwd, 'top.txt'), 'y', 'utf8');
    const list = await listRelativePathsRecursive(cwd);
    expect(list.sort()).toEqual(['a', 'a/b', 'a/b/c.txt', 'top.txt']);
  });

  test('listRelativePathsRecursive returns [] on an empty directory', async () => {
    expect(await listRelativePathsRecursive(cwd)).toEqual([]);
  });

  test('pathDepth counts segments (root-relative)', () => {
    expect(pathDepth('a')).toBe(1);
    expect(pathDepth('a/b')).toBe(2);
    expect(pathDepth('a/b/c')).toBe(3);
  });
});
