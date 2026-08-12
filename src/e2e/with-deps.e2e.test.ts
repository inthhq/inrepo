import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor, readJson } from '../test-utils/e2e-harness.js';
import {
  makePackageGraphFixture,
  type PackageGraphFixture,
} from '../test-utils/package-graph-fixture.js';
import { runCli } from '../test-utils/run-cli.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

type ConfigPackage = { name: string; git?: string; ref?: string };

/** Points at a closed port: proves sync and verify never reach the registry. */
const OFFLINE_REGISTRY = 'http://127.0.0.1:9';

describe('CLI: add --with-deps (e2e)', () => {
  let fx: PackageGraphFixture;
  let cwd: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    fx = await makePackageGraphFixture([
      {
        name: 'alpha',
        versions: { '1.0.0': { dependencies: { beta: '^1.0.0', gamma: '^2.0.0' } } },
      },
      {
        name: 'beta',
        versions: {
          '1.0.0': { dependencies: { gamma: '^2.0.0' } },
          '1.2.0': { dependencies: { gamma: '^2.0.0' } },
        },
      },
      { name: 'gamma', versions: { '2.0.0': {}, '2.1.0': {} } },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-withdeps-');
    await bootstrapHostPackageJson(cwd);
    env = { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('vendors the whole runtime closure, deduping a shared dependency', async () => {
    const add = await runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('beta ^1.0.0 → 1.2.0');
    expect(add.stdout).toContain('gamma ^2.0.0 → 2.1.0');
    expect(add.stdout).toMatch(/Vendored 3 package\(s\) for "alpha"/);

    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(existsSync(join(cwd, 'inrepo_modules', name, 'package.json'))).toBe(true);
    }

    const cfg = await readJson(join(cwd, 'inrepo.json'));
    const packages = cfg.packages as ConfigPackage[];
    expect(packages.map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma']);
    // Dependency entries pin an exact tag so sync never needs the registry.
    expect(packages.find((p) => p.name === 'beta')?.ref).toBe('v1.2.0');
    expect(packages.find((p) => p.name === 'gamma')?.ref).toBe('v2.1.0');

    const lock = await readJson(join(cwd, 'inrepo.lock.json'));
    expect(lock.lockfileVersion).toBe(2);
    expect(lock.graph).toEqual({
      alpha: {
        version: '1.0.0',
        root: true,
        dependencies: {
          beta: { range: '^1.0.0', version: '1.2.0', module: 'beta' },
          gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' },
        },
      },
      beta: {
        version: '1.2.0',
        dependencies: { gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' } },
      },
      gamma: { version: '2.1.0' },
    });

    const pkg = await readJson(join(cwd, 'package.json'));
    expect(pkg.dependencies).toEqual({
      alpha: 'file:inrepo_modules/alpha',
      beta: 'file:inrepo_modules/beta',
      gamma: 'file:inrepo_modules/gamma',
    });
  });

  test('sync and verify replay a committed graph with no registry access', async () => {
    expect(
      (await runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], { cwd, env }))
        .exitCode,
    ).toBe(0);

    const offline = { ...envFor('inrepo.json'), INREPO_REGISTRY: OFFLINE_REGISTRY };
    const sync = await runCli(['sync'], { cwd, env: offline });
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toMatch(/Done\. 3 package\(s\) synced/);

    const verify = await runCli(['verify'], { cwd, env: offline });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/);
  });

  test('verify fails when the committed graph disagrees with the lockfile', async () => {
    expect(
      (await runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], { cwd, env }))
        .exitCode,
    ).toBe(0);

    const lockPath = join(cwd, 'inrepo.lock.json');
    const lock = await readJson(lockPath);
    const graph = lock.graph as Record<string, { dependencies?: Record<string, { range: string }> }>;
    graph.alpha.dependencies!.gamma.range = '^9.0.0';
    await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const verify = await runCli(['verify'], {
      cwd,
      env: { ...envFor('inrepo.json'), INREPO_REGISTRY: OFFLINE_REGISTRY },
    });
    expect(verify.exitCode).toBe(1);
    expect(verify.stderr).toMatch(/depends on "gamma" \^9\.0\.0, which 2\.1\.0 does not satisfy/);
  });

  test('reuses an already vendored dependency instead of re-pinning it', async () => {
    expect(
      (
        await runCli(['add', '--git', fx.gitUrl('gamma'), '--ref', 'v2.0.0', 'gamma'], {
          cwd,
          env,
        })
      ).exitCode,
    ).toBe(0);
    const before = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string }>;
    };

    const add = await runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('gamma ^2.0.0 → 2.0.0');
    expect(add.stdout).toContain('already vendored');
    expect(add.stdout).toMatch(/Vendored 2 package\(s\) for "alpha"; 1 already vendored/);

    const after = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string }>;
      graph: Record<string, { version?: string }>;
    };
    expect(after.modules.gamma.commit).toBe(before.modules.gamma.commit);
    expect(after.graph.gamma.version).toBe('2.0.0');
  });

  test('completes the graph when the root is already vendored', async () => {
    expect(
      (await runCli(['add', '--git', fx.gitUrl('alpha'), 'alpha'], { cwd, env })).exitCode,
    ).toBe(0);
    expect(existsSync(join(cwd, 'inrepo_modules', 'beta'))).toBe(false);

    const add = await runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);
    expect(existsSync(join(cwd, 'inrepo_modules', 'beta', 'package.json'))).toBe(true);
    expect(existsSync(join(cwd, 'inrepo_modules', 'gamma', 'package.json'))).toBe(true);
  });

  test('plain add is unchanged: one package, lockfileVersion 1, no graph', async () => {
    const add = await runCli(['add', '--git', fx.gitUrl('alpha'), 'alpha'], { cwd, env });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toMatch(/Recorded "alpha" in inrepo config/);

    expect(existsSync(join(cwd, 'inrepo_modules', 'beta'))).toBe(false);
    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect((cfg.packages as ConfigPackage[]).map((p) => p.name)).toEqual(['alpha']);

    const lock = await readJson(join(cwd, 'inrepo.lock.json'));
    expect(lock.lockfileVersion).toBe(1);
    expect('graph' in lock).toBe(false);
  });

  test('vendors and replays a scoped package graph', async () => {
    const scoped = await makePackageGraphFixture([
      {
        name: '@scope/root',
        versions: { '1.0.0': { dependencies: { '@scope/leaf': '^1.0.0' } } },
      },
      { name: '@scope/leaf', versions: { '1.1.0': {} } },
    ]);
    try {
      const scopedEnv = { ...envFor('inrepo.json'), INREPO_REGISTRY: scoped.registryUrl };
      const add = await runCli(
        ['add', '--git', scoped.gitUrl('@scope/root'), '--with-deps', '@scope/root'],
        { cwd, env: scopedEnv },
      );
      expect(add.exitCode).toBe(0);
      for (const name of ['root', 'leaf']) {
        expect(existsSync(join(cwd, 'inrepo_modules', '@scope', name, 'package.json'))).toBe(
          true,
        );
      }

      const lock = await readJson(join(cwd, 'inrepo.lock.json'));
      expect(lock.graph).toEqual({
        '@scope/root': {
          version: '1.0.0',
          root: true,
          dependencies: {
            '@scope/leaf': { range: '^1.0.0', version: '1.1.0', module: '@scope/leaf' },
          },
        },
        '@scope/leaf': { version: '1.1.0' },
      });

      const offline = { ...envFor('inrepo.json'), INREPO_REGISTRY: OFFLINE_REGISTRY };
      expect((await runCli(['sync'], { cwd, env: offline })).exitCode).toBe(0);
      expect((await runCli(['verify'], { cwd, env: offline })).exitCode).toBe(0);
    } finally {
      await scoped.cleanup();
    }
  });

  test('--with-deps cannot be combined with --no-save', async () => {
    const r = await runCli(['add', '--with-deps', '--no-save', 'alpha'], { cwd, env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--with-deps cannot be combined with --no-save/);
  });
});

describe('CLI: add --with-deps failure modes (e2e)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-withdeps-fail-');
    await bootstrapHostPackageJson(cwd);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  async function expectNothingVendored(): Promise<void> {
    expect(existsSync(join(cwd, 'inrepo_modules'))).toBe(false);
    expect(existsSync(join(cwd, 'inrepo.lock.json'))).toBe(false);
    const cfg = await readJson(join(cwd, 'inrepo.json'));
    expect(cfg.packages).toEqual([]);
  }

  test('non-overlapping ranges fail before anything is vendored', async () => {
    const fx = await makePackageGraphFixture([
      {
        name: 'root-pkg',
        versions: { '1.0.0': { dependencies: { left: '^1.0.0', right: '^1.0.0' } } },
      },
      { name: 'left', versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } } },
      { name: 'right', versions: { '1.0.0': { dependencies: { shared: '^2.0.0' } } } },
      { name: 'shared', versions: { '1.0.0': {}, '2.0.0': {} } },
    ]);
    try {
      const r = await runCli(['add', '--git', fx.gitUrl('root-pkg'), '--with-deps', 'root-pkg'], {
        cwd,
        env: { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/Cannot satisfy "shared"/);
      expect(r.stderr).toMatch(/left requires \^1\.0\.0/);
      expect(r.stderr).toMatch(/right requires \^2\.0\.0/);
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test('an unsupported dependency source fails before anything is vendored', async () => {
    const fx = await makePackageGraphFixture([
      {
        name: 'root-pkg',
        versions: { '1.0.0': { dependencies: { 'internal-tool': 'workspace:^' } } },
      },
    ]);
    try {
      const r = await runCli(['add', '--git', fx.gitUrl('root-pkg'), '--with-deps', 'root-pkg'], {
        cwd,
        env: { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /"root-pkg" depends on "internal-tool" as "workspace:\^" \(workspace protocol/,
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test('a monorepo package fails instead of reading the workspace root as the package', async () => {
    const fx = await makePackageGraphFixture([
      {
        name: '@scope/cli',
        checkoutName: 'workspace-root',
        versions: { '1.0.0': { dependencies: { leaf: '^1.0.0' } } },
      },
      { name: 'leaf', versions: { '1.0.0': {} } },
    ]);
    try {
      const r = await runCli(
        ['add', '--git', fx.gitUrl('@scope/cli'), '--with-deps', '@scope/cli'],
        { cwd, env: { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        'the repository root declares package "workspace-root". Monorepo package subdirectories are not supported yet.',
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test('a dependency with no published tag fails with the package named', async () => {
    const fx = await makePackageGraphFixture([
      { name: 'root-pkg', versions: { '1.0.0': { dependencies: { loose: '^1.0.0' } } } },
      { name: 'loose', versions: { '1.0.0': {} }, untagged: true },
    ]);
    try {
      const r = await runCli(['add', '--git', fx.gitUrl('root-pkg'), '--with-deps', 'root-pkg'], {
        cwd,
        env: { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/no tag for "loose@1\.0\.0"/);
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test('a dependency with no repository metadata fails with the package named', async () => {
    const fx = await makePackageGraphFixture([
      { name: 'root-pkg', versions: { '1.0.0': { dependencies: { hidden: '^1.0.0' } } } },
      { name: 'hidden', versions: { '1.0.0': {} }, noRepository: true },
    ]);
    try {
      const r = await runCli(['add', '--git', fx.gitUrl('root-pkg'), '--with-deps', 'root-pkg'], {
        cwd,
        env: { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/"hidden@1\.0\.0".*no usable "repository" clone URL/s);
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });
});
