import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLockfile } from './read-lockfile.js';
import { writeLockfile } from './write-lockfile.js';
import { upsertLockGraph } from './upsert-lock-graph.js';
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
    expect(lf).toEqual({ lockfileVersion: 1, modules: {}, graph: {} });
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
      JSON.stringify({ lockfileVersion: 4, modules: {} }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/Unsupported lockfileVersion: 4/);
  });

  test('a project without a graph keeps writing lockfileVersion 1', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: 'a'.repeat(40),
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const onDisk = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as Record<string, unknown>;
    expect(onDisk.lockfileVersion).toBe(1);
    expect('graph' in onDisk).toBe(false);
  });

  test('round-trips a dependency graph and raises the lockfile version', async () => {
    const graph = {
      alpha: {
        version: '1.0.0',
        root: true,
        dependencies: { beta: { range: '^1.0.0', version: '1.2.0', module: 'beta' } },
      },
      beta: { version: '1.2.0' },
    };
    await writeLockfile(cwd, {}, graph);
    const onDisk = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as Record<string, unknown>;
    expect(onDisk.lockfileVersion).toBe(2);

    const lf = await readLockfile(cwd);
    expect(lf.lockfileVersion).toBe(2);
    expect(lf.graph).toEqual(graph);
  });

  test('round-trips repositoryDirectory and raises the lockfile to version 3', async () => {
    await writeLockfile(
      cwd,
      {
        '@scope/cli': {
          source: '@scope/cli',
          gitUrl: 'https://github.com/c15t/c15t.git',
          repositoryDirectory: './packages/cli/',
          commit: 'a'.repeat(40),
          ref: '@scope/cli@1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      { '@scope/cli': { version: '1.0.0', root: true } },
    );
    const onDisk = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as {
      lockfileVersion: number;
      modules: Record<string, { repositoryDirectory?: string }>;
    };
    expect(onDisk.lockfileVersion).toBe(3);
    expect(onDisk.modules['@scope/cli'].repositoryDirectory).toBe('packages/cli');
    expect((await readLockfile(cwd)).modules['@scope/cli'].repositoryDirectory).toBe(
      'packages/cli',
    );
  });

  test('accepts version 3 without a graph and treats old module entries as repository-rooted', async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({
        lockfileVersion: 3,
        modules: {
          root: {
            source: 'root',
            gitUrl: 'https://github.com/x/root.git',
            commit: 'a'.repeat(40),
            ref: null,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    const lock = await readLockfile(cwd);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.modules.root.repositoryDirectory).toBeUndefined();
  });

  test('rejects unsafe repositoryDirectory values while reading and writing', async () => {
    const module = {
      source: 'cli',
      gitUrl: 'https://github.com/x/workspace.git',
      repositoryDirectory: '../cli',
      commit: 'a'.repeat(40),
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await expect(writeLockfile(cwd, { cli: module })).rejects.toThrow(/traversal/);

    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 3, modules: { cli: module } }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/traversal/);
  });

  test('upsertLockModule preserves an existing graph', async () => {
    await writeLockfile(cwd, {}, { alpha: { version: '1.0.0', root: true } });
    await upsertLockModule(cwd, 'alpha', {
      source: 'alpha',
      gitUrl: 'https://github.com/x/alpha.git',
      commit: 'a'.repeat(40),
      ref: 'v1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const lf = await readLockfile(cwd);
    expect(lf.graph).toEqual({ alpha: { version: '1.0.0', root: true } });
    expect(lf.modules.alpha?.ref).toBe('v1.0.0');
  });

  test('upsertLockGraph merges nodes without dropping unrelated ones', async () => {
    await writeLockfile(cwd, {}, { alpha: { version: '1.0.0', root: true } });
    await upsertLockGraph(cwd, { beta: { version: '2.0.0' } });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.graph).sort()).toEqual(['alpha', 'beta']);
  });

  test('rejects a graph edge that is missing required fields', async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({
        lockfileVersion: 2,
        modules: {},
        graph: { alpha: { dependencies: { beta: { version: '1.0.0' } } } },
      }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(
      /graph\["alpha"\]\.dependencies\["beta"\] needs string "range" and "module"/,
    );
  });

  test('rejects a graph that is not an object', async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 2, modules: {}, graph: [] }),
      'utf8',
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/"graph" must be an object/);
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
