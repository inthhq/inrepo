import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePristine } from './cache.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';
import { runGit } from '../test-utils/run-git.js';

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

  test('creates the cache parent for a scoped package', async () => {
    const pristine = await ensurePristine({
      cwd,
      name: '@scope/upstream',
      gitUrl: fx!.url,
      commit: fx!.c1,
      ref: null,
      keep: [],
      exclude: [],
    });

    expect(pristine.dir).toBe(join(cwd, '.inrepo', 'cache', '@scope', 'upstream'));
    expect(await readFile(join(pristine.dir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 1;\n',
    );
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

  test('shares an exact repository snapshot while projecting package-relative views', async () => {
    const mono = await makeLocalGitFixture('inrepo-cache-monorepo-');
    try {
      const commit = await mono.commitUpstream(
        {
          'packages/a/package.json': '{"name":"@scope/a"}\n',
          'packages/a/src/index.ts': 'export const packageName = "a";\n',
          'packages/a/docs/a.md': '# a\n',
          'packages/b/package.json': '{"name":"@scope/b"}\n',
          'packages/b/src/index.ts': 'export const packageName = "b";\n',
        },
        'add workspace packages',
      );

      const first = await ensurePristine({
        cwd,
        name: '@scope/a',
        gitUrl: mono.url,
        repositoryDirectory: 'packages/a',
        commit,
        keep: ['package.json', 'src'],
        exclude: [],
      });
      expect(await readFile(join(first.dir, 'src', 'index.ts'), 'utf8')).toContain('"a"');
      expect(existsSync(join(first.dir, 'docs'))).toBe(false);
      expect(existsSync(join(first.dir, 'packages'))).toBe(false);

      // Prove the second package uses the raw content-addressed snapshot rather
      // than cloning the same repository commit again.
      await rename(mono.url, `${mono.url}.offline`);
      const second = await ensurePristine({
        cwd,
        name: '@scope/b',
        gitUrl: mono.url,
        repositoryDirectory: 'packages/b',
        commit,
        keep: [],
        exclude: [],
      });
      expect(await readFile(join(second.dir, 'src', 'index.ts'), 'utf8')).toContain('"b"');

      // repositoryDirectory participates in package-view invalidation too.
      const retargeted = await ensurePristine({
        cwd,
        name: '@scope/a',
        gitUrl: mono.url,
        repositoryDirectory: 'packages/b',
        commit,
        keep: [],
        exclude: [],
      });
      expect(await readFile(join(retargeted.dir, 'src', 'index.ts'), 'utf8')).toContain('"b"');
    } finally {
      await mono.cleanup();
    }
  });

  test('rejects a package-subtree symlink that escapes to another repository path', async () => {
    const mono = await makeLocalGitFixture('inrepo-cache-symlink-');
    try {
      await mono.commitUpstream(
        { 'packages/a/package.json': '{"name":"a"}\n' },
        'add workspace package',
      );
      await symlink('../../README.md', join(mono.work, 'packages', 'a', 'leak'));
      await runGit(['add', '--all', '.'], mono.work);
      await runGit(['commit', '-m', 'add escaping symlink'], mono.work);
      await runGit(['push', 'origin', 'HEAD'], mono.work);
      const commit = await runGit(['rev-parse', 'HEAD'], mono.work);

      await expect(
        ensurePristine({
          cwd,
          name: 'a',
          gitUrl: mono.url,
          repositoryDirectory: 'packages/a',
          commit,
          keep: [],
          exclude: [],
        }),
      ).rejects.toThrow(/symlink escaping module root at "leak"/);
    } finally {
      await mono.cleanup();
    }
  });
});
