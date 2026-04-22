import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLock } from './verify-lock.js';
import { writeLockfile } from '../lockfile/write-lockfile.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

const COMMIT = 'a'.repeat(40);

async function seedVendorMarker(
  cwd: string,
  name: string,
  marker: { commit: string; gitUrl: string },
): Promise<void> {
  const dest = moduleDestPath(cwd, name);
  await mkdir(dest, { recursive: true });
  await writeFile(
    join(dest, '.inrepo-vendor.json'),
    JSON.stringify(marker, null, 2) + '\n',
    'utf8',
  );
}

describe('verifyLock', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-verify-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('reports failure when lockfile has no modules', async () => {
    await writeLockfile(cwd, {});
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/No modules in inrepo\.lock\.json/);
  });

  test('passes when vendor marker matches lock entry', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedVendorMarker(cwd, 'foo', {
      commit: COMMIT,
      gitUrl: 'https://github.com/x/foo.git',
    });
    expect(await verifyLock(cwd)).toEqual({ ok: true });
  });

  test('reports missing vendor directory', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Missing directory for "foo"/);
  });

  test('reports commit mismatch in vendor marker', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedVendorMarker(cwd, 'foo', {
      commit: 'b'.repeat(40),
      gitUrl: 'https://github.com/x/foo.git',
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/vendor marker commit .* does not match lock/);
  });

  test('reports gitUrl mismatch (after normalization) in vendor marker', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedVendorMarker(cwd, 'foo', {
      commit: COMMIT,
      gitUrl: 'https://github.com/other/foo.git',
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/vendor marker gitUrl does not match lock/);
  });

  test('passes when vendor marker gitUrl is the ssh form of the same repo', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await seedVendorMarker(cwd, 'foo', {
      commit: COMMIT,
      gitUrl: 'git@github.com:x/foo.git',
    });
    expect(await verifyLock(cwd)).toEqual({ ok: true });
  });

  test('reports invalid vendor marker JSON', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const dest = moduleDestPath(cwd, 'foo');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, '.inrepo-vendor.json'), '{ broken', 'utf8');
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/invalid or empty \.inrepo-vendor\.json/);
  });

  test('reports missing .git and missing vendor marker', async () => {
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: 'https://github.com/x/foo.git',
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const dest = moduleDestPath(cwd, 'foo');
    await mkdir(dest, { recursive: true });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0]).toMatch(/has no \.git and no \.inrepo-vendor\.json/);
  });
});
