import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrapHostPackageJson,
  envFor,
  readConfig,
  readJson,
  writeConfig,
} from '../test-utils/e2e-harness.js';
import { makeLocalGitFixture, type LocalGitFixture } from '../test-utils/local-git-fixture.js';
import { runCli } from '../test-utils/run-cli.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

const MODE = 'inrepo.json';

describe('CLI: update workflow (e2e)', () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let overlayDir: string;
  let seriesDir: string;
  let updateDir: string;

  beforeEach(async () => {
    // Each test moves upstream, so the fixture cannot be shared.
    fx = await makeLocalGitFixture('inrepo-update-');
    cwd = await makeTmpDir('inrepo-update-e2e-');
    moduleDir = join(cwd, 'inrepo_modules', 'upstream');
    overlayDir = join(cwd, 'inrepo_patches', 'upstream');
    seriesDir = join(overlayDir, 'series');
    updateDir = join(cwd, '.inrepo', 'updates', 'upstream');
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, { packages: [{ name: 'upstream', git: fx.url, ref: 'main' }] });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
    await fx.cleanup();
  });

  function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { cwd, env: envFor(MODE) });
  }

  async function lockCommit(): Promise<string> {
    const lock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string; ref: string | null }>;
    };
    return lock.modules.upstream.commit;
  }

  async function lockRef(): Promise<string | null> {
    const lock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { ref: string | null }>;
    };
    return lock.modules.upstream.ref;
  }

  /** Sync, then capture two patches: one on `src/index.ts`, one adding a file. */
  async function syncAndPatch(): Promise<void> {
    expect((await cli(['sync'])).exitCode).toBe(0);
    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 42;\n', 'utf8');
    expect((await cli(['patch', 'upstream', '-m', 'Bump the exported version'])).exitCode).toBe(0);
    await writeFile(join(moduleDir, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    expect((await cli(['patch', 'upstream', '-m', 'Add a local helper'])).exitCode).toBe(0);
  }

  test('rebases the series onto a moved upstream and updates pin, lockfile, and module', async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const moved = await fx.commitUpstream(
      { 'README.md': '# upstream v3\n', 'docs/new.md': '# new\n' },
      'move upstream',
    );

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(`Updated "upstream" ${before.slice(0, 7)} → ${moved.slice(0, 7)} (main)`);
    expect(update.stdout).toMatch(/0001 {2}Bump the exported version/);
    expect(update.stdout).toMatch(/0002 {2}Add a local helper/);
    expect(update.stdout).toContain('Review the result with: inrepo diff upstream');

    // The series is renumbered from 0001 and keeps its subjects.
    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Bump-the-exported-version.patch',
      '0002-Add-a-local-helper.patch',
    ]);
    const first = await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'), 'utf8');
    expect(first).toContain('Subject: [PATCH] Bump the exported version');

    // The pin moved and the generated module carries upstream plus the patches.
    expect(await lockCommit()).toBe(moved);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );
    expect(await readFile(join(moduleDir, 'src', 'local.ts'), 'utf8')).toBe(
      'export const local = true;\n',
    );
    expect(await readFile(join(moduleDir, 'README.md'), 'utf8')).toBe('# upstream v3\n');
    expect(await readFile(join(moduleDir, 'docs', 'new.md'), 'utf8')).toBe('# new\n');

    expect(existsSync(updateDir)).toBe(false);
    expect((await cli(['verify'])).exitCode).toBe(0);
  });

  test('preserves patch provenance across the rebase', async () => {
    await syncAndPatch();
    const beforeHeader = await readFile(
      join(seriesDir, '0001-Bump-the-exported-version.patch'),
      'utf8',
    );
    const beforeDate = /^Date: (.+)$/m.exec(beforeHeader)?.[1];
    const beforeFrom = /^From: (.+)$/m.exec(beforeHeader)?.[1];

    await fx.commitUpstream({ 'README.md': '# upstream v3\n' }, 'move upstream');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(0);

    const afterHeader = await readFile(
      join(seriesDir, '0001-Bump-the-exported-version.patch'),
      'utf8',
    );
    expect(/^Date: (.+)$/m.exec(afterHeader)?.[1]).toBe(beforeDate);
    expect(/^From: (.+)$/m.exec(afterHeader)?.[1]).toBe(beforeFrom);
  });

  test('a conflict preserves the rebase and leaves every committed file alone', async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const seriesBefore = await readdir(seriesDir);
    const patchBefore = await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'));

    // Upstream rewrites the same line patch 0001 rewrote.
    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toContain(
      'Rebasing "upstream" stopped on patch 0001 "Bump the exported version"',
    );
    expect(update.stderr).toContain('Conflicted files:');
    expect(update.stderr).toContain('src/index.ts');
    expect(update.stderr).toContain('.inrepo/updates/upstream/repo');
    expect(update.stderr).toContain('inrepo update upstream --continue');
    expect(update.stderr).toContain('inrepo update upstream --abort');

    // The conflicted work tree is there to edit, with ordinary git markers.
    const conflicted = await readFile(join(updateDir, 'repo', 'src', 'index.ts'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('export const v = 3;');
    expect(conflicted).toContain('export const v = 42;');

    // Nothing that gets committed to the host repository moved.
    expect(await lockCommit()).toBe(before);
    expect((await readdir(seriesDir)).sort()).toEqual(seriesBefore.sort());
    expect(await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'))).toEqual(
      patchBefore,
    );
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );
    expect(((await readConfig(cwd, MODE)).packages as { ref: string }[])[0].ref).toBe('main');
  });

  test('--continue finishes the update after the conflict is resolved by hand', async () => {
    await syncAndPatch();
    const moved = await fx.commitUpstream(
      { 'src/index.ts': 'export const v = 3;\n' },
      'conflicting change',
    );
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);

    await writeFile(
      join(updateDir, 'repo', 'src', 'index.ts'),
      'export const v = 3 + 42;\n',
      'utf8',
    );

    const done = await cli(['update', 'upstream', '--continue']);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain(`→ ${moved.slice(0, 7)} (main)`);

    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Bump-the-exported-version.patch',
      '0002-Add-a-local-helper.patch',
    ]);
    expect(await lockCommit()).toBe(moved);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 3 + 42;\n',
    );
    expect(existsSync(updateDir)).toBe(false);
    expect((await cli(['verify'])).exitCode).toBe(0);
  });

  test('--abort discards the update and leaves the project untouched', async () => {
    await syncAndPatch();
    const before = await lockCommit();
    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);
    expect(existsSync(updateDir)).toBe(true);

    const abort = await cli(['update', 'upstream', '--abort']);
    expect(abort.exitCode).toBe(0);
    expect(abort.stdout).toContain('Discarded the in-progress update for "upstream"');

    expect(existsSync(updateDir)).toBe(false);
    expect(await lockCommit()).toBe(before);
    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Bump-the-exported-version.patch',
      '0002-Add-a-local-helper.patch',
    ]);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );
    expect((await cli(['verify'])).exitCode).toBe(0);
  });

  test('a failed finalize restores the series and leaves the update abortable', async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const seriesBefore = (await readdir(seriesDir)).sort();
    const patchBefore = await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'));

    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);
    await writeFile(
      join(updateDir, 'repo', 'src', 'index.ts'),
      'export const v = 3 + 42;\n',
      'utf8',
    );

    const lockPath = join(cwd, 'inrepo.lock.json');
    await chmod(lockPath, 0o444);

    const cont = await cli(['update', 'upstream', '--continue']);
    expect(cont.exitCode).toBe(1);
    expect((await readdir(seriesDir)).sort()).toEqual(seriesBefore);
    expect(await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'))).toEqual(
      patchBefore,
    );
    expect(existsSync(join(updateDir, 'state.json'))).toBe(true);
    expect(existsSync(join(updateDir, 'series'))).toBe(true);
    expect(await lockCommit()).toBe(before);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );

    await chmod(lockPath, 0o644);

    const abort = await cli(['update', 'upstream', '--abort']);
    expect(abort.exitCode).toBe(0);
    expect(existsSync(updateDir)).toBe(false);
    expect(await lockCommit()).toBe(before);
    expect((await readdir(seriesDir)).sort()).toEqual(seriesBefore);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );
  });

  test('--abort restores a series that was replaced before finalize finished', async () => {
    await syncAndPatch();
    const seriesBefore = (await readdir(seriesDir)).sort();
    const patchBefore = await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'));

    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);

    // Simulate a crash after the series swap: snapshot exists, live series is new.
    await mkdir(join(updateDir, 'series'), { recursive: true });
    for (const name of seriesBefore) {
      await writeFile(join(updateDir, 'series', name), await readFile(join(seriesDir, name)));
    }
    await rm(seriesDir, { recursive: true, force: true });
    await mkdir(seriesDir, { recursive: true });
    await writeFile(join(seriesDir, '0001-rebased.patch'), 'should not survive abort\n', 'utf8');

    const abort = await cli(['update', 'upstream', '--abort']);
    expect(abort.exitCode).toBe(0);
    expect(existsSync(updateDir)).toBe(false);
    expect((await readdir(seriesDir)).sort()).toEqual(seriesBefore);
    expect(await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'))).toEqual(
      patchBefore,
    );
  });

  test('patch and migrate are refused while an update is paused', async () => {
    await syncAndPatch();
    const seriesBefore = (await readdir(seriesDir)).sort();
    const patchBefore = await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'));

    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);

    await writeFile(join(moduleDir, 'src', 'local.ts'), 'export const local = "nope";\n', 'utf8');
    const patched = await cli(['patch', 'upstream', '-m', 'should not land']);
    expect(patched.exitCode).toBe(1);
    expect(patched.stderr).toContain('already in progress');
    expect(patched.stderr).toContain('inrepo update upstream --continue');
    expect(patched.stderr).toContain('inrepo update upstream --abort');
    expect(patched.stderr).toContain('before patching');

    const migrated = await cli(['migrate', 'upstream']);
    expect(migrated.exitCode).toBe(1);
    expect(migrated.stderr).toContain('already in progress');
    expect(migrated.stderr).toContain('before migrating');

    expect((await readdir(seriesDir)).sort()).toEqual(seriesBefore);
    expect(await readFile(join(seriesDir, '0001-Bump-the-exported-version.patch'))).toEqual(
      patchBefore,
    );
  });

  test('starting a second update while one is in progress is refused', async () => {
    await syncAndPatch();
    await fx.commitUpstream({ 'src/index.ts': 'export const v = 3;\n' }, 'conflicting change');
    expect((await cli(['update', 'upstream'])).exitCode).toBe(1);

    const second = await cli(['update', 'upstream']);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('already in progress');
    expect(second.stderr).toContain('inrepo update upstream --continue');
    expect(second.stderr).toContain('inrepo update upstream --abort');
  });

  test('--continue and --abort report when there is no update in progress', async () => {
    await syncAndPatch();

    const cont = await cli(['update', 'upstream', '--continue']);
    expect(cont.exitCode).toBe(1);
    expect(cont.stderr).toMatch(/No update in progress for "upstream"/);

    const abort = await cli(['update', 'upstream', '--abort']);
    expect(abort.exitCode).toBe(1);
    expect(abort.stderr).toMatch(/No update in progress for "upstream"/);
  });

  test('a package with no patches is simply re-pinned and rebuilt', async () => {
    expect((await cli(['sync'])).exitCode).toBe(0);
    const before = await lockCommit();
    const moved = await fx.commitUpstream({ 'README.md': '# upstream v3\n' }, 'move upstream');

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(`Updated "upstream" ${before.slice(0, 7)} → ${moved.slice(0, 7)}`);
    expect(await lockCommit()).toBe(moved);
    expect(await readFile(join(moduleDir, 'README.md'), 'utf8')).toBe('# upstream v3\n');
    expect(existsSync(seriesDir)).toBe(false);
    expect((await cli(['verify'])).exitCode).toBe(0);
  });

  test('reports that a package already at the ref tip has nothing to update', async () => {
    await syncAndPatch();
    const before = await lockCommit();

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(`"upstream" is already at ${before.slice(0, 7)} (main)`);
    expect(await lockCommit()).toBe(before);
    expect(existsSync(updateDir)).toBe(false);
  });

  test('--ref moves the pin to another branch and records it in the config', async () => {
    await syncAndPatch();
    // Only `next` moves; `main` keeps the pinned tip.
    await fx.createBranch('next');
    const onNext = await fx.commitUpstream({ 'README.md': '# on next\n' }, 'branch work');

    const update = await cli(['update', 'upstream', '--ref', 'next']);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain('(next)');

    expect(await lockRef()).toBe('next');
    const config = (await readConfig(cwd, MODE)) as { packages: { name: string; ref: string }[] };
    expect(config.packages[0].ref).toBe('next');
    expect(await lockCommit()).toBe(onNext);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 42;\n',
    );
    expect((await cli(['verify'])).exitCode).toBe(0);
  });

  test('refuses to update a package that still uses a legacy overlay', async () => {
    await mkdir(join(overlayDir, 'src'), { recursive: true });
    await writeFile(join(overlayDir, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    expect((await cli(['sync'])).exitCode).toBe(0);
    const before = await lockCommit();
    await fx.commitUpstream({ 'README.md': '# upstream v3\n' }, 'move upstream');

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toMatch(/still uses a legacy whole-file overlay/);
    expect(update.stderr).toContain('inrepo migrate upstream');
    expect(await lockCommit()).toBe(before);
    expect(existsSync(updateDir)).toBe(false);

    // Migrating first makes the same update work.
    expect((await cli(['migrate', 'upstream'])).exitCode).toBe(0);
    expect((await cli(['update', 'upstream'])).exitCode).toBe(0);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 99;\n',
    );
  });

  test('refuses to update over uncaptured edits in the generated module', async () => {
    await syncAndPatch();
    await fx.commitUpstream({ 'README.md': '# upstream v3\n' }, 'move upstream');
    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 1000;\n', 'utf8');

    const update = await cli(['update', 'upstream']);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toMatch(/uncaptured edits in "inrepo_modules\/upstream"/);
    expect(existsSync(updateDir)).toBe(false);
  });

  test('argument validation', async () => {
    const missing = await cli(['update']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/update requires a package <name>/);

    const both = await cli(['update', 'upstream', '--continue', '--abort']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toMatch(/either --continue or --abort, not both/);

    const withRef = await cli(['update', 'upstream', '--ref', 'main', '--continue']);
    expect(withRef.exitCode).toBe(1);
    expect(withRef.stderr).toMatch(/--ref cannot be combined with --continue or --abort/);

    const emptyRef = await cli(['update', 'upstream', '--ref']);
    expect(emptyRef.exitCode).toBe(1);
    expect(emptyRef.stderr).toMatch(/--ref requires a value/);

    const unlocked = await cli(['update', 'nope']);
    expect(unlocked.exitCode).toBe(1);
    expect(unlocked.stderr).toMatch(/No configured or locked package named "nope"/);
  });
});
