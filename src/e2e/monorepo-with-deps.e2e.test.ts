import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor, readJson } from '../test-utils/e2e-harness.js';
import { makeMonorepoPackageGraphFixture, type MonorepoPackageGraphFixture } from '../test-utils/package-graph-fixture.js';
import { runCli } from '../test-utils/run-cli.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

const OFFLINE_REGISTRY = 'http://127.0.0.1:9';

describe('CLI: monorepo add --with-deps (e2e)', () => {
  let fx: MonorepoPackageGraphFixture;
  let cwd: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    fx = await makeMonorepoPackageGraphFixture([
      {
        name: '@scope/root',
        directory: 'packages/root',
        version: '1.0.0',
        checkoutDependencies: { '@scope/leaf': 'workspace:*' },
        publishedDependencies: { '@scope/leaf': '^1.0.0' },
        manifest: { type: 'module' },
        files: {
          'index.js': `import { leaf } from '@scope/leaf';\nconsole.log(leaf);\n`,
        },
      },
      {
        name: '@scope/leaf',
        directory: 'packages/leaf',
        version: '1.0.0',
        manifest: { type: 'module' },
        files: { 'index.js': `export const leaf = 'shared-checkout';\n` },
      },
      {
        name: '@scope/other',
        directory: 'packages/other',
        version: '1.0.0',
        checkoutDependencies: { '@scope/root': 'workspace:*' },
        publishedDependencies: { '@scope/root': '^1.0.0' },
        manifest: { type: 'module' },
        files: {
          'index.js': `import { leaf } from '@scope/root';\nconsole.log(leaf);\n`,
        },
      },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-monorepo-withdeps-');
    await bootstrapHostPackageJson(cwd);
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [], rewireImports: true }, null, 2)}\n`,
      'utf8',
    );
    env = {
      ...envFor('inrepo.json'),
      INREPO_REGISTRY: fx.registryUrl,
      GIT_CONFIG_GLOBAL: fx.gitConfigPath,
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('uses published dependencies, shares one repository commit, and replays offline', async () => {
    const add = await runCli(['add', '--with-deps', '@scope/root'], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);

    const config = await readJson(join(cwd, 'inrepo.json'));
    expect(config.packages).toEqual([
      {
        name: '@scope/root',
        repositoryDirectory: 'packages/root',
      },
      {
        name: '@scope/leaf',
        module: '@scope/leaf@1.0.0',
        git: fx.gitUrl('@scope/leaf'),
        repositoryDirectory: 'packages/leaf',
        ref: 'v1.0.0',
      },
    ]);

    const lock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      lockfileVersion: number;
      modules: Record<string, { commit: string; repositoryDirectory?: string }>;
      graph: Record<string, { dependencies?: Record<string, { range: string }> }>;
    };
    expect(lock.lockfileVersion).toBe(4);
    expect(lock.modules['@scope/root']).toMatchObject({
      commit: fx.commit,
      repositoryDirectory: 'packages/root',
    });
    expect(lock.modules['@scope/leaf@1.0.0']).toMatchObject({
      commit: fx.commit,
      repositoryDirectory: 'packages/leaf',
    });
    expect(lock.graph['@scope/root']?.dependencies?.['@scope/leaf']).toMatchObject({
      range: '^1.0.0',
      module: '@scope/leaf@1.0.0',
      version: '1.0.0',
    });

    expect(await readdir(join(cwd, '.inrepo', 'repositories'))).toHaveLength(1);
    const rootIndex = join(cwd, 'inrepo_modules', '@scope', 'root', 'index.js');
    expect(await readFile(rootIndex, 'utf8')).toContain("from '../leaf@1.0.0/index.js'");
    expect(existsSync(join(cwd, 'inrepo_modules', '@scope', 'root', 'packages'))).toBe(false);

    const execution = Bun.spawn(['node', rootIndex], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await execution.exited).toBe(0);
    expect(await new Response(execution.stdout).text()).toBe('shared-checkout\n');

    await rm(join(cwd, 'inrepo_modules'), { recursive: true, force: true });
    const offlineEnv = { ...env, INREPO_REGISTRY: OFFLINE_REGISTRY };
    expect((await runCli(['sync'], { cwd, env: offlineEnv })).exitCode).toBe(0);
    expect((await runCli(['verify'], { cwd, env: offlineEnv })).exitCode).toBe(0);
    expect(await readFile(rootIndex, 'utf8')).toContain("from '../leaf@1.0.0/index.js'");
  });

  test('a second overlapping add --with-deps reuses published ranges, not checkout workspace specifiers', async () => {
    const first = await runCli(['add', '--with-deps', '@scope/root'], { cwd, env });
    expect(first.exitCode).toBe(0);

    const before = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string }>;
    };

    const again = await runCli(['add', '--with-deps', '@scope/root'], { cwd, env });
    expect(again.exitCode).toBe(0);
    expect(again.stderr).not.toMatch(/workspace protocol/);
    expect(again.stdout).toMatch(/already vendored/);

    const second = await runCli(['add', '--with-deps', '@scope/other'], { cwd, env });
    expect(second.exitCode).toBe(0);
    expect(second.stderr).not.toMatch(/workspace protocol/);
    expect(second.stdout).toMatch(/already vendored/);
    expect(second.stdout).toMatch(/Vendored 1 package\(s\) for "@scope\/other"; 2 already vendored/);

    const lock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string }>;
      graph: Record<string, { dependencies?: Record<string, { range: string; module: string }> }>;
    };
    expect(lock.modules['@scope/root']?.commit).toBe(before.modules['@scope/root']?.commit);
    expect(lock.modules['@scope/leaf@1.0.0']?.commit).toBe(
      before.modules['@scope/leaf@1.0.0']?.commit,
    );
    expect(lock.graph['@scope/root']?.dependencies?.['@scope/leaf']).toMatchObject({
      range: '^1.0.0',
      module: '@scope/leaf@1.0.0',
    });
    expect(lock.graph['@scope/other']?.dependencies?.['@scope/root']).toMatchObject({
      range: '^1.0.0',
      module: '@scope/root',
    });
  });

  test('plain registry add persists its discovered repository directory', async () => {
    const add = await runCli(['add', '@scope/root'], { cwd, env });
    expect(add.exitCode).toBe(0);
    const config = await readJson(join(cwd, 'inrepo.json'));
    expect(config.packages).toEqual([
      {
        name: '@scope/root',
        repositoryDirectory: 'packages/root',
      },
    ]);
    expect(existsSync(join(cwd, 'inrepo_modules', '@scope', 'leaf'))).toBe(false);
  });

  test('manual git sources accept an explicit repository directory', async () => {
    const add = await runCli(
      ['add', '--git', fx.gitUrl('@scope/root'), '--repository-directory', 'packages/root', '@scope/root'],
      { cwd, env },
    );
    expect(add.exitCode).toBe(0);
    const config = await readJson(join(cwd, 'inrepo.json'));
    expect(config.packages).toEqual([
      {
        name: '@scope/root',
        git: fx.gitUrl('@scope/root'),
        repositoryDirectory: 'packages/root',
      },
    ]);
    expect(await readFile(join(cwd, 'inrepo_modules', '@scope', 'root', 'package.json'), 'utf8')).toContain(
      '"name": "@scope/root"',
    );
  });

  test('plain add rejects a wrong or manifest-less subtree before outputs', async () => {
    for (const directory of ['packages/leaf', 'packages']) {
      const add = await runCli(
        ['add', '--git', fx.gitUrl('@scope/root'), '--repository-directory', directory, '@scope/root'],
        { cwd, env },
      );
      expect(add.exitCode).toBe(1);
      expect(add.stderr).toMatch(
        directory === 'packages/leaf' ? /declares package "@scope\/leaf"/ : /has no package\.json/,
      );
      expect(existsSync(join(cwd, 'inrepo_modules'))).toBe(false);
      expect(existsSync(join(cwd, 'inrepo.lock.json'))).toBe(false);
      expect((await readJson(join(cwd, 'inrepo.json'))).packages).toEqual([]);
    }
  });

  test('an explicit git source keeps checkout dependency semantics', async () => {
    const add = await runCli(
      [
        'add',
        '--git',
        fx.gitUrl('@scope/root'),
        '--repository-directory',
        'packages/root',
        '--with-deps',
        '@scope/root',
      ],
      { cwd, env },
    );
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toMatch(/workspace protocol/);
    expect(existsSync(join(cwd, 'inrepo_modules'))).toBe(false);
    expect(existsSync(join(cwd, 'inrepo.lock.json'))).toBe(false);
    expect((await readJson(join(cwd, 'inrepo.json'))).packages).toEqual([]);
  });
});
