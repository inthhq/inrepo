import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { loadEntryManifest } from './resolve-vendored-entry.js';
import {
  relativeSpecifier,
  rewireTree,
  splitBareSpecifier,
  unrewireTree,
  type RewirePlan,
} from './rewire-tree.js';

const MODULES = 'inrepo_modules';

describe('splitBareSpecifier', () => {
  test('splits package names and subpaths', () => {
    expect(splitBareSpecifier('picocolors')).toEqual({ name: 'picocolors', subpath: '' });
    expect(splitBareSpecifier('pkg/deep/file.js')).toEqual({
      name: 'pkg',
      subpath: 'deep/file.js',
    });
    expect(splitBareSpecifier('@scope/pkg')).toEqual({ name: '@scope/pkg', subpath: '' });
    expect(splitBareSpecifier('@scope/pkg/sub')).toEqual({ name: '@scope/pkg', subpath: 'sub' });
  });

  test('rejects everything that is not a bare package specifier', () => {
    for (const value of ['./local.js', '../up.js', '/abs.js', '#alias', 'node:fs', 'https://x/y']) {
      expect(splitBareSpecifier(value)).toBeNull();
    }
  });
});

describe('relativeSpecifier', () => {
  test('walks up from the importing file to the sibling module', () => {
    expect(
      relativeSpecifier({
        modulePath: 'alpha',
        fileRelPosix: 'src/deep/index.js',
        depModulePath: 'beta',
        depFileRelPosix: 'lib/beta.js',
      }),
    ).toBe('../../../beta/lib/beta.js');
  });

  test('handles scoped packages on both ends', () => {
    expect(
      relativeSpecifier({
        modulePath: '@scope/alpha',
        fileRelPosix: 'index.js',
        depModulePath: '@other/beta',
        depFileRelPosix: 'index.js',
      }),
    ).toBe('../../@other/beta/index.js');
  });

  test('targets a version-qualified module while preserving the bare import identity', () => {
    expect(
      relativeSpecifier({
        modulePath: '@scope/alpha',
        fileRelPosix: 'src/index.js',
        depModulePath: '@other/beta@2.3.1',
        depFileRelPosix: 'dist/index.js',
      }),
    ).toBe('../../../@other/beta@2.3.1/dist/index.js');
  });
});

describe('rewireTree', () => {
  let cwd: string;
  let alpha: string;

  async function writeModule(
    name: string,
    files: Record<string, string>,
  ): Promise<string> {
    const root = join(cwd, MODULES, ...name.split('/'));
    for (const [path, contents] of Object.entries(files)) {
      const abs = join(root, ...path.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, 'utf8');
    }
    return root;
  }

  async function planFor(name: string, dependencies: string[]): Promise<RewirePlan> {
    const map = new Map();
    for (const dependency of dependencies) {
      const root = join(cwd, MODULES, ...dependency.split('/'));
      map.set(dependency, {
        modulePath: dependency,
        root,
        manifest: await loadEntryManifest(root),
      });
    }
    return { name, modulePath: name, dependencies: map };
  }

  async function read(path: string): Promise<string> {
    return readFile(join(alpha, ...path.split('/')), 'utf8');
  }

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-rewire-');
    await writeModule('beta', {
      'package.json': JSON.stringify({ name: 'beta', main: 'lib/beta.js' }),
      'lib/beta.js': 'module.exports = 1;\n',
      'extra.js': 'module.exports = 2;\n',
    });
    await writeModule('@scope/gamma', {
      'package.json': JSON.stringify({ name: '@scope/gamma', main: 'index.js' }),
      'index.js': 'module.exports = 3;\n',
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('rewrites every specifier form at the right depth and leaves the rest alone', async () => {
    alpha = await writeModule('alpha', {
      'index.js': [
        'import beta from "beta";',
        'export { thing } from "beta/extra.js";',
        'import gamma from "@scope/gamma";',
        'import untouched from "lodash";',
        'import local from "./local.js";',
        'import builtin from "node:path";',
        '',
      ].join('\n'),
      'src/nested/deep.cjs': [
        'const beta = require("beta");',
        'const lazy = () => import("beta/extra.js");',
        'const text = "beta";',
        '',
      ].join('\n'),
      'notes.md': 'import beta from "beta";\n',
      'data.json': '{"main":"beta"}',
    });

    const report = await rewireTree(alpha, await planFor('alpha', ['beta', '@scope/gamma']));

    expect(report.specifiers).toBe(5);
    expect(report.files).toBe(2);
    expect(report.unresolved).toEqual([]);
    expect(await read('index.js')).toBe(
      [
        'import beta from "../beta/lib/beta.js";',
        'export { thing } from "../beta/extra.js";',
        'import gamma from "../@scope/gamma/index.js";',
        'import untouched from "lodash";',
        'import local from "./local.js";',
        'import builtin from "node:path";',
        '',
      ].join('\n'),
    );
    expect(await read('src/nested/deep.cjs')).toBe(
      [
        'const beta = require("../../../beta/lib/beta.js");',
        'const lazy = () => import("../../../beta/extra.js");',
        'const text = "beta";',
        '',
      ].join('\n'),
    );
    // Only source files are read: markdown and JSON keep their text verbatim.
    expect(await read('notes.md')).toBe('import beta from "beta";\n');
    expect(await read('data.json')).toBe('{"main":"beta"}');
  });

  test('is idempotent: a second pass rewrites nothing', async () => {
    alpha = await writeModule('alpha', { 'index.js': 'import beta from "beta";\n' });
    const plan = await planFor('alpha', ['beta']);

    await rewireTree(alpha, plan);
    const once = await read('index.js');
    const second = await rewireTree(alpha, plan);

    expect(second.specifiers).toBe(0);
    expect(await read('index.js')).toBe(once);
  });

  test('reports a specifier that names a vendored dependency but resolves to nothing', async () => {
    alpha = await writeModule('alpha', {
      'index.js': 'import missing from "beta/not-here.js";\nimport beta from "beta";\n',
    });

    const report = await rewireTree(alpha, await planFor('alpha', ['beta']));

    expect(report.unresolved).toEqual([{ file: 'index.js', specifier: 'beta/not-here.js' }]);
    expect(await read('index.js')).toBe(
      'import missing from "beta/not-here.js";\nimport beta from "../beta/lib/beta.js";\n',
    );
  });

  test('write: false records the same rewrites without touching the tree', async () => {
    alpha = await writeModule('alpha', { 'index.js': 'import beta from "beta";\n' });

    const report = await rewireTree(alpha, await planFor('alpha', ['beta']), { write: false });

    expect(report.specifiers).toBe(1);
    expect(report.rewrites.get('index.js')).toEqual([
      { from: 'beta', to: '../beta/lib/beta.js' },
    ]);
    expect(await read('index.js')).toBe('import beta from "beta";\n');
  });
});

describe('unrewireTree', () => {
  let cwd: string;
  let module: string;

  async function write(path: string, contents: string): Promise<void> {
    const abs = join(module, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, 'utf8');
  }

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-unrewire-');
    module = join(cwd, 'module');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('restores the original specifiers and keeps unrelated edits', async () => {
    await write(
      'index.js',
      [
        'import beta from "../beta/lib/beta.js";',
        'const added = "user edit";',
        'export { x } from "../beta/extra.js";',
        '',
      ].join('\n'),
    );

    const restored = await unrewireTree(
      module,
      new Map([
        [
          'index.js',
          [
            { from: 'beta', to: '../beta/lib/beta.js' },
            { from: 'beta/extra.js', to: '../beta/extra.js' },
          ],
        ],
      ]),
    );

    expect(restored).toBe(2);
    expect(await readFile(join(module, 'index.js'), 'utf8')).toBe(
      ['import beta from "beta";', 'const added = "user edit";', 'export { x } from "beta/extra.js";', ''].join(
        '\n',
      ),
    );
  });

  test('matches repeated specifiers in source order', async () => {
    await write(
      'index.js',
      ['import a from "../beta/lib/beta.js";', 'import b from "../beta/lib/beta.js";', ''].join('\n'),
    );

    await unrewireTree(
      module,
      new Map([
        [
          'index.js',
          [
            { from: 'beta', to: '../beta/lib/beta.js' },
            { from: 'beta/lib/beta.js', to: '../beta/lib/beta.js' },
          ],
        ],
      ]),
    );

    expect(await readFile(join(module, 'index.js'), 'utf8')).toBe(
      ['import a from "beta";', 'import b from "beta/lib/beta.js";', ''].join('\n'),
    );
  });

  test('leaves a rewired specifier the user changed by hand as a real edit', async () => {
    await write('index.js', 'import beta from "../beta/other.js";\n');

    const restored = await unrewireTree(
      module,
      new Map([['index.js', [{ from: 'beta', to: '../beta/lib/beta.js' }]]]),
    );

    expect(restored).toBe(0);
    expect(await readFile(join(module, 'index.js'), 'utf8')).toBe(
      'import beta from "../beta/other.js";\n',
    );
  });

  test('skips a file the working tree deleted', async () => {
    expect(
      await unrewireTree(module, new Map([['gone.js', [{ from: 'beta', to: '../beta/i.js' }]]])),
    ).toBe(0);
  });
});
