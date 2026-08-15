import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrapHostPackageJson,
  envFor,
  readJson,
  writeConfig,
} from '../test-utils/e2e-harness.js';
import { makeLocalGitFixture, type LocalGitFixture } from '../test-utils/local-git-fixture.js';
import { runCli } from '../test-utils/run-cli.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

const MODE = 'inrepo.json';

describe('CLI: repository subtree lifecycle (e2e)', () => {
  let cwd: string;
  let fx: LocalGitFixture;
  let moduleRoot: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-subtree-e2e-');
    fx = await makeLocalGitFixture('inrepo-subtree-upstream-');
    await fx.commitUpstream(
      {
        'packages/tool/package.json': '{"name":"@scope/tool","version":"1.0.0"}\n',
        'packages/tool/src/index.ts': 'export const upstream = 1;\n',
        'packages/other/package.json': '{"name":"other"}\n',
      },
      'add workspace packages',
    );
    moduleRoot = join(cwd, 'inrepo_modules', '@scope', 'tool');
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, {
      packages: [
        {
          name: '@scope/tool',
          git: fx.url,
          repositoryDirectory: 'packages/tool',
          ref: 'main',
          keep: ['package.json', 'src'],
        },
      ],
    });
  });

  afterEach(async () => {
    await Promise.all([cleanupTmpDir(cwd), fx.cleanup()]);
  });

  function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { cwd, env: envFor(MODE) });
  }

  test('keeps sync, diff, patch, update, and verify paths package-relative', async () => {
    expect((await cli(['sync'])).exitCode).toBe(0);
    expect(await readFile(join(moduleRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export const upstream = 1;\n',
    );
    expect(existsSync(join(moduleRoot, 'packages'))).toBe(false);
    expect(existsSync(join(moduleRoot, 'README.md'))).toBe(false);

    const marker = await readJson(join(moduleRoot, '.inrepo-vendor.json'));
    expect(marker.repositoryDirectory).toBe('packages/tool');
    const firstLock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { repositoryDirectory?: string }>;
    };
    expect(firstLock.modules['@scope/tool'].repositoryDirectory).toBe('packages/tool');

    await writeFile(join(moduleRoot, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    expect((await cli(['patch', '@scope/tool', '-m', 'Add local helper'])).exitCode).toBe(0);
    const diff = await cli(['diff', '@scope/tool']);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('b/src/local.ts');
    expect(diff.stdout).not.toContain('packages/tool/src/local.ts');

    const moved = await fx.commitUpstream(
      { 'packages/tool/src/index.ts': 'export const upstream = 2;\n' },
      'move scoped package',
    );
    expect((await cli(['update', '@scope/tool'])).exitCode).toBe(0);
    expect(await readFile(join(moduleRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export const upstream = 2;\n',
    );
    expect(await readFile(join(moduleRoot, 'src', 'local.ts'), 'utf8')).toBe(
      'export const local = true;\n',
    );

    const finalLock = (await readJson(join(cwd, 'inrepo.lock.json'))) as {
      modules: Record<string, { commit: string; repositoryDirectory?: string }>;
    };
    expect(finalLock.modules['@scope/tool']).toMatchObject({
      commit: moved,
      repositoryDirectory: 'packages/tool',
    });
    expect((await cli(['verify'])).exitCode).toBe(0);
  });
});
