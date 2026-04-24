import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureInrepoInitialized } from './ensure-inrepo-initialized.js';
import { defaultInrepoJsonSchemaRef } from '../inrepo-json/default-inrepo-json-schema-ref.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { type EnvSnapshot, restoreEnv, snapshotEnv } from '../test-utils/test-env.js';

describe('ensureInrepoInitialized (non-interactive)', () => {
  let cwd: string;
  let envSnap: EnvSnapshot;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-init-');
    envSnap = snapshotEnv();
    process.env.INREPO_NONINTERACTIVE = '1';
    delete process.env.INREPO_CONFIG;
    delete process.env.CI;
  });

  afterEach(async () => {
    restoreEnv(envSnap);
    await cleanupTmpDir(cwd);
  });

  test('no-ops when inrepo.json already exists', async () => {
    await writeFile(join(cwd, 'inrepo.json'), '{"packages":[]}\n', 'utf8');
    await ensureInrepoInitialized(cwd);
    const raw = await readFile(join(cwd, 'inrepo.json'), 'utf8');
    expect(raw).toBe('{"packages":[]}\n');
  });

  test('no-ops when package.json#inrepo is set', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host', inrepo: { packages: [] } }) + '\n',
      'utf8',
    );
    await ensureInrepoInitialized(cwd);
    expect(existsSync(join(cwd, 'inrepo.json'))).toBe(false);
  });

  test('throws non-interactive hint when no config and no INREPO_CONFIG', async () => {
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /first-time setup needs an interactive terminal/,
    );
  });

  test('INREPO_CONFIG=inrepo.json writes a stub with the default $schema', async () => {
    process.env.INREPO_CONFIG = 'inrepo.json';
    await ensureInrepoInitialized(cwd);
    const raw = await readFile(join(cwd, 'inrepo.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ packages: [], $schema: defaultInrepoJsonSchemaRef });
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('/inrepo_modules/\n/.inrepo/\n');
  });

  test('INREPO_CONFIG=package.json requires an existing package.json', async () => {
    process.env.INREPO_CONFIG = 'package.json';
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /requires a package\.json in the project root/,
    );
  });

  test('INREPO_CONFIG=package.json adds inrepo field to existing package.json', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'host' }) + '\n',
      'utf8',
    );
    process.env.INREPO_CONFIG = 'package.json';
    await ensureInrepoInitialized(cwd);
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    expect(pkg.inrepo).toEqual({ packages: [] });
    expect(pkg.name).toBe('host');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('/inrepo_modules/\n/.inrepo/\n');
  });

  test('does not duplicate root-anchored .gitignore entries', async () => {
    await writeFile(join(cwd, '.gitignore'), '/inrepo_modules/\n/.inrepo/\n', 'utf8');
    process.env.INREPO_CONFIG = 'inrepo.json';
    await ensureInrepoInitialized(cwd);
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('/inrepo_modules/\n/.inrepo/\n');
  });

  test('rejects array-valued package.json roots for package.json setup', async () => {
    await writeFile(join(cwd, 'package.json'), '[]\n', 'utf8');
    process.env.INREPO_CONFIG = 'package.json';
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /Invalid package\.json: expected a JSON object at the root/,
    );
  });

  test('INREPO_CONFIG is case-insensitive', async () => {
    process.env.INREPO_CONFIG = 'INREPO.JSON';
    await ensureInrepoInitialized(cwd);
    expect(existsSync(join(cwd, 'inrepo.json'))).toBe(true);
  });
});
