import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upsertLockModule } from '../lockfile/upsert-lock-module.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { selectPackages } from './package-selection.js';

describe('selectPackages repository source', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-package-selection-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('does not merge a locked directory into a configured different repository', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [{ name: 'pkg', git: 'https://new.example/pkg.git' }] })}\n`,
      'utf8',
    );
    await upsertLockModule(cwd, 'pkg', {
      source: 'pkg',
      gitUrl: 'https://old.example/monorepo.git',
      repositoryDirectory: 'packages/pkg',
      commit: 'a'.repeat(40),
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const selected = await selectPackages(cwd, 'pkg', 'sync');
    expect(selected.packages).toEqual([{ name: 'pkg', git: 'https://new.example/pkg.git' }]);
  });

  test('inherits a locked directory when configured and locked URLs normalize equally', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [{ name: 'pkg', git: 'git+https://EXAMPLE.com/mono.git' }] })}\n`,
      'utf8',
    );
    await upsertLockModule(cwd, 'pkg', {
      source: 'pkg',
      gitUrl: 'https://example.com/mono',
      repositoryDirectory: 'packages/pkg',
      commit: 'a'.repeat(40),
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const selected = await selectPackages(cwd, 'pkg', 'sync');
    expect(selected.packages[0]?.repositoryDirectory).toBe('packages/pkg');
  });
});
