import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrapHostPackageJson,
  envFor,
  MODES,
  writeConfig,
} from '../test-utils/e2e-harness.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';

for (const mode of MODES) {
  describe(`CLI: patch workflow (e2e) [${mode}]`, () => {
    let fx: LocalGitFixture;
    let cwd: string;

    beforeAll(async () => {
      fx = await makeLocalGitFixture(`inrepo-patch-${mode}-`);
    });

    afterAll(async () => {
      await fx.cleanup();
    });

    beforeEach(async () => {
      cwd = await makeTmpDir(`inrepo-patch-e2e-${mode === 'inrepo.json' ? 'ij' : 'pj'}-`);
      await bootstrapHostPackageJson(cwd);
      await writeConfig(cwd, mode, {
        packages: [{ name: 'upstream', git: fx.url }],
      });
    });

    afterEach(async () => {
      await cleanupTmpDir(cwd);
    });

    test('sync -> edit -> patch -> resync preserves text, binary files, and deletions', async () => {
      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
      await writeFile(join(moduleDir, 'logo.bin'), new Uint8Array([9, 8, 7, 6]));
      await writeFile(join(moduleDir, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
      await rm(join(moduleDir, 'docs', 'guide.md'));

      const patch = await runCli(['patch', 'upstream'], { cwd, env: envFor(mode) });
      expect(patch.exitCode).toBe(0);
      expect(await readFile(join(cwd, 'inrepo_patches', 'upstream', 'src', 'index.ts'), 'utf8')).toBe(
        'export const v = 99;\n',
      );
      expect(await readFile(join(cwd, 'inrepo_patches', 'upstream', 'logo.bin'))).toEqual(
        Buffer.from([9, 8, 7, 6]),
      );
      expect(await readFile(join(cwd, 'inrepo_patches', 'upstream', '.inrepo-deletions'), 'utf8')).toBe(
        'docs/guide.md\n',
      );

      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);
      expect(await readFile(join(moduleDir, 'src', 'index.ts'), 'utf8')).toBe('export const v = 99;\n');
      expect(await readFile(join(moduleDir, 'logo.bin'))).toEqual(Buffer.from([9, 8, 7, 6]));
      expect(existsSync(join(moduleDir, 'docs', 'guide.md'))).toBe(false);
      expect(await readFile(join(moduleDir, 'src', 'local.ts'), 'utf8')).toBe(
        'export const local = true;\n',
      );
    });

    test('sync refuses to overwrite uncaptured edits without --force', async () => {
      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 77;\n', 'utf8');

      const r = await runCli(['sync'], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/uncaptured edits in "inrepo_modules\/upstream"/);
    });

    test('sync --force snapshots a backup before rebuilding', async () => {
      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 55;\n', 'utf8');

      const r = await runCli(['sync', '--force'], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(0);

      const backupRoot = join(cwd, '.inrepo', 'backups');
      const backups = await readdir(backupRoot);
      expect(backups.length).toBe(1);
      expect(
        await readFile(join(backupRoot, backups[0], 'src', 'index.ts'), 'utf8'),
      ).toBe('export const v = 55;\n');
    });

    test('patch fails loudly when both overlay and generated module changed', async () => {
      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);

      const overlayDir = join(cwd, 'inrepo_patches', 'upstream', 'src');
      await mkdir(overlayDir, { recursive: true });
      await writeFile(join(overlayDir, 'index.ts'), 'export const v = 22;\n', 'utf8');

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      await writeFile(join(moduleDir, 'src', 'index.ts'), 'export const v = 33;\n', 'utf8');

      const r = await runCli(['patch', 'upstream'], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/both "inrepo_patches\/upstream" and "inrepo_modules\/upstream" changed/);
    });
  });
}
