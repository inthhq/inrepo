import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapHostPackageJson, envFor } from '../test-utils/e2e-harness.js';
import {
  makePackageGraphFixture,
  type PackageGraphFixture,
} from '../test-utils/package-graph-fixture.js';
import { runCli } from '../test-utils/run-cli.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

/** Points at a closed port: proves sync and verify never reach the registry. */
const OFFLINE_REGISTRY = 'http://127.0.0.1:9';

/**
 * alpha imports beta's entry point and one of gamma's subpath files from a
 * nested directory, so the rewritten specifiers have to walk two levels up.
 * The comment and the plain string both mention a vendored package and must be
 * left exactly as upstream wrote them.
 */
const ALPHA_INDEX = [
  "import { beta } from 'beta';",
  "import { util } from 'gamma/util.js';",
  '// upstream comment mentioning beta',
  "const label = 'gamma';",
  '',
  'export const alpha = `${beta}|${util}|${label}`;',
  '',
  'console.log(alpha);',
  '',
].join('\n');

describe('CLI: generated import rewiring (e2e)', () => {
  let fx: PackageGraphFixture;
  let cwd: string;
  let env: Record<string, string>;
  let offline: Record<string, string>;

  beforeAll(async () => {
    fx = await makePackageGraphFixture(
      [
        {
          name: 'alpha',
          versions: {
            '1.0.0': {
              dependencies: { beta: '^1.0.0', gamma: '^2.0.0' },
              manifest: { type: 'module', main: 'src/index.js' },
              files: { 'src/index.js': ALPHA_INDEX },
            },
          },
        },
        {
          name: 'beta',
          versions: {
            '1.0.0': {
              dependencies: { gamma: '^1.0.0' },
              manifest: { type: 'module', main: 'index.js' },
              files: {
                'index.js': ["import { gamma } from 'gamma';", 'export const beta = `beta+${gamma}`;', ''].join(
                  '\n',
                ),
              },
            },
          },
        },
        {
          name: 'gamma',
          versions: {
            '1.0.0': {
              manifest: { type: 'module', main: 'index.js' },
              files: {
                'index.js': "export const gamma = 'gamma-1';\n",
              },
            },
            '2.0.0': {
              manifest: { type: 'module', main: 'index.js' },
              files: {
                'index.js': "export const gamma = 'gamma-2';\n",
                'util.js': "export const util = 'util-2';\n",
              },
            },
          },
        },
      ],
      'inrepo-rewire-fixture-',
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-rewire-');
    await bootstrapHostPackageJson(cwd);
    env = { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl };
    offline = { ...envFor('inrepo.json'), INREPO_CONFIG: 'inrepo.json', INREPO_REGISTRY: OFFLINE_REGISTRY };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  /** Write the project config up front so `add` sees the opt-in flag. */
  async function writeProjectConfig(rewireImports: boolean): Promise<void> {
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [], ...(rewireImports ? { rewireImports: true } : {}) }, null, 2)}\n`,
      'utf8',
    );
  }

  async function addAlpha(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return runCli(['add', '--git', fx.gitUrl('alpha'), '--with-deps', 'alpha'], { cwd, env });
  }

  function modulePath(...parts: string[]): string {
    return join(cwd, 'inrepo_modules', ...parts);
  }

  async function readModule(...parts: string[]): Promise<string> {
    return readFile(modulePath(...parts), 'utf8');
  }

  /** Run the rewired entry point on real Node, which does no directory or main resolution. */
  async function runAlphaOnNode(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['node', modulePath('alpha', 'src', 'index.js')], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function seriesFiles(name: string): Promise<string[]> {
    try {
      return (await readdir(join(cwd, 'inrepo_patches', name, 'series'))).sort();
    } catch {
      return [];
    }
  }

  test('rewires each parent to its exact dependency version and Node can resolve both', async () => {
    await writeProjectConfig(true);
    const add = await addAlpha();
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('Rewired 2 import specifiers in 1 file of "alpha"');
    expect(add.stdout).toContain('Rewired 1 import specifier in 1 file of "beta"');

    const alpha = await readModule('alpha', 'src', 'index.js');
    expect(alpha).toContain("import { beta } from '../../beta@1.0.0/index.js';");
    expect(alpha).toContain("import { util } from '../../gamma@2.0.0/util.js';");
    // Strings and comments that merely mention a vendored package are untouched.
    expect(alpha).toContain('// upstream comment mentioning beta');
    expect(alpha).toContain("const label = 'gamma';");
    expect(await readModule('beta@1.0.0', 'index.js')).toContain(
      "import { gamma } from '../gamma@1.0.0/index.js';",
    );

    const lock = JSON.parse(await readFile(join(cwd, 'inrepo.lock.json'), 'utf8')) as {
      graph: Record<string, { dependencies?: Record<string, { module: string }> }>;
    };
    expect(lock.graph.alpha.dependencies?.gamma.module).toBe('gamma@2.0.0');
    expect(lock.graph['beta@1.0.0'].dependencies?.gamma.module).toBe('gamma@1.0.0');
    expect(await readModule('gamma@1.0.0', 'index.js')).toContain('gamma-1');
    expect(await readModule('gamma@2.0.0', 'index.js')).toContain('gamma-2');

    const run = await runAlphaOnNode();
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('beta+gamma-1|util-2|gamma');
  });

  test('is off by default: bare specifiers survive and Node cannot resolve them', async () => {
    await writeProjectConfig(false);
    const add = await addAlpha();
    expect(add.exitCode).toBe(0);
    expect(add.stdout).not.toContain('Rewired');

    expect(await readModule('alpha', 'src', 'index.js')).toContain("import { beta } from 'beta';");

    const run = await runAlphaOnNode();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  test('sync replays rewiring offline and is idempotent', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);
    const afterAdd = await readModule('alpha', 'src', 'index.js');

    const first = await runCli(['sync'], { cwd, env: offline });
    expect(first.exitCode).toBe(0);
    expect(await readModule('alpha', 'src', 'index.js')).toBe(afterAdd);

    const second = await runCli(['sync'], { cwd, env: offline });
    expect(second.exitCode).toBe(0);
    expect(await readModule('alpha', 'src', 'index.js')).toBe(afterAdd);

    const verify = await runCli(['verify'], { cwd, env: offline });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/);
  });

  test('verify accepts a rewired tree and rejects a hand-edited specifier', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);
    expect((await runCli(['verify'], { cwd, env: offline })).exitCode).toBe(0);

    const source = await readModule('alpha', 'src', 'index.js');
    await writeFile(
      modulePath('alpha', 'src', 'index.js'),
      source.replace('../../beta@1.0.0/index.js', '../../gamma@2.0.0/index.js'),
      'utf8',
    );

    const verify = await runCli(['verify'], { cwd, env: offline });
    expect(verify.exitCode).toBe(1);
    expect(verify.stderr).toMatch(/modified: src\/index\.js/);
  });

  test('diff never shows the rewiring', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);

    const diff = await runCli(['diff', 'alpha'], { cwd, env: offline });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('(no differences)');
    expect(diff.stdout).not.toContain('../../beta@1.0.0/index.js');
  });

  test('patch captures only the real edit, in the patched tree\'s own specifiers', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);

    // Edit the line right after a rewired import, so the hunk's context covers it.
    const source = await readModule('alpha', 'src', 'index.js');
    await writeFile(
      modulePath('alpha', 'src', 'index.js'),
      source.replace("const label = 'gamma';", "const label = 'patched';"),
      'utf8',
    );

    const patch = await runCli(['patch', 'alpha', '-m', 'Relabel the output'], {
      cwd,
      env: offline,
    });
    expect(patch.exitCode).toBe(0);

    const [fileName] = await seriesFiles('alpha');
    expect(fileName).toMatch(/^0001-.*\.patch$/);
    const contents = await readFile(join(cwd, 'inrepo_patches', 'alpha', 'series', fileName), 'utf8');

    // The captured patch is expressed against the patched tree: bare specifiers
    // in the context lines, and nothing about the generated rewiring.
    expect(contents).toContain("+const label = 'patched';");
    expect(contents).toContain("-const label = 'gamma';");
    expect(contents).toContain("import { beta } from 'beta';");
    expect(contents).not.toContain('../../beta@1.0.0/index.js');
    expect(contents).not.toContain('../../gamma@2.0.0/util.js');

    // The diff of the patched tree shows the edit, still with no rewiring in it.
    const diff = await runCli(['diff', 'alpha'], { cwd, env: offline });
    expect(diff.stdout).toContain("+const label = 'patched';");
    expect(diff.stdout).not.toContain('../../beta@1.0.0/index.js');
  });

  test('a captured patch replays through sync with rewiring reapplied', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);

    const source = await readModule('alpha', 'src', 'index.js');
    await writeFile(
      modulePath('alpha', 'src', 'index.js'),
      source.replace("const label = 'gamma';", "const label = 'patched';"),
      'utf8',
    );
    expect(
      (await runCli(['patch', 'alpha', '-m', 'Relabel the output'], { cwd, env: offline })).exitCode,
    ).toBe(0);

    const sync = await runCli(['sync'], { cwd, env: offline });
    expect(sync.exitCode).toBe(0);

    const rebuilt = await readModule('alpha', 'src', 'index.js');
    expect(rebuilt).toContain("const label = 'patched';");
    expect(rebuilt).toContain("import { beta } from '../../beta@1.0.0/index.js';");

    const run = await runAlphaOnNode();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('beta+gamma-1|util-2|patched');

    expect((await runCli(['verify'], { cwd, env: offline })).exitCode).toBe(0);
    // Capturing again with nothing new to record must not invent a patch.
    const again = await runCli(['patch', 'alpha', '-m', 'Nothing new'], { cwd, env: offline });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('Nothing to capture');
    expect(await seriesFiles('alpha')).toHaveLength(1);
  });

  test('unresolvable specifiers warn and are left exactly as upstream wrote them', async () => {
    await writeProjectConfig(true);
    expect((await addAlpha()).exitCode).toBe(0);

    const source = await readModule('alpha', 'src', 'index.js');
    await writeFile(
      modulePath('alpha', 'src', 'index.js'),
      `import missing from 'gamma/not-here.js';\n${source}`,
      'utf8',
    );
    expect(
      (await runCli(['patch', 'alpha', '-m', 'Import a file gamma does not have'], { cwd, env: offline }))
        .exitCode,
    ).toBe(0);

    const sync = await runCli(['sync'], { cwd, env: offline });
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toContain('could not rewire 1 specifier in "alpha"');
    expect(sync.stderr).toContain('gamma/not-here.js in src/index.js');
    expect(await readModule('alpha', 'src', 'index.js')).toContain(
      "import missing from 'gamma/not-here.js';",
    );
    // Leaving it alone keeps the generated tree reproducible, so verify still passes.
    expect((await runCli(['verify'], { cwd, env: offline })).exitCode).toBe(0);
  });

  test('a package can opt out of a project-wide setting', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [{ name: 'alpha', rewireImports: false }], rewireImports: true }, null, 2)}\n`,
      'utf8',
    );
    expect((await addAlpha()).exitCode).toBe(0);

    expect(await readModule('alpha', 'src', 'index.js')).toContain("import { beta } from 'beta';");
    expect(await readModule('beta@1.0.0', 'index.js')).toContain(
      "import { gamma } from '../gamma@1.0.0/index.js';",
    );
    expect((await runCli(['verify'], { cwd, env: offline })).exitCode).toBe(0);
  });
});

describe('CLI: import rewiring across an update (e2e)', () => {
  let fx: PackageGraphFixture;
  let cwd: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const index = [
      "import { beta } from 'beta';",
      "import { util } from 'gamma/util.js';",
      "const label = 'gamma';",
      '',
      'export const alpha = `${beta}|${util}|${label}`;',
      '',
      'console.log(alpha);',
      '',
    ].join('\n');

    fx = await makePackageGraphFixture(
      [
        {
          name: 'alpha',
          versions: {
            // 1.1.0 adds a file the older pin does not have, so a finalized
            // update has upstream source that has never been rewired before.
            '1.0.0': {
              dependencies: { beta: '^1.0.0', gamma: '^2.0.0' },
              manifest: { type: 'module', main: 'src/index.js' },
              files: { 'src/index.js': index },
            },
            '1.1.0': {
              dependencies: { beta: '^1.0.0', gamma: '^2.0.0' },
              manifest: { type: 'module', main: 'src/index.js' },
              files: {
                'src/index.js': index,
                'src/extra.js': "export { gamma as extra } from 'gamma';\n",
              },
            },
          },
        },
        {
          name: 'beta',
          versions: {
            '1.0.0': {
              manifest: { type: 'module', main: 'index.js' },
              files: { 'index.js': "export const beta = 'beta';\n" },
            },
          },
        },
        {
          name: 'gamma',
          versions: {
            '2.0.0': {
              manifest: { type: 'module', main: 'index.js' },
              files: {
                'index.js': "export const gamma = 'gamma';\n",
                'util.js': "export const util = 'util';\n",
              },
            },
          },
        },
      ],
      'inrepo-rewire-update-fixture-',
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-e2e-rewire-update-');
    await bootstrapHostPackageJson(cwd);
    await writeFile(
      join(cwd, 'inrepo.json'),
      `${JSON.stringify({ packages: [], rewireImports: true }, null, 2)}\n`,
      'utf8',
    );
    env = { ...envFor('inrepo.json'), INREPO_REGISTRY: fx.registryUrl };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('update finalize rebuilds the module with rewiring reapplied', async () => {
    const add = await runCli(
      ['add', '--git', fx.gitUrl('alpha'), '--ref', 'v1.0.0', '--with-deps', 'alpha'],
      { cwd, env },
    );
    expect(add.exitCode).toBe(0);

    const indexPath = join(cwd, 'inrepo_modules', 'alpha', 'src', 'index.js');
    await writeFile(
      indexPath,
      (await readFile(indexPath, 'utf8')).replace("const label = 'gamma';", "const label = 'patched';"),
      'utf8',
    );
    expect(
      (await runCli(['patch', 'alpha', '-m', 'Relabel the output'], { cwd, env })).exitCode,
    ).toBe(0);

    const update = await runCli(['update', 'alpha', '--ref', 'v1.1.0'], { cwd, env });
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain('Relabel the output');

    const rebuilt = await readFile(indexPath, 'utf8');
    expect(rebuilt).toContain("import { beta } from '../../beta@1.0.0/index.js';");
    expect(rebuilt).toContain("import { util } from '../../gamma@2.0.0/util.js';");
    expect(rebuilt).toContain("const label = 'patched';");
    // Source that only exists at the new pin is rewired by the same pass.
    expect(await readFile(join(cwd, 'inrepo_modules', 'alpha', 'src', 'extra.js'), 'utf8')).toBe(
      "export { gamma as extra } from '../../gamma@2.0.0/index.js';\n",
    );

    // `inrepo update` does not re-resolve the recorded graph, so its version
    // edge goes stale; what matters here is that the generated tree still
    // reproduces exactly, rewiring included.
    const offline = { ...envFor('inrepo.json'), INREPO_REGISTRY: OFFLINE_REGISTRY };
    const verify = await runCli(['verify'], { cwd, env: offline });
    expect(verify.stderr).not.toContain('vendored tree does not match');

    // The rebased patch still carries the patched tree's own specifiers.
    const seriesDir = join(cwd, 'inrepo_patches', 'alpha', 'series');
    const [fileName] = (await readdir(seriesDir)).sort();
    const contents = await readFile(join(seriesDir, fileName), 'utf8');
    expect(contents).toContain("import { beta } from 'beta';");
    expect(contents).not.toContain('../../beta@1.0.0/index.js');
  });
});
