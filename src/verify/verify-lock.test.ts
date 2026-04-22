import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
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

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Inrepo Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Inrepo Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Initialize a real git repo in the vendor dir for `name`, with one commit and an
 * `origin` remote, returning the resulting commit SHA. Used to exercise the
 * verifyLock branch that reads HEAD/origin via real git plumbing.
 */
async function seedGitCheckout(
  cwd: string,
  name: string,
  originUrl: string,
): Promise<string> {
  const dest = moduleDestPath(cwd, name);
  await mkdir(dest, { recursive: true });
  await runGit(['init', '-b', 'main'], dest);
  await writeFile(join(dest, 'README.md'), '# vendored\n', 'utf8');
  await runGit(['add', '.'], dest);
  await runGit(['commit', '-m', 'seed'], dest);
  await runGit(['remote', 'add', 'origin', originUrl], dest);
  return runGit(['rev-parse', 'HEAD'], dest);
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

  test('passes when .git HEAD and origin remote match the lock entry', async () => {
    const url = 'https://github.com/x/foo.git';
    const commit = await seedGitCheckout(cwd, 'foo', url);
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: url,
        commit,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(await verifyLock(cwd)).toEqual({ ok: true });
  });

  test('reports HEAD mismatch when .git is at a different commit than the lock entry', async () => {
    const url = 'https://github.com/x/foo.git';
    await seedGitCheckout(cwd, 'foo', url);
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: url,
        commit: COMMIT,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/HEAD .* does not match lock commit/);
  });

  test('reports origin URL mismatch when .git origin diverges from the lock entry', async () => {
    const lockUrl = 'https://github.com/x/foo.git';
    const checkoutUrl = 'https://github.com/other/foo.git';
    const commit = await seedGitCheckout(cwd, 'foo', checkoutUrl);
    await writeLockfile(cwd, {
      foo: {
        source: 'foo',
        gitUrl: lockUrl,
        commit,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/origin URL does not match lock/);
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
