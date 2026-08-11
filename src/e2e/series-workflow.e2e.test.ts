import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

  /** sync, edit the generated module, capture a legacy overlay, then migrate it. */
  async function syncEditAndMigrate(): Promise<void> {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await writeFile(join(moduleDir, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await writeFile(join(moduleDir, 'logo.bin'), new Uint8Array([9, 8, 7, 6]));
    await rm(join(moduleDir, 'docs', 'guide.md'));

    expect((await runCli(['patch', 'upstream'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const migrate = await runCli(['migrate', 'upstream'], { cwd, env: envFor(MODE) });
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout).toMatch(/Migrated "upstream"/);
    // docs/ held only guide.md, so removing it leaves an empty directory the
    // series cannot record; the command has to say so.
    expect(migrate.stderr).toMatch(/Empty directories are not part of the patch series.*docs/);
  }

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

  test('patch refuses to capture over an existing series', async () => {
    await syncEditAndMigrate();

    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 123;\n', 'utf8');
    const patch = await runCli(['patch', 'upstream'], { cwd, env: envFor(MODE) });
    expect(patch.exitCode).toBe(1);
    expect(patch.stderr).toMatch(/uses a patch series/);
    expect(await readdir(overlayDir)).toEqual(['series']);
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
