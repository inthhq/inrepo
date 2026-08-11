import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor, writeConfig } from '../test-utils/e2e-harness.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import { makeLocalGitFixture, type LocalGitFixture } from '../test-utils/local-git-fixture.js';

const MODE = 'inrepo.json';

describe('CLI: patch series workflow (e2e)', () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let overlayDir: string;
  let seriesDir: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture('inrepo-series-');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-series-e2e-');
    moduleDir = join(cwd, 'inrepo_modules', 'upstream');
    overlayDir = join(cwd, 'inrepo_patches', 'upstream');
    seriesDir = join(overlayDir, 'series');
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, { packages: [{ name: 'upstream', git: fx.url }] });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  /** Write the snapshot overlay an older inrepo would have committed. */
  async function seedLegacyOverlay(): Promise<void> {
    await mkdir(join(overlayDir, 'src'), { recursive: true });
    await writeFile(join(overlayDir, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await writeFile(join(overlayDir, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await writeFile(join(overlayDir, 'logo.bin'), new Uint8Array([9, 8, 7, 6]));
    await writeFile(join(overlayDir, '.inrepo-deletions'), 'docs/guide.md\n', 'utf8');
  }

  /** Start from a legacy overlay project, sync it, then migrate it to a series. */
  async function syncEditAndMigrate(): Promise<void> {
    await seedLegacyOverlay();
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const migrate = await runCli(['migrate', 'upstream'], { cwd, env: envFor(MODE) });
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout).toMatch(/Migrated "upstream"/);
    // docs/ held only guide.md, so removing it leaves an empty directory the
    // series cannot record; the command has to say so.
    expect(migrate.stderr).toMatch(/Empty directories are not part of the patch series.*docs/);
  }

  test('verify succeeds after migrate without an extra sync', async () => {
    await syncEditAndMigrate();

    // docs/ is empty after deleting its last file; the leftover checkout must
    // drop it so verify can match the series-rebuilt tree immediately.
    expect(existsSync(join(moduleDir, 'docs'))).toBe(false);
    expect(existsSync(join(moduleDir, 'docs', 'guide.md'))).toBe(false);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 99;\n');

    const verify = await runCli(['verify'], { cwd, env: envFor(MODE) });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/);
  });

  test('migrate converts the legacy overlay and sync rebuilds the same tree', async () => {
    await syncEditAndMigrate();

    expect(await readdir(overlayDir)).toEqual(['series']);
    const patches = await readdir(seriesDir);
    expect(patches).toEqual(['0001-Import-legacy-inrepo-overlay-for-upstream.patch']);
    expect(await readFile(join(seriesDir, patches[0]), 'utf8')).toMatch(/^From /);

    // Rebuild from scratch: the series is the only source of local changes.
    await rm(join(cwd, 'inrepo_modules'), { recursive: true, force: true });
    await rm(join(cwd, '.inrepo', 'state'), { recursive: true, force: true });
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 99;\n');
    expect(await readFile(join(moduleDir, 'src', 'local.ts'), 'utf8')).toBe(
      'export const local = true;\n',
    );
    expect(new Uint8Array(await readFile(join(moduleDir, 'logo.bin')))).toEqual(
      new Uint8Array([9, 8, 7, 6]),
    );
    expect(existsSync(join(moduleDir, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(join(moduleDir, '.git'))).toBe(false);

    const verify = await runCli(['verify'], { cwd, env: envFor(MODE) });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/);
  });

  test('verify reports drift against the series result', async () => {
    await syncEditAndMigrate();

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 1000;\n', 'utf8');
    const verify = await runCli(['verify'], { cwd, env: envFor(MODE) });
    expect(verify.exitCode).toBe(1);
    expect(verify.stderr).toMatch(/does not match lockfile \+ overlay/);
  });

  test('patch appends to an existing series and sync replays the result', async () => {
    await syncEditAndMigrate();

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 123;\n', 'utf8');
    const patch = await runCli(['patch', 'upstream', '-m', 'Bump the exported version'], {
      cwd,
      env: envFor(MODE),
    });
    expect(patch.exitCode).toBe(0);

    // The capture stays a snapshot-free patch: only `series/` under the overlay.
    expect(await readdir(overlayDir)).toEqual(['series']);
    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Import-legacy-inrepo-overlay-for-upstream.patch',
      '0002-Bump-the-exported-version.patch',
    ]);
    const captured = await readFile(
      join(seriesDir, '0002-Bump-the-exported-version.patch'),
      'utf8',
    );
    expect(captured).toContain('Subject: [PATCH] Bump the exported version');
    // Only the new delta belongs to the new patch.
    expect(captured).toContain('-export const v = 99;');
    expect(captured).toContain('+export const v = 123;');
    expect(captured).not.toContain('src/local.ts');

    // Replaying the whole series from scratch reproduces the same tree.
    await rm(join(cwd, 'inrepo_modules'), { recursive: true, force: true });
    await rm(join(cwd, '.inrepo', 'state'), { recursive: true, force: true });
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 123;\n',
    );
    expect((await runCli(['verify'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);
  });

  test('sequential captures are numbered 0001, 0002, 0003, …', async () => {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
    expect(
      (await runCli(['patch', 'upstream', '-m', 'First change'], { cwd, env: envFor(MODE) }))
        .exitCode,
    ).toBe(0);

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 123;\n', 'utf8');
    expect(
      (await runCli(['patch', 'upstream', '-m', 'Second change'], { cwd, env: envFor(MODE) }))
        .exitCode,
    ).toBe(0);

    await writeFile(join(moduleDir, 'src', 'third.ts'), 'export const third = 3;\n', 'utf8');
    expect(
      (await runCli(['patch', 'upstream', '-m', 'Third change'], { cwd, env: envFor(MODE) }))
        .exitCode,
    ).toBe(0);

    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-First-change.patch',
      '0002-Second-change.patch',
      '0003-Third-change.patch',
    ]);
    expect((await runCli(['verify'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    // Every patch replays cleanly from the pinned upstream commit.
    await rm(join(cwd, 'inrepo_modules'), { recursive: true, force: true });
    await rm(join(cwd, '.inrepo', 'state'), { recursive: true, force: true });
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);
    expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const v = 123;\n',
    );
    expect(await readFile(join(moduleDir, 'src', 'third.ts'), 'utf8')).toBe(
      'export const third = 3;\n',
    );
  });

  test('patch reports nothing to capture when the module is unchanged', async () => {
    await syncEditAndMigrate();

    const patch = await runCli(['patch', 'upstream', '-m', 'Nothing new'], {
      cwd,
      env: envFor(MODE),
    });
    expect(patch.exitCode).toBe(0);
    expect(patch.stdout).toMatch(/Nothing to capture for "upstream"/);
    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Import-legacy-inrepo-overlay-for-upstream.patch',
    ]);
  });

  test('patch requires a message before it will append to a series', async () => {
    await syncEditAndMigrate();

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 123;\n', 'utf8');
    const patch = await runCli(['patch', 'upstream'], { cwd, env: envFor(MODE) });
    expect(patch.exitCode).toBe(1);
    expect(patch.stderr).toMatch(/needs a reason: inrepo patch upstream -m/);
    expect((await readdir(seriesDir)).sort()).toEqual([
      '0001-Import-legacy-inrepo-overlay-for-upstream.patch',
    ]);

    const emptyMessage = await runCli(['patch', 'upstream', '-m', '   '], {
      cwd,
      env: envFor(MODE),
    });
    expect(emptyMessage.exitCode).toBe(1);
    expect(emptyMessage.stderr).toMatch(/-m requires a message/);
  });

  test('a package with no committed changes starts a series on first capture', async () => {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 7;\n', 'utf8');
    const patch = await runCli(['patch', 'upstream', '-m', 'Start the series'], {
      cwd,
      env: envFor(MODE),
    });
    expect(patch.exitCode).toBe(0);
    expect(await readdir(overlayDir)).toEqual(['series']);
    expect((await readdir(seriesDir)).sort()).toEqual(['0001-Start-the-series.patch']);
    expect((await runCli(['verify'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);
  });

  test('migrate requires a package name and a locked package', async () => {
    const missingName = await runCli(['migrate'], { cwd, env: envFor(MODE) });
    expect(missingName.exitCode).toBe(1);
    expect(missingName.stderr).toMatch(/migrate requires a package <name>/);

    const unlocked = await runCli(['migrate', 'nope'], { cwd, env: envFor(MODE) });
    expect(unlocked.exitCode).toBe(1);
    expect(unlocked.stderr).toMatch(/Cannot migrate "nope" without a lockfile entry/);
  });

  test('migrate reports when there is nothing to convert', async () => {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const migrate = await runCli(['migrate', 'upstream'], { cwd, env: envFor(MODE) });
    expect(migrate.exitCode).toBe(1);
    expect(migrate.stderr).toMatch(/No legacy overlay to migrate for "upstream"/);
  });
});
