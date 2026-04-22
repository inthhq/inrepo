import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upsertPackageJsonInrepo } from './upsert-package-json-inrepo.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

async function readPkg(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
}

describe('upsertPackageJsonInrepo', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-upsert-pkg-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('throws when package.json missing', async () => {
    await expect(upsertPackageJsonInrepo(cwd, { name: 'a' })).rejects.toThrow(
      /package\.json not found/,
    );
  });

  test('throws on invalid package.json', async () => {
    await writeFile(join(cwd, 'package.json'), '{ broken', 'utf8');
    await expect(upsertPackageJsonInrepo(cwd, { name: 'a' })).rejects.toThrow(
      /Invalid package\.json/,
    );
  });

  test('creates inrepo field with packages on first call, preserves other keys', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', version: '1.0.0' }, null, 2) + '\n',
      'utf8',
    );
    await upsertPackageJsonInrepo(cwd, { name: 'a', git: 'https://example.com/a.git' });
    const pkg = await readPkg(cwd);
    expect(pkg.name).toBe('host');
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.inrepo).toEqual({
      packages: [{ name: 'a', git: 'https://example.com/a.git' }],
    });
  });

  test('preserves root exclude/keep when present', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify(
        {
          name: 'host',
          inrepo: { packages: [{ name: 'a' }], exclude: ['.git'], keep: ['src'] },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await upsertPackageJsonInrepo(cwd, { name: 'b', dev: true });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({
      packages: [{ name: 'a' }, { name: 'b', dev: true }],
      exclude: ['.git'],
      keep: ['src'],
    });
  });

  test('updates existing entry and toggles dev off when omitted', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: { packages: [{ name: 'a', dev: true }] } }) + '\n',
      'utf8',
    );
    await upsertPackageJsonInrepo(cwd, { name: 'a', git: 'https://x/a.git' });
    const pkg = await readPkg(cwd);
    expect((pkg.inrepo as Record<string, unknown>).packages).toEqual([
      { name: 'a', git: 'https://x/a.git' },
    ]);
  });

  test('accepts a bare-array inrepo and writes back as object root', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: [{ name: 'a' }] }) + '\n',
      'utf8',
    );
    await upsertPackageJsonInrepo(cwd, { name: 'b' });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({ packages: [{ name: 'a' }, { name: 'b' }] });
  });
});
