import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor, readJson } from '../test-utils/e2e-harness.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { runCli } from '../test-utils/run-cli.js';
import {
  makeLocalGitFixture,
  type LocalGitFixture,
} from '../test-utils/local-git-fixture.js';

const NON_INTERACTIVE_ENV = envFor('inrepo.json');

describe('CLI: add ↔ config sync (e2e)', () => {
  let fx: LocalGitFixture;
  let cwd: string;

  beforeAll(async () => {
    fx = await makeLocalGitFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-addsync-');
    await bootstrapHostPackageJson(cwd);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('add (with no flags) records the entry in inrepo.json so sync replays it', async () => {
    const add = await runCli(['add', '--git', fx.url, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(add.exitCode).toBe(0);

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url }]);

    const sync = await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV });
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toMatch(/Done\. 1 package\(s\) synced/);
  });

  test('add -D --ref records dev/git/ref together', async () => {
    const r = await runCli(['add', '-D', '--git', fx.url, '--ref', fx.c1, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r.exitCode).toBe(0);

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([
      { name: 'upstream', git: fx.url, ref: fx.c1, dev: true },
    ]);
  });

  test('add --no-save vendors without creating inrepo.json or touching package.json#inrepo', async () => {
    // --no-save is an explicit "one-off vendor": it should not run first-time
    // setup (no inrepo.json stub) and it should not record the entry anywhere.
    const r = await runCli(['add', '--no-save', '--git', fx.url, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(cwd, 'inrepo_modules', 'upstream', 'README.md'))).toBe(true);

    expect(existsSync(join(cwd, 'inrepo.json'))).toBe(false);
    const pkg = await readJson(join(cwd, 'package.json'));
    expect(pkg.inrepo).toBeUndefined();

    // Sync afterwards still complains that there's no config — that's the
    // intended trade-off for opting out of persistence.
    const sync = await runCli(['sync'], { cwd, env: NON_INTERACTIVE_ENV });
    expect(sync.exitCode).toBe(1);
  });

  test('add --no-save works without INREPO_CONFIG and without a TTY (no first-time-setup error)', async () => {
    const r = await runCli(['add', '--no-save', '--git', fx.url, 'upstream'], {
      cwd,
      env: { INREPO_NONINTERACTIVE: '1', INREPO_CONFIG: undefined },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/first-time setup needs an interactive terminal/);
    expect(existsSync(join(cwd, 'inrepo_modules', 'upstream', 'README.md'))).toBe(true);
    expect(existsSync(join(cwd, 'inrepo.json'))).toBe(false);
  });

  test('failed materialize leaves inrepo.json untouched (no phantom config entry)', async () => {
    const badUrl = join(cwd, 'no-such-repo.git');
    const r = await runCli(['add', '--git', badUrl, 'upstream'], {
      cwd,
      env: NON_INTERACTIVE_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/git clone .* failed/);

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([]);

    expect(existsSync(join(cwd, 'inrepo_modules', 'upstream'))).toBe(false);
    expect(existsSync(join(cwd, 'inrepo.lock.json'))).toBe(false);
  });

  test('re-running add updates the existing entry (does not duplicate)', async () => {
    expect(
      (
        await runCli(['add', '--git', fx.url, 'upstream'], {
          cwd,
          env: NON_INTERACTIVE_ENV,
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(['add', '--git', fx.url, '--ref', fx.c1, 'upstream'], {
          cwd,
          env: NON_INTERACTIVE_ENV,
        })
      ).exitCode,
    ).toBe(0);

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([{ name: 'upstream', git: fx.url, ref: fx.c1 }]);
  });

  test('add saves into package.json#inrepo when that is the configured location', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: { packages: [] } }, null, 2) + '\n',
      'utf8',
    );

    const r = await runCli(['add', '--git', fx.url, 'upstream'], {
      cwd,
      env: envFor('package.json'),
    });
    expect(r.exitCode).toBe(0);

    const pkg = await readJson(join(cwd, 'package.json'));
    expect(pkg.inrepo).toEqual({ packages: [{ name: 'upstream', git: fx.url }] });
    expect(existsSync(join(cwd, 'inrepo.json'))).toBe(false);
  });
});
