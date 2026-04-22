import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
  LoadConfigNotFoundError,
} from './load-config.js';
import { ensureInrepoInitialized } from './ensure-inrepo-initialized.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

describe('loadConfig', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-loadcfg-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('throws LoadConfigNotFoundError when nothing exists', async () => {
    let caught: unknown;
    try {
      await loadConfig(cwd);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoadConfigNotFoundError);
    expect(isLoadConfigNotFoundError(caught)).toBe(true);
    expect(isLoadConfigNotFoundError(new Error('other'))).toBe(false);
  });

  test('throws LoadConfigNotFoundError when package.json has no inrepo field', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'host' }), 'utf8');
    let caught: unknown;
    try {
      await loadConfig(cwd);
    } catch (e) {
      caught = e;
    }
    expect(isLoadConfigNotFoundError(caught)).toBe(true);
  });

  test('reads object-shaped inrepo.json with packages, exclude, keep', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({
        packages: [{ name: 'a', git: 'https://example.com/a.git', ref: 'main', dev: true }],
        exclude: ['.git', '/^docs\\//'],
        keep: ['src', 'package.json'],
      }),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe('inrepo.json');
    expect(cfg.packages).toEqual([
      { name: 'a', git: 'https://example.com/a.git', ref: 'main', dev: true },
    ]);
    expect(cfg.exclude).toEqual(['.git', '/^docs\\//']);
    expect(cfg.keep).toEqual(['src', 'package.json']);
  });

  test('accepts a bare JSON array of packages (no root exclude/keep)', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify([{ name: 'a' }, { name: 'b', dev: false }]),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.packages.map((p) => p.name)).toEqual(['a', 'b']);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.keep).toEqual([]);
  });

  test('per-package validation errors include the index', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: [{ name: 'a' }, { name: '' }] }),
      'utf8',
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/packages\[1\]\.name/);
  });

  test('rejects bad git/ref/dev types', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: [{ name: 'a', dev: 'yes' }] }),
      'utf8',
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/packages\[0\]\.dev must be a boolean/);
  });

  test('throws on empty inrepo.json', async () => {
    await writeFile(join(cwd, 'inrepo.json'), '   \n', 'utf8');
    await expect(loadConfig(cwd)).rejects.toThrow(/inrepo\.json is empty/);
  });

  test('throws with helpful message on malformed JSON', async () => {
    await writeFile(join(cwd, 'inrepo.json'), '{not json', 'utf8');
    await expect(loadConfig(cwd)).rejects.toThrow(/Invalid JSON in inrepo\.json/);
  });

  test('inrepo.json wins over package.json#inrepo (XOR preference)', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: [{ name: 'from-inrepo' }] }),
      'utf8',
    );
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: { packages: [{ name: 'from-pkg' }] } }),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe('inrepo.json');
    expect(cfg.packages.map((p) => p.name)).toEqual(['from-inrepo']);
  });

  test('reads package.json#inrepo when inrepo.json absent', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'host',
        inrepo: {
          packages: [{ name: 'a' }],
          exclude: ['.git'],
          keep: ['src'],
        },
      }),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe('package.json');
    expect(cfg.packages).toEqual([{ name: 'a' }]);
    expect(cfg.exclude).toEqual(['.git']);
    expect(cfg.keep).toEqual(['src']);
  });

  test('accepts bare-array inrepo field on package.json', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: [{ name: 'a' }] }),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([{ name: 'a' }]);
  });

  test('treats package.json#inrepo: {} as initialized with no packages', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: {} }),
      'utf8',
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe('package.json');
    expect(cfg.packages).toEqual([]);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.keep).toEqual([]);
  });

  test('rejects object with non-array packages key', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ packages: 'oops' }),
      'utf8',
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/Config "packages" must be a JSON array/);
  });

  test('rejects non-object/array inrepo field with a clear message', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: 'oops' }),
      'utf8',
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/JSON array or an object with a "packages" array/);
  });

  test('package.json invalid JSON surfaces a clear error', async () => {
    await writeFile(join(cwd, 'package.json'), '{ not json', 'utf8');
    await expect(loadConfig(cwd)).rejects.toThrow(/Invalid package\.json/);
  });
});

describe('loadGlobalExclude / loadGlobalKeep', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-globals-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('return [] when no config files', async () => {
    expect(await loadGlobalExclude(cwd)).toEqual([]);
    expect(await loadGlobalKeep(cwd)).toEqual([]);
  });

  test('read globals from inrepo.json without packages key', async () => {
    await writeFile(
      join(cwd, 'inrepo.json'),
      JSON.stringify({ exclude: ['.git'], keep: ['src'] }),
      'utf8',
    );
    expect(await loadGlobalExclude(cwd)).toEqual(['.git']);
    expect(await loadGlobalKeep(cwd)).toEqual(['src']);
  });

  test('read globals from package.json#inrepo object', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'h', inrepo: { exclude: ['x'], keep: ['y'] } }),
      'utf8',
    );
    expect(await loadGlobalExclude(cwd)).toEqual(['x']);
    expect(await loadGlobalKeep(cwd)).toEqual(['y']);
  });

  test('return [] when inrepo field is array (no root globals on bare array)', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'h', inrepo: [{ name: 'a' }] }),
      'utf8',
    );
    expect(await loadGlobalExclude(cwd)).toEqual([]);
    expect(await loadGlobalKeep(cwd)).toEqual([]);
  });
});

describe('ensureInrepoInitialized + loadConfig integration', () => {
  const ENV_KEYS = ['INREPO_CONFIG', 'INREPO_NONINTERACTIVE', 'CI'] as const;
  let cwd: string;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-integration-');
    envSnap = {};
    for (const k of ENV_KEYS) envSnap[k] = process.env[k];
    process.env.INREPO_NONINTERACTIVE = '1';
    delete process.env.INREPO_CONFIG;
    delete process.env.CI;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      const v = envSnap[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cleanupTmpDir(cwd);
  });

  test('package.json#inrepo: {} flows through ensureInrepoInitialized into loadConfig with no packages', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: {} }) + '\n',
      'utf8',
    );
    await ensureInrepoInitialized(cwd);
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([]);
    expect(cfg.source).toBe('package.json');
  });

  test('after init via INREPO_CONFIG=inrepo.json, loadConfig returns empty packages', async () => {
    process.env.INREPO_CONFIG = 'inrepo.json';
    await ensureInrepoInitialized(cwd);
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([]);
    expect(cfg.source).toBe('inrepo.json');
  });
});
