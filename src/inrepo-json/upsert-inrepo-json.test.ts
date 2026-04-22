import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upsertInrepoJson } from './upsert-inrepo-json.js';
import { defaultInrepoJsonSchemaRef } from './default-inrepo-json-schema-ref.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('upsertInrepoJson', () => {
  let cwd: string;
  let path: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-upsert-');
    path = join(cwd, 'inrepo.json');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('creates inrepo.json with default $schema when missing', async () => {
    await upsertInrepoJson(cwd, { name: 'a', git: 'https://example.com/a.git', ref: 'main' });
    expect(existsSync(path)).toBe(true);
    const data = await readJson(path);
    expect(data.packages).toEqual([{ name: 'a', git: 'https://example.com/a.git', ref: 'main' }]);
    expect(data.$schema).toBe(defaultInrepoJsonSchemaRef);
  });

  test('appends to bare-array config and promotes it to an object root with default $schema', async () => {
    await writeFile(path, JSON.stringify([{ name: 'a' }]) + '\n', 'utf8');
    await upsertInrepoJson(cwd, { name: 'b' });
    const data = await readJson(path);
    expect(data.packages).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(data.$schema).toBe(defaultInrepoJsonSchemaRef);
  });

  test('updates existing entry by name and merges git/ref', async () => {
    await upsertInrepoJson(cwd, { name: 'a', git: 'https://example.com/a.git' });
    await upsertInrepoJson(cwd, { name: 'a', ref: 'v1.2.3' });
    const data = await readJson(path);
    expect(data.packages).toEqual([
      { name: 'a', git: 'https://example.com/a.git', ref: 'v1.2.3' },
    ]);
  });

  test('toggles dev: true on, then off when omitted', async () => {
    await upsertInrepoJson(cwd, { name: 'a', dev: true });
    expect((await readJson(path)).packages).toEqual([{ name: 'a', dev: true }]);
    await upsertInrepoJson(cwd, { name: 'a' });
    expect((await readJson(path)).packages).toEqual([{ name: 'a' }]);
  });

  test('preserves existing $schema and other top-level keys / order', async () => {
    const original = {
      $schema: 'https://example.com/custom.schema.json',
      packages: [{ name: 'a' }],
      exclude: ['.git'],
      keep: ['src'],
      somethingCustom: { hello: 'world' },
    };
    await writeFile(path, JSON.stringify(original, null, 2) + '\n', 'utf8');
    await upsertInrepoJson(cwd, { name: 'b', dev: true });

    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(['$schema', 'packages', 'exclude', 'keep', 'somethingCustom']);
    expect(parsed.$schema).toBe('https://example.com/custom.schema.json');
    expect(parsed.exclude).toEqual(['.git']);
    expect(parsed.keep).toEqual(['src']);
    expect(parsed.somethingCustom).toEqual({ hello: 'world' });
    expect(parsed.packages).toEqual([{ name: 'a' }, { name: 'b', dev: true }]);
  });

  test('throws on invalid existing JSON', async () => {
    await writeFile(path, '{ broken', 'utf8');
    await expect(upsertInrepoJson(cwd, { name: 'a' })).rejects.toThrow(/Invalid JSON in inrepo\.json/);
  });

  test('throws on invalid root shape', async () => {
    await writeFile(path, JSON.stringify('nope'), 'utf8');
    await expect(upsertInrepoJson(cwd, { name: 'a' })).rejects.toThrow(
      /must be a JSON array or \{ "packages": \[\.\.\.\] \}/,
    );
  });
});
