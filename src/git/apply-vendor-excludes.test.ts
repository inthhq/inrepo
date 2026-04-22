import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyVendorExcludes } from './apply-vendor-excludes.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

async function seedTree(root: string): Promise<void> {
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref', 'utf8');
  await writeFile(join(root, '.gitignore'), 'node_modules', 'utf8');
  await writeFile(join(root, 'docs', 'guide.md'), 'd', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'x', 'utf8');
  await writeFile(join(root, 'tests', 'a.test.ts'), 't', 'utf8');
}

describe('applyVendorExcludes', () => {
  let dest: string;

  beforeEach(async () => {
    dest = await makeTmpDir('inrepo-excl-');
    await seedTree(dest);
  });

  afterEach(async () => {
    await cleanupTmpDir(dest);
  });

  test('no-op when list is empty', async () => {
    await applyVendorExcludes(dest, []);
    expect(existsSync(join(dest, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(dest, 'docs', 'guide.md'))).toBe(true);
  });

  test('removes literal relative paths', async () => {
    await applyVendorExcludes(dest, ['.git', 'docs']);
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(existsSync(join(dest, 'docs'))).toBe(false);
    expect(existsSync(join(dest, 'src', 'index.ts'))).toBe(true);
  });

  test('skips literal entries that do not exist (silent)', async () => {
    await applyVendorExcludes(dest, ['nope.txt']);
    expect(existsSync(join(dest, 'src', 'index.ts'))).toBe(true);
  });

  test('removes paths matched by /regex/ entries', async () => {
    await applyVendorExcludes(dest, ['/\\.test\\.ts$/']);
    expect(existsSync(join(dest, 'tests', 'a.test.ts'))).toBe(false);
    expect(existsSync(join(dest, 'tests'))).toBe(true);
  });

  test('regex entry can target a directory', async () => {
    await applyVendorExcludes(dest, ['/^docs$/']);
    expect(existsSync(join(dest, 'docs'))).toBe(false);
  });

  test('rejects invalid slash-style regex (only leading slash, no closing)', async () => {
    await expect(applyVendorExcludes(dest, ['/oops'])).rejects.toThrow(
      /Invalid exclude regex/,
    );
  });

  test('rejects absolute literal paths', async () => {
    await expect(applyVendorExcludes(dest, ['/abs/path'])).rejects.toThrow(
      /Invalid exclude regex|Exclude path must be relative/,
    );
  });

  test('rejects unsafe regex (ReDoS)', async () => {
    await expect(applyVendorExcludes(dest, ['/(a+)+$/'])).rejects.toThrow(
      /potentially unsafe \(ReDoS risk\)/,
    );
  });

  test('throws on missing dest', async () => {
    await expect(applyVendorExcludes(join(dest, 'missing'), ['.git'])).rejects.toThrow(
      /Cannot resolve vendor directory for excludes/,
    );
  });
});
