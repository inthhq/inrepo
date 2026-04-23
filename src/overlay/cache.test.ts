import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePristine } from './cache.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';

describe('ensurePristine', () => {
  let fx: LocalGitFixture | undefined;
  let cwd: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture('inrepo-cache-fixture-');
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-cache-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('builds the pristine cache at a pinned commit', async () => {
    const pristine = await ensurePristine({
      cwd,
      name: 'upstream',
      gitUrl: fx!.url,
      commit: fx!.c1,
      ref: null,
      keep: ['src', 'package.json'],
      exclude: [],
    });

    expect(pristine.commit).toBe(fx!.c1);
    expect(await readFile(join(pristine.dir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 1;\n');
    expect(existsSync(join(pristine.dir, 'package.json'))).toBe(true);
    expect(existsSync(join(pristine.dir, 'README.md'))).toBe(false);
  });

  test('rebuilds when the pinned commit or filters change', async () => {
    const first = await ensurePristine({
      cwd,
      name: 'upstream',
      gitUrl: fx!.url,
      commit: fx!.c1,
      ref: null,
      keep: ['src', 'package.json'],
      exclude: [],
    });
    expect(await readFile(join(first.dir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 1;\n');

    const second = await ensurePristine({
      cwd,
      name: 'upstream',
      gitUrl: fx!.url,
      commit: fx!.c2,
      ref: null,
      keep: ['src', 'package.json', 'CHANGELOG.md'],
      exclude: [],
    });
    expect(second.commit).toBe(fx!.c2);
    expect(await readFile(join(second.dir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 2;\n');
    expect(existsSync(join(second.dir, 'CHANGELOG.md'))).toBe(true);

    const third = await ensurePristine({
      cwd,
      name: 'upstream',
      gitUrl: fx!.url,
      commit: fx!.c2,
      ref: null,
      keep: ['src'],
      exclude: [],
    });
    expect(existsSync(join(third.dir, 'package.json'))).toBe(false);
  });
});
