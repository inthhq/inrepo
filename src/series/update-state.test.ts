import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateDirPath, updateStatePath } from '../overlay/overlay-paths.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import {
  clearUpdate,
  isUpdateInProgress,
  readUpdateState,
  writeUpdateState,
  type UpdateState,
} from './update-state.js';

function sampleState(name: string): UpdateState {
  return {
    name,
    gitUrl: 'https://example.test/repo.git',
    oldCommit: 'a'.repeat(40),
    newCommit: 'b'.repeat(40),
    ref: 'main',
    persistRef: true,
    newBase: 'c'.repeat(40),
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('update state', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-update-state-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('round-trips through .inrepo/updates/<package>/state.json', async () => {
    expect(isUpdateInProgress(cwd, 'pkg')).toBe(false);
    expect(await readUpdateState(cwd, 'pkg')).toBeNull();

    await writeUpdateState(cwd, 'pkg', sampleState('pkg'));

    expect(updateStatePath(cwd, 'pkg')).toBe(join(cwd, '.inrepo', 'updates', 'pkg', 'state.json'));
    expect(isUpdateInProgress(cwd, 'pkg')).toBe(true);
    expect(await readUpdateState(cwd, 'pkg')).toEqual(sampleState('pkg'));
  });

  test('keeps scoped packages in their own directory', async () => {
    await writeUpdateState(cwd, '@scope/pkg', sampleState('@scope/pkg'));
    expect(updateDirPath(cwd, '@scope/pkg')).toBe(
      join(cwd, '.inrepo', 'updates', '@scope', 'pkg'),
    );
    expect(isUpdateInProgress(cwd, '@scope/pkg')).toBe(true);
    expect(isUpdateInProgress(cwd, 'pkg')).toBe(false);
  });

  test('clearing removes the scratch repository along with the state', async () => {
    await writeUpdateState(cwd, 'pkg', sampleState('pkg'));
    const repoFile = join(updateDirPath(cwd, 'pkg'), 'repo', 'file.txt');
    await mkdir(join(updateDirPath(cwd, 'pkg'), 'repo'), { recursive: true });
    await writeFile(repoFile, 'work in progress\n', 'utf8');

    await clearUpdate(cwd, 'pkg');

    expect(existsSync(updateDirPath(cwd, 'pkg'))).toBe(false);
    expect(isUpdateInProgress(cwd, 'pkg')).toBe(false);
  });

  test('rejects a state file that is missing required fields', async () => {
    await mkdir(updateDirPath(cwd, 'pkg'), { recursive: true });
    await writeFile(updateStatePath(cwd, 'pkg'), '{"name":"pkg"}\n', 'utf8');
    await expect(readUpdateState(cwd, 'pkg')).rejects.toThrow(/missing required field "gitUrl"/);
  });

  test('rejects a state file that is not JSON', async () => {
    await mkdir(updateDirPath(cwd, 'pkg'), { recursive: true });
    await writeFile(updateStatePath(cwd, 'pkg'), '{ broken', 'utf8');
    await expect(readUpdateState(cwd, 'pkg')).rejects.toThrow(/Invalid update state/);
  });
});
