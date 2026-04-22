import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  LoadConfigNotFoundError,
  loadGlobalExclude,
  loadGlobalKeep,
} from './load-config.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'inrepo-cfg-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeJson(rel: string, value: unknown): Promise<void> {
  await writeFile(join(cwd, rel), JSON.stringify(value));
}

describe('loadConfig — file branch (inrepo.*)', () => {
  test('object shape with packages, exclude, keep', async () => {
    await writeJson('inrepo.json', {
      packages: [{ name: 'pkg-a', git: 'https://github.com/u/a.git', dev: true }],
      exclude: ['.agents'],
      keep: ['src'],
    });

    const cfg = await loadConfig(cwd);

    expect(cfg.source).toBe('inrepo.json');
    expect(cfg.packages).toEqual([
      { name: 'pkg-a', git: 'https://github.com/u/a.git', dev: true },
    ]);
    expect(cfg.exclude).toEqual(['.agents']);
    expect(cfg.keep).toEqual(['src']);
  });

  test('bare array form yields packages with empty global exclude/keep', async () => {
    await writeJson('inrepo.json', [{ name: 'pkg-b' }]);

    const cfg = await loadConfig(cwd);

    expect(cfg.packages.map((p) => p.name)).toEqual(['pkg-b']);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.keep).toEqual([]);
  });

  test('inrepo.yaml resolves through c12', async () => {
    await writeFile(
      join(cwd, 'inrepo.yaml'),
      ['packages:', '  - name: pkg-yaml', '    git: https://example.com/y.git', ''].join('\n'),
    );

    const cfg = await loadConfig(cwd);

    expect(cfg.source).toBe('inrepo.yaml');
    expect(cfg.packages.map((p) => p.name)).toEqual(['pkg-yaml']);
  });

  test('.config/inrepo.json resolves through c12', async () => {
    await mkdir(join(cwd, '.config'), { recursive: true });
    await writeJson('.config/inrepo.json', { packages: [{ name: 'pkg-config-dir' }] });

    const cfg = await loadConfig(cwd);

    expect(cfg.source).toBe('inrepo.json');
    expect(cfg.packages.map((p) => p.name)).toEqual(['pkg-config-dir']);
  });

  test('extends merges packages and excludes via defu', async () => {
    await mkdir(join(cwd, 'base'), { recursive: true });
    await writeJson('base/inrepo.json', {
      packages: [{ name: 'pkg-base' }],
      exclude: ['.agents'],
    });
    await writeJson('inrepo.json', {
      extends: './base',
      packages: [{ name: 'pkg-top' }],
      exclude: ['docs'],
    });

    const cfg = await loadConfig(cwd);

    expect(cfg.packages.map((p) => p.name).sort()).toEqual(['pkg-base', 'pkg-top']);
    expect([...cfg.exclude].sort()).toEqual(['.agents', 'docs']);
  });
});

describe('loadConfig — package.json#inrepo branch', () => {
  test('reads inrepo field when no inrepo.* file exists', async () => {
    await writeJson('package.json', {
      name: 'fixture',
      inrepo: { packages: [{ name: 'pkg-c' }], exclude: ['docs'] },
    });

    const cfg = await loadConfig(cwd);

    expect(cfg.source).toBe('package.json');
    expect(cfg.packages.map((p) => p.name)).toEqual(['pkg-c']);
    expect(cfg.exclude).toEqual(['docs']);
  });

  test('XOR: inrepo.json wins, package.json#inrepo is ignored', async () => {
    await writeJson('inrepo.json', { packages: [{ name: 'from-file' }] });
    await writeJson('package.json', {
      name: 'fixture',
      inrepo: { packages: [{ name: 'from-pkgjson' }] },
    });

    const cfg = await loadConfig(cwd);

    expect(cfg.packages.map((p) => p.name)).toEqual(['from-file']);
  });
});

describe('loadConfig — strict root keys', () => {
  test('rejects unknown top-level key', async () => {
    await writeJson('inrepo.json', { packages: [], somethingElse: true });

    await expect(loadConfig(cwd)).rejects.toThrow(/unknown top-level key "somethingElse"/i);
  });

  test('rejects $env block (envName is disabled, so it would not be applied)', async () => {
    await writeJson('inrepo.json', {
      packages: [],
      $env: { production: { exclude: ['x'] } },
    });

    await expect(loadConfig(cwd)).rejects.toThrow(/unknown top-level key "\$env"/i);
  });
});

describe('loadConfig — not-found behaviour', () => {
  test('empty cwd throws LoadConfigNotFoundError', async () => {
    await expect(loadConfig(cwd)).rejects.toBeInstanceOf(LoadConfigNotFoundError);
    await expect(loadConfig(cwd)).rejects.toThrow(/No inrepo config/i);
  });

  test('package.json without inrepo field throws LoadConfigNotFoundError', async () => {
    await writeJson('package.json', { name: 'no-inrepo' });

    await expect(loadConfig(cwd)).rejects.toThrow(/No inrepo config/i);
  });

  test('isLoadConfigNotFoundError flags only LoadConfigNotFoundError instances', async () => {
    try {
      await loadConfig(cwd);
      throw new Error('expected loadConfig to throw');
    } catch (e) {
      expect(isLoadConfigNotFoundError(e)).toBe(true);
    }
    expect(isLoadConfigNotFoundError(new Error('other'))).toBe(false);
  });
});

describe('loadGlobalExclude / loadGlobalKeep', () => {
  test('return empty arrays when no config is present', async () => {
    expect(await loadGlobalExclude(cwd)).toEqual([]);
    expect(await loadGlobalKeep(cwd)).toEqual([]);
  });

  test('read inrepo.json without requiring packages', async () => {
    await writeJson('inrepo.json', {
      packages: [],
      exclude: ['only-globals'],
      keep: ['kept'],
    });

    expect(await loadGlobalExclude(cwd)).toEqual(['only-globals']);
    expect(await loadGlobalKeep(cwd)).toEqual(['kept']);
  });
});
