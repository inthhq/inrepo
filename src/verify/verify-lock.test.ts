import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyLock } from './verify-lock.js';
import { writeLockfile } from '../lockfile/write-lockfile.js';
import { assembleModuleTree } from '../overlay/assemble-module.js';
import { ensurePristine } from '../overlay/cache.js';
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

  if (opts.overlayIndex != null) {
    await mkdir(join(cwd, 'inrepo_patches', 'upstream', 'src'), { recursive: true });
    await writeFile(join(cwd, 'inrepo_patches', 'upstream', 'src', 'index.ts'), opts.overlayIndex, 'utf8');
  }

  const pristine = await ensurePristine({
    cwd,
    name: 'upstream',
    gitUrl: fx.url,
    commit,
    ref: null,
    keep: [],
    exclude: [],
  });
  await assembleModuleTree({
    cwd,
    name: 'upstream',
    pristineRoot: pristine.dir,
    commit,
    gitUrl: fx.url,
    targetRoot: moduleDestPath(cwd, 'upstream'),
  });
}

describe('verifyLock', () => {
  let fx: LocalGitFixture | undefined;
  let cwd: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture('inrepo-verify-fixture-');
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

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

  test('passes for a generated module that matches lockfile plus overlay', async () => {
    await seedGeneratedModule(cwd, fx!, {
      overlayIndex: 'export const v = 10;\n',
    });
    expect(await verifyLock(cwd)).toEqual({ ok: true });
  });

  test('reports missing vendor directory', async () => {
    await writeLockfile(cwd, {
      upstream: {
        source: 'upstream',
        gitUrl: fx!.url,
        commit: fx!.c1,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Missing directory for "upstream"/);
  });

  test('reports commit mismatch in vendor marker', async () => {
    await seedGeneratedModule(cwd, fx!);
    await writeFile(
      join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'),
      JSON.stringify({ commit: fx!.c2, gitUrl: fx!.url }, null, 2) + '\n',
      'utf8',
    );
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/vendor marker commit .* does not match lock/);
  });

  test('reports tree drift when vendored files change after sync', async () => {
    await seedGeneratedModule(cwd, fx!);
    await writeFile(join(cwd, 'inrepo_modules', 'upstream', 'src', 'index.ts'), 'broken\n', 'utf8');
    const r = await verifyLock(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((line) => /vendored tree does not match lockfile \+ overlay/.test(line))).toBe(true);
  });

  test('passes for a real git checkout when HEAD and origin match the lock entry', async () => {
    const dest = moduleDestPath(cwd, 'upstream');
    await runGit(['clone', fx!.url, dest]);
    const commit = await runGit(['rev-parse', 'HEAD'], dest);
    await writeConfig(cwd, { name: 'upstream', git: fx!.url });
    await writeLockfile(cwd, {
      upstream: {
        source: 'upstream',
        gitUrl: fx!.url,
        commit,
        ref: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(await verifyLock(cwd)).toEqual({ ok: true });
  });
});
