import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { diffTrees } from './diff-trees.js';

describe('diffTrees', () => {
  let cwd: string;
  let base: string;
  let target: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-diff-trees-');
    base = join(cwd, 'base');
    target = join(cwd, 'target');

    for (const root of [base, target]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
      await writeFile(join(root, 'README.md'), '# upstream\n', 'utf8');
      // A NUL byte is what makes git treat the file as binary rather than text.
      await writeFile(join(root, 'logo.bin'), new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    }
    await writeFile(join(base, '.cache-meta.json'), '{}\n', 'utf8');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('returns an empty string for identical trees', async () => {
    expect(await diffTrees({ baseRoot: base, targetRoot: target })).toBe('');
  });

  test('renders hunks for a modified file', async () => {
    await writeFile(join(target, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');

    const diff = await diffTrees({ baseRoot: base, targetRoot: target });
    expect(diff).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(diff).toContain('-export const v = 1;');
    expect(diff).toContain('+export const v = 99;');
  });

  test('renders additions and deletions', async () => {
    await writeFile(join(target, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');
    await rm(join(target, 'README.md'));

    const diff = await diffTrees({ baseRoot: base, targetRoot: target });
    expect(diff).toContain('new file mode 100644');
    expect(diff).toContain('+++ b/src/local.ts');
    expect(diff).toContain('deleted file mode 100644');
    expect(diff).toContain('--- a/README.md');
  });

  test('renders mode changes and binary differences without literal blobs', async () => {
    await chmod(join(target, 'src', 'index.ts'), 0o755);
    await writeFile(join(target, 'logo.bin'), new Uint8Array([0x89, 0x50, 0x00, 0x02]));

    const diff = await diffTrees({ baseRoot: base, targetRoot: target });
    expect(diff).toContain('old mode 100644');
    expect(diff).toContain('new mode 100755');
    expect(diff).toContain('Binary files a/logo.bin and b/logo.bin differ');
    expect(diff).not.toContain('GIT binary patch');
  });

  test('ignores cache metadata and generated markers on either side', async () => {
    await writeFile(join(target, '.inrepo-vendor.json'), '{"commit":"abc"}\n', 'utf8');
    expect(await diffTrees({ baseRoot: base, targetRoot: target })).toBe('');
  });

  test('--stat summarizes per file instead of showing hunks', async () => {
    await writeFile(join(target, 'src', 'index.ts'), 'export const v = 99;\n', 'utf8');
    await writeFile(join(target, 'src', 'local.ts'), 'export const local = true;\n', 'utf8');

    const stat = await diffTrees({ baseRoot: base, targetRoot: target, stat: true });
    expect(stat).toContain('src/index.ts');
    expect(stat).toContain('src/local.ts');
    expect(stat).toMatch(/2 files changed/);
    expect(stat).not.toContain('export const v = 99;');
  });
});
