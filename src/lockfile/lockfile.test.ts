import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLockfile } from './read-lockfile.js';
import { writeLockfile } from './write-lockfile.js';
import { upsertLockModule } from './upsert-lock-module.js';
import { lockfilePath } from '../paths/lockfile-path.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

describe('lockfile read/write/upsert', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-lock-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('reads empty modules when file is missing', async () => {
    const lf = await readLockfile(cwd);
    expect(lf).toEqual({ lockfileVersion: 1, modules: {} });
  });

  test('round-trips through write/read', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: '1234567890abcdef1234567890abcdef12345678',
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.modules)).toEqual(['foo']);
    expect(lf.modules.foo.gitUrl).toBe('https://github.com/x/foo.git');
    const onDisk = await readFile(lockfilePath(cwd), 'utf8');
    expect(onDisk.endsWith('\n')).toBe(true);
  });

  test('upsertLockModule preserves existing entries and overwrites by key', async () => {
    await upsertLockModule(cwd, 'a', {
      source: 'a',
      gitUrl: 'https://github.com/x/a.git',
      commit: 'a'.repeat(40),
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await upsertLockModule(cwd, 'b', {
      source: 'b',
      gitUrl: 'https://github.com/x/b.git',
      commit: 'b'.repeat(40),
      ref: 'main',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await upsertLockModule(cwd, 'a', {
      source: 'a',
      gitUrl: 'https://github.com/x/a.git',
      commit: 'c'.repeat(40),
      ref: 'v1',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.modules).sort()).toEqual(['a', 'b']);
    expect(lf.modules.a.commit).toBe('c'.repeat(40));
    expect(lf.modules.a.ref).toBe('v1');
    expect(lf.modules.b.commit).toBe('b'.repeat(40));
  });

  test('rejects malformed JSON with a helpful message', async () => {
    await writeFile(lockfilePath(cwd), '{not json', 'utf8');
    await expect(readLockfile(cwd)).rejects.toThrow(/Invalid inrepo\.lock\.json/);
  });

  test('rejects non-object lockfile root', async () => {
    await writeFile(lockfilePath(cwd), JSON.stringify(['array', 'root']), 'utf8');
    await expect(readLockfile(cwd)).rejects.toThrow(/must be a JSON object/);
  });

  test('rejects unsupported lockfileVersion', async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 2, modules: {} }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/Unsupported lockfileVersion: 2/);
  });

  test('rejects modules that are not an object', async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 1, modules: ['not', 'object'] }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/"modules" must be an object/);
  });

  test('treats omitted modules as an empty record (does not throw)', async () => {
    await writeFile(lockfilePath(cwd), JSON.stringify({ lockfileVersion: 1 }), 'utf8');
    const lf = await readLockfile(cwd);
    expect(lf.modules).toEqual({});
  });

  test('upsertLockModule recovers a lockfile that has only lockfileVersion', async () => {
    await writeFile(lockfilePath(cwd), JSON.stringify({ lockfileVersion: 1 }), 'utf8');
    await upsertLockModule(cwd, 'a', {
      source: 'a',
      gitUrl: 'https://github.com/x/a.git',
      commit: 'a'.repeat(40),
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const lf = await readLockfile(cwd);
    expect(lf.modules.a?.commit).toBe('a'.repeat(40));
  });
});
