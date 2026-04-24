import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLock } from './verify-lock.js';
import { writeLockfile } from '../lockfile/write-lockfile.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { runGit } from '../test-utils/run-git.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

async function writeConfig(
  cwd: string,
  entry: Record<string, unknown> = { name: 'upstream' },
): Promise<void> {
  await writeFile(join(cwd, 'inrepo.json'), `${JSON.stringify({ packages: [entry] }, null, 2)}\n`, 'utf8');
}

async function seedGeneratedModule(
  cwd: string,
  fx: LocalGitFixture,
  opts: {
    commit?: string;
    overlayIndex?: string;
  } = {},
): Promise<void> {
  const commit = opts.commit ?? fx.c1;
  const moduleDir = moduleDestPath(cwd, 'upstream');

  await writeConfig(cwd, { name: 'upstream', git: fx.url });
  await writeLockfile(cwd, {
    upstream: {
      source: 'upstream',
      gitUrl: fx.url,
      commit,
      ref: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  await runGit(['clone', fx.url, moduleDir]);
  await runGit(['checkout', commit], moduleDir);
  await rm(join(moduleDir, '.git'), { recursive: true, force: true });
  await writeFile(
    join(moduleDir, '.inrepo-vendor.json'),
    `${JSON.stringify({ commit: commit.toLowerCase(), gitUrl: fx.url })}\n`,
    'utf8',
  );

  if (opts.overlayIndex != null) {
    await mkdir(join(cwd, 'inrepo_patches', 'upstream', 'src'), { recursive: true });
    await writeFile(join(cwd, 'inrepo_patches', 'upstream', 'src', 'index.ts'), opts.overlayIndex, 'utf8');
    await writeFile(join(moduleDir, 'src', 'index.ts'), opts.overlayIndex, 'utf8');
  }
}

describe('verifyLock', () => {
  test('reports failure when lockfile has no modules', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    try {
    await writeLockfile(cwd, {});
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/No modules in inrepo\.lock\.json/);
    } finally {
      await cleanupTmpDir(cwd);
    }
  });

  test('passes for a generated module that matches lockfile plus overlay', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
      await seedGeneratedModule(cwd, fx, {
        overlayIndex: 'export const v = 10;\n',
      });
      expect(await verifyLock(cwd)).toEqual({ ok: true });
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });

  test('reports missing vendor directory', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
    await writeLockfile(cwd, {
      upstream: {
        source: 'upstream',
        gitUrl: fx.url,
        commit: fx.c1,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Missing directory for "upstream"/);
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });

  test('reports commit mismatch in vendor marker', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
      await seedGeneratedModule(cwd, fx);
      await writeFile(
        join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'),
        JSON.stringify({ commit: fx.c2, gitUrl: fx.url }, null, 2) + '\n',
        'utf8',
      );
      const r = await verifyLock(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/vendor marker commit .* does not match lock/);
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });

  test('reports tree drift when vendored files change after sync', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
      await seedGeneratedModule(cwd, fx);
      await writeFile(join(cwd, 'inrepo_modules', 'upstream', 'src', 'index.ts'), 'broken\n', 'utf8');
      const r = await verifyLock(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((line) => /vendored tree does not match lockfile \+ overlay/.test(line))).toBe(true);
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });

  test('cleans staged verify trees when the vendor marker is invalid', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
      await seedGeneratedModule(cwd, fx);
      await writeFile(join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'), 'null\n', 'utf8');

      const r = await verifyLock(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/invalid or empty \.inrepo-vendor\.json/);

      const verifyRoot = join(cwd, '.inrepo', 'verify');
      expect(existsSync(verifyRoot)).toBe(true);
      expect(await readdir(verifyRoot)).toEqual([]);
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });

  test('passes for a real git checkout when HEAD and origin match the lock entry', async () => {
    const cwd = await makeTmpDir('inrepo-verify-');
    const fx = await makeLocalGitFixture('inrepo-verify-fixture-');
    try {
      const dest = moduleDestPath(cwd, 'upstream');
      await runGit(['clone', fx.url, dest]);
      const commit = await runGit(['rev-parse', 'HEAD'], dest);
      await writeConfig(cwd, { name: 'upstream', git: fx.url });
      await writeLockfile(cwd, {
        upstream: {
          source: 'upstream',
          gitUrl: fx.url,
          commit,
          ref: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(await verifyLock(cwd)).toEqual({ ok: true });
    } finally {
      await fx.cleanup();
      await cleanupTmpDir(cwd);
    }
  });
});
