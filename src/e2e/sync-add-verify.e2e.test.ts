import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';

const NON_INTERACTIVE_ENV = { INREPO_NONINTERACTIVE: '1', INREPO_CONFIG: 'inrepo.json' } as const;

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('CLI: sync / add / verify against a local bare git repo (e2e)', () => {
  let fx: LocalGitFixture;
  let cwd: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-sync-');
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', version: '0.0.0' }, null, 2) + '\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('add (default) vendors module, writes lockfile, updates inrepo.json and package.json deps', async () => {
    const r = await runCli(['add', '--git', fx.url, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
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

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url }]);
  });

  test('add -D wires devDependencies and toggling off via add restores dependencies', async () => {
    const r1 = await runCli(['add', '-D', '--git', fx.url, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r1.exitCode).toBe(0);
    let pkg = await readJson(join(cwd, 'package.json'));
    expect(pkg.devDependencies).toEqual({ upstream: 'file:inrepo_modules/upstream' });
    expect(pkg.dependencies).toBeUndefined();

    const r2 = await runCli(['add', '--git', fx.url, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r2.exitCode).toBe(0);
    pkg = await readJson(join(cwd, 'package.json'));
    expect(pkg.dependencies).toEqual({ upstream: 'file:inrepo_modules/upstream' });
    expect(pkg.devDependencies).toBeUndefined();
  });

  test('add --ref pins to a specific commit SHA', async () => {
    const r = await runCli(['add', '--git', fx.url, '--ref', fx.c1, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r.exitCode).toBe(0);

    const idx = await readFile(join(cwd, 'inrepo_modules', 'upstream', 'src', 'index.ts'), 'utf8');
    expect(idx).toBe('export const v = 1;\n');
    expect(existsSync(join(cwd, 'inrepo_modules', 'upstream', 'CHANGELOG.md'))).toBe(false);

    const marker = await readJson(join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'));
    expect(marker.commit).toBe(fx.c1);
  });

  test('sync replays config: applies keep then exclude, idempotently re-syncs', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({
        packages: [
          {
            name: 'upstream',
            git: fx.url,
            keep: ['src', 'package.json'],
            exclude: ['/^src\\/index\\.ts$/'],
          },
        ],
      }) + '\n',
      'utf8',
    );

    const r1 = await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV });
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toMatch(/Done\. 1 package\(s\) synced/);

    const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
    expect(existsSync(join(moduleDir, 'package.json'))).toBe(true);
    expect(existsSync(join(moduleDir, 'src'))).toBe(true);
    expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(false);
    expect(existsSync(join(moduleDir, 'README.md'))).toBe(false);
    expect(existsSync(join(moduleDir, 'docs'))).toBe(false);
    expect(existsSync(join(moduleDir, 'CHANGELOG.md'))).toBe(false);

    const r2 = await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV });
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).toMatch(/Warning: replacing existing checkout/);
    expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(false);
  });

  test('sync uses root-level keep/exclude merged with per-package lists', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({
        keep: ['src'],
        exclude: ['/^docs\\//'],
        packages: [{ name: 'upstream', git: fx.url, keep: ['package.json'] }],
      }) + '\n',
      'utf8',
    );

    const r = await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV });
    expect(r.exitCode).toBe(0);

    const moduleDir = join(cwd, 'inrepo_modules', 'upstream');
    expect(existsSync(join(moduleDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(moduleDir, 'package.json'))).toBe(true);
    expect(existsSync(join(moduleDir, 'docs'))).toBe(false);
    expect(existsSync(join(moduleDir, 'README.md'))).toBe(false);
  });

  test('verify passes after sync, fails after vendor marker tampering, recovers after re-sync', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: [{ name: 'upstream', git: fx.url }] }) + '\n',
      'utf8',
    );

    expect((await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV })).exitCode).toBe(0);
    const ok = await runCli(['verify'], { cwd });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/inrepo verify: all lockfile entries match checkouts/);

    await writeFile(
      join(cwd, 'inrepo_modules', 'upstream', '.inrepo-vendor.json'),
      JSON.stringify({ commit: 'b'.repeat(40), gitUrl: fx.url }) + '\n',
      'utf8',
    );
    const bad = await runCli(['verify'], { cwd });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/vendor marker commit .* does not match lock/);

    expect((await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV })).exitCode).toBe(0);
    expect((await runCli(['verify'], { cwd })).exitCode).toBe(0);
  });

  test('verify fails when vendor directory is missing entirely', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: [{ name: 'upstream', git: fx.url }] }) + '\n',
      'utf8',
    );
    expect((await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV })).exitCode).toBe(0);
    await rm(join(cwd, 'inrepo_modules', 'upstream'), { recursive: true, force: true });

    const r = await runCli(['verify'], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Missing directory for "upstream"/);
  });

  test('add fails cleanly when --git URL is invalid', async () => {
    const r = await runCli(['add', '--git', join(cwd, 'no-such-repo.git'), 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/git clone .* failed/);
  });
});
