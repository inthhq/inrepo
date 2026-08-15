import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor, writeConfig } from '../test-utils/e2e-harness.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import { makeLocalGitFixture, type LocalGitFixture } from '../test-utils/local-git-fixture.js';

const MODE = 'inrepo.json';

describe('CLI: diff (e2e)', () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let overlayDir: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture('inrepo-diff-');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-diff-e2e-');
    moduleDir = join(cwd, 'inrepo_modules', 'upstream');
    overlayDir = join(cwd, 'inrepo_patches', 'upstream');
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, { packages: [{ name: 'upstream', git: fx.url }] });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  /** sync, edit the module, and capture the edits as a numbered patch. */
  async function syncAndCapture(message: string): Promise<void> {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);
    await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await writeFile(join(moduleDir, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await rm(join(moduleDir, 'docs', 'guide.md'));
    expect(
      (await runCli(['patch', 'upstream', '-m', message], { cwd, env: envFor(MODE) })).exitCode,
    ).toBe(0);
  }

  test('shows the combined delta from the pinned upstream commit', async () => {
    await syncAndCapture('Bump the version and drop the guide');

    const diff = await runCli(['diff', 'upstream'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);

    expect(diff.stdout).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(diff.stdout).toContain('-export const v = 2;');
    expect(diff.stdout).toContain('+export const v = 99;');
    expect(diff.stdout).toContain('new file mode 100644');
    expect(diff.stdout).toContain('+++ b/src/local.ts');
    expect(diff.stdout).toContain('deleted file mode 100644');
    expect(diff.stdout).toContain('--- a/docs/guide.md');
    // The generated vendor marker is not part of the patched tree stage.
    expect(diff.stdout).not.toContain('.inrepo-vendor.json');
  });

  test('lists the patch series with its subjects as the provenance record', async () => {
    await syncAndCapture('Bump the version and drop the guide');

    const diff = await runCli(['diff', 'upstream'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toMatch(/^upstream @ [0-9a-f]{7} — patch series \(1 patch\)$/m);
    expect(diff.stdout).toMatch(/^ {2}0001 {2}Bump the version and drop the guide {2}\(.*\)$/m);
    expect(diff.stdout).toMatch(/, \d{4}-\d{2}-\d{2}, 3 files\)$/m);

    await writeFile(join(moduleDir, 'README.md'), '# patched\n', 'utf8');
    expect(
      (await runCli(['patch', 'upstream', '-m', 'Rewrite the readme'], { cwd, env: envFor(MODE) }))
        .exitCode,
    ).toBe(0);

    const second = await runCli(['diff', 'upstream'], { cwd, env: envFor(MODE) });
    expect(second.stdout).toContain('patch series (2 patches)');
    expect(second.stdout).toMatch(/0001 {2}Bump the version and drop the guide/);
    expect(second.stdout).toMatch(/0002 {2}Rewrite the readme/);
  });

  test('--stat summarizes per file instead of printing hunks', async () => {
    await syncAndCapture('Bump the version and drop the guide');

    const diff = await runCli(['diff', 'upstream', '--stat'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('0001  Bump the version and drop the guide');
    // git's own --stat rows, indentation included.
    expect(diff.stdout).toMatch(/^ docs\/guide\.md +\| 1 -$/m);
    expect(diff.stdout).toMatch(/^ src\/index\.ts +\| 2 \+-$/m);
    expect(diff.stdout).toMatch(/^ src\/local\.ts +\| 1 \+$/m);
    expect(diff.stdout).toMatch(/3 files changed/);
    expect(diff.stdout).not.toContain('+export const v = 99;');
  });

  test('reports no differences and still exits 0', async () => {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const diff = await runCli(['diff', 'upstream'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('no committed changes');
    expect(diff.stdout).toContain('(no differences)');
  });

  test('diffs a package that still uses a legacy overlay, deletions included', async () => {
    await mkdir(join(overlayDir, 'src'), { recursive: true });
    await writeFile(join(overlayDir, 'src', 'index.ts'), 'export const v = 42;\n', 'utf8');
    await writeFile(join(overlayDir, '.inrepo-deletions'), 'docs/guide.md\n', 'utf8');
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const diff = await runCli(['diff', 'upstream'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toMatch(/^upstream @ [0-9a-f]{7} — legacy overlay$/m);
    expect(diff.stdout).toContain('+export const v = 42;');
    expect(diff.stdout).toContain('deleted file mode 100644');
    expect(diff.stdout).toContain('--- a/docs/guide.md');
  });

  test('diffs every vendored package when no package is named', async () => {
    await syncAndCapture('Bump the version and drop the guide');

    const diff = await runCli(['diff'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('upstream @ ');
    expect(diff.stdout).toContain('+export const v = 99;');
  });

  test('rejects an unknown package', async () => {
    expect((await runCli(['sync'], { cwd, env: envFor(MODE) })).exitCode).toBe(0);

    const diff = await runCli(['diff', 'nope'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(1);
    expect(diff.stderr).toMatch(/No configured or locked package named "nope"/);
  });

  test('rejects a package that has never been vendored', async () => {
    await writeConfig(cwd, MODE, {
      packages: [
        { name: 'upstream', git: fx.url },
        { name: 'other', git: fx.url },
      ],
    });

    const diff = await runCli(['diff', 'other'], { cwd, env: envFor(MODE) });
    expect(diff.exitCode).toBe(1);
    expect(diff.stderr).toMatch(/Cannot diff "other" without a lockfile entry/);
  });
});
