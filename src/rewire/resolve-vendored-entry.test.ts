import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { loadEntryManifest, resolveVendoredEntry } from './resolve-vendored-entry.js';

describe('resolveVendoredEntry', () => {
  let dep: string;

  beforeEach(async () => {
    dep = await makeTmpDir('inrepo-entry-');
  });

  afterEach(async () => {
    await cleanupTmpDir(dep);
  });

  async function writeFiles(
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ): Promise<void> {
    await writeFile(join(dep, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    for (const [path, contents] of Object.entries(files)) {
      const abs = join(dep, ...path.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, 'utf8');
    }
  }

  function resolve(subpath: string, condition: 'import' | 'require' = 'import') {
    return loadEntryManifest(dep).then((manifest) =>
      resolveVendoredEntry({ depRoot: dep, manifest, subpath, condition }),
    );
  }

  test('resolves "main" to a concrete file', async () => {
    await writeFiles({ name: 'dep', main: 'lib/dep.js' }, { 'lib/dep.js': '' });
    expect(await resolve('')).toBe('lib/dep.js');
  });

  test('prefers "module" over "main" for an import and "main" for a require', async () => {
    await writeFiles(
      { name: 'dep', main: 'dist/cjs.js', module: 'dist/esm.js' },
      { 'dist/cjs.js': '', 'dist/esm.js': '' },
    );
    expect(await resolve('', 'import')).toBe('dist/esm.js');
    expect(await resolve('', 'require')).toBe('dist/cjs.js');
  });

  test('honors an "exports" string and a conditions object', async () => {
    await writeFiles({ name: 'dep', exports: './out/main.js' }, { 'out/main.js': '' });
    expect(await resolve('')).toBe('out/main.js');

    await writeFiles(
      {
        name: 'dep',
        main: 'legacy.js',
        exports: { '.': { import: './esm/index.js', require: './cjs/index.cjs' } },
      },
      { 'legacy.js': '', 'esm/index.js': '', 'cjs/index.cjs': '' },
    );
    expect(await resolve('', 'import')).toBe('esm/index.js');
    expect(await resolve('', 'require')).toBe('cjs/index.cjs');
  });

  test('honors an exported subpath before the literal path', async () => {
    await writeFiles(
      { name: 'dep', exports: { '.': './index.js', './sub': './src/sub-impl.js' } },
      { 'index.js': '', 'src/sub-impl.js': '', 'sub.js': '' },
    );
    expect(await resolve('sub')).toBe('src/sub-impl.js');
  });

  test('adds an extension and falls back to a directory index', async () => {
    await writeFiles({ name: 'dep', main: 'index.js' }, { 'index.js': '', 'deep/index.js': '' });
    expect(await resolve('deep')).toBe('deep/index.js');

    await writeFiles({ name: 'dep', main: 'index.js' }, { 'index.js': '', 'util.js': '' });
    expect(await resolve('util')).toBe('util.js');
    expect(await resolve('util.js')).toBe('util.js');
  });

  test('falls back to index.js when no manifest field resolves', async () => {
    await writeFiles({ name: 'dep', main: 'missing.js' }, { 'index.js': '' });
    expect(await resolve('')).toBe('index.js');
  });

  test('returns null when nothing resolves', async () => {
    await writeFiles({ name: 'dep', main: 'index.js' }, { 'index.js': '' });
    expect(await resolve('nope/missing.js')).toBeNull();
  });

  test('refuses a candidate escaping the dependency root', async () => {
    await writeFiles({ name: 'dep', main: '../outside.js' }, {});
    expect(await resolve('')).toBeNull();
    expect(await resolve('../outside.js')).toBeNull();
  });

  test('reads no manifest at all as a plain index.js package', async () => {
    await mkdir(dep, { recursive: true });
    await writeFile(join(dep, 'index.js'), '', 'utf8');
    expect(await loadEntryManifest(dep)).toBeNull();
    expect(await resolveVendoredEntry({ depRoot: dep, manifest: null, subpath: '', condition: 'import' })).toBe(
      'index.js',
    );
  });
});
