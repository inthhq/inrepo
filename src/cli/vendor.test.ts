import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { makeLocalGitFixture, type LocalGitFixture } from '../test-utils/local-git-fixture.js';
import { materializePackage } from './vendor.js';

describe('materializePackage repository source selection', () => {
  let cwd: string;
  let oldRepository: LocalGitFixture;
  let newRepository: LocalGitFixture;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-vendor-source-');
    oldRepository = await makeLocalGitFixture('inrepo-vendor-old-source-');
    newRepository = await makeLocalGitFixture('inrepo-vendor-new-source-');
  });

  afterEach(async () => {
    await Promise.all([cleanupTmpDir(cwd), oldRepository.cleanup(), newRepository.cleanup()]);
  });

  test('does not inherit a locked repositoryDirectory after git changes repositories', async () => {
    await materializePackage(
      cwd,
      { name: 'upstream', git: newRepository.url },
      [],
      [],
      {
        mode: 'sync',
        force: false,
        lockEntry: {
          source: 'upstream',
          gitUrl: oldRepository.url,
          repositoryDirectory: 'packages/upstream',
          commit: oldRepository.c2,
          ref: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    );

    const moduleRoot = join(cwd, 'inrepo_modules', 'upstream');
    expect(await readFile(join(moduleRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 2;\n',
    );
    expect(existsSync(join(moduleRoot, 'packages'))).toBe(false);

    const lock = JSON.parse(await readFile(join(cwd, 'inrepo.lock.json'), 'utf8')) as {
      modules: Record<string, { gitUrl: string; repositoryDirectory?: string }>;
    };
    expect(lock.modules.upstream.gitUrl).toBe(newRepository.url);
    expect(lock.modules.upstream.repositoryDirectory).toBeUndefined();
  });
});
