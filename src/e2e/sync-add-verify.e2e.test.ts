import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrapHostPackageJson,
  envFor,
  MODES,
  readConfig,
  readJson,
  writeConfig,
} from '../test-utils/e2e-harness.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';

for (const mode of MODES) {
  describe(`CLI: sync / add / verify against a local bare git repo (e2e) [${mode}]`, () => {
    let fx: LocalGitFixture;
    let cwd: string;

    beforeAll(async () => {
      fx = await makeLocalGitFixture();
    });

    afterAll(async () => {
      await fx.cleanup();
    });

    beforeEach(async () => {
      cwd = await makeTmpDir(`inrepo-e2e-sync-${mode === 'inrepo.json' ? 'ij' : 'pj'}-`);
      await bootstrapHostPackageJson(cwd);
    });

    afterEach(async () => {
      await cleanupTmpDir(cwd);
    });

    test('add (default) vendors module, writes lockfile, updates config and package.json deps', async () => {
      const r = await runCli(['add', '--git', fx.url, 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Synced "upstream" @ ${fx.c2.slice(0, 7)}`));

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      expect(existsSync(join(moduleDir, 'README.md'))).toBe(true);
      expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(moduleDir, '.git'))).toBe(false);

      const marker = await readJson(join(moduleDir, '.inrepo-vendor.json'));
      expect(marker).toEqual({ commit: fx.c2, gitUrl: fx.url });

      const lock = await readJson(join(cwd, 'inrepo.lock.json'));
      expect((lock.modules as Record<string, { commit: string }>).upstream.commit).toBe(fx.c2);

      const pkg = await readJson(join(cwd, 'package.json'));
      expect(pkg.dependencies).toEqual({ upstream: 'file:inrepo_modules/upstream' });

      const cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url }]);

      // inrepo.json should not exist when config lives in package.json (and vice versa).
      const otherExists = existsSync(
        join(cwd, mode === 'inrepo.json' ? 'package.json' : 'inrepo.json'),
      );
      if (mode === 'inrepo.json') {
        expect(otherExists).toBe(true); // package.json always exists in this suite
        const otherPkg = await readJson(join(cwd, 'package.json'));
        expect(otherPkg.inrepo).toBeUndefined();
      } else {
        expect(otherExists).toBe(false);
      }
    });

    test('add -D wires devDependencies and toggling off via add restores dependencies', async () => {
      const r1 = await runCli(['add', '-D', '--git', fx.url, 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r1.exitCode).toBe(0);
      let pkg = await readJson(join(cwd, 'package.json'));
      expect(pkg.devDependencies).toEqual({ upstream: 'file:inrepo_modules/upstream' });
      expect(pkg.dependencies).toBeUndefined();

      let cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url, dev: true }]);

      const r2 = await runCli(['add', '--git', fx.url, 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r2.exitCode).toBe(0);
      pkg = await readJson(join(cwd, 'package.json'));
      expect(pkg.dependencies).toEqual({ upstream: 'file:inrepo_modules/upstream' });
      expect(pkg.devDependencies).toBeUndefined();

      cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url }]);
    });

    test('add --ref pins to a specific commit SHA and records ref in config', async () => {
      const r = await runCli(['add', '--git', fx.url, '--ref', fx.c1, 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r.exitCode).toBe(0);

      const idx = await readFile(join(cwd, 'inrepo_modules', 'upstream', 'src', 'index.ts'), 'utf8');
      expect(idx).toBe('export const v = 1;\n');
      expect(existsSync(join(cwd, 'inrepo_modules', 'upstream', 'CHANGELOG.md'))).toBe(false);

      const marker = await readJson(join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'));
      expect(marker.commit).toBe(fx.c1);

      const cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url, ref: fx.c1 }]);
    });

    test('sync replays config: applies keep then exclude, idempotently re-syncs', async () => {
      await writeConfig(cwd, mode, {
        packages: [
          {
            name: 'upstream',
            git: fx.url,
            keep: ['src', 'package.json'],
            exclude: ['/^src\\/index\\.ts$/'],
          },
        ],
      });

      const r1 = await runCli(['sync'], { cwd, env: envFor(mode) });
      expect(r1.exitCode).toBe(0);
      expect(r1.stdout).toMatch(/Done\. 1 package\(s\) synced/);

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      expect(existsSync(join(moduleDir, 'package.json'))).toBe(true);
      expect(existsSync(join(moduleDir, 'src'))).toBe(true);
      expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(false);
      expect(existsSync(join(moduleDir, 'README.md'))).toBe(false);
      expect(existsSync(join(moduleDir, 'docs'))).toBe(false);
      expect(existsSync(join(moduleDir, 'CHANGELOG.md'))).toBe(false);

      const r2 = await runCli(['sync'], { cwd, env: envFor(mode) });
      expect(r2.exitCode).toBe(0);
      expect(r2.stderr).toMatch(/Warning: replacing existing checkout/);
      expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(false);
    });

    test('sync uses root-level keep/exclude merged with per-package lists', async () => {
      await writeConfig(cwd, mode, {
        keep: ['src'],
        exclude: ['/^docs\\//'],
        packages: [{ name: 'upstream', git: fx.url, keep: ['package.json'] }],
      });

      const r = await runCli(['sync'], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(0);

      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(moduleDir, 'package.json'))).toBe(true);
      expect(existsSync(join(moduleDir, 'docs'))).toBe(false);
      expect(existsSync(join(moduleDir, 'README.md'))).toBe(false);
    });

    test('verify passes after sync, fails after vendor marker tampering, recovers after re-sync', async () => {
      await writeConfig(cwd, mode, { packages: [{ name: 'upstream', git: fx.url }] });

      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);
      const ok = await runCli(['verify'], { cwd });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toMatch(/inrepo verify: all lockfile entries match checkouts/);

      await writeFile(
        join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'),
        `${JSON.stringify({ commit: 'b'.repeat(40), gitUrl: fx.url })}\n`,
        'utf8',
      );
      const bad = await runCli(['verify'], { cwd });
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toMatch(/vendor marker commit .* does not match lock/);

      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);
      expect((await runCli(['verify'], { cwd })).exitCode).toBe(0);
    });

    test('verify fails when vendor directory is missing entirely', async () => {
      await writeConfig(cwd, mode, { packages: [{ name: 'upstream', git: fx.url }] });
      expect((await runCli(['sync'], { cwd, env: envFor(mode) })).exitCode).toBe(0);
      await rm(join(cwd, 'inrepo_modules', 'upstream'), { recursive: true, force: true });

      const r = await runCli(['verify'], { cwd });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/Missing directory for "upstream"/);
    });

    test('add fails cleanly when --git URL is invalid', async () => {
      const r = await runCli(['add', '--git', join(cwd, 'no-such-repo.git'), 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/git clone .* failed/);

      const cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([]);
    });

    test('add recovers a dangling untracked checkout by snapshotting and replacing it', async () => {
      await writeConfig(cwd, mode, { packages: [] });
      const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
      await mkdir(moduleDir, { recursive: true });
      await writeFile(join(moduleDir, 'local.txt'), 'left behind by an interrupted add\n', 'utf8');

      const r = await runCli(['add', '--git', fx.url, 'upstream'], {
        cwd,
        env: envFor(mode),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(/Saved checkout backup:/);
      expect(existsSync(join(moduleDir, 'README.md'))).toBe(true);
      expect(existsSync(join(moduleDir, 'local.txt'))).toBe(false);

      const backupRoot = join(cwd, '.inrepo', 'backups');
      const backups = await readdir(backupRoot);
      expect(backups.length).toBe(1);
      expect(await readFile(join(backupRoot, backups[0], 'local.txt'), 'utf8')).toBe(
        'left behind by an interrupted add\n',
      );

      const cfg = await readConfig(cwd, mode);
      expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url }]);
    });
  });
}
