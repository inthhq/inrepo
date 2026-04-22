import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where inrepo config lives in a given test scenario. */
export type ConfigMode = 'inrepo.json' | 'package.json';

/** All config locations the e2e suites should be parameterized over. */
export const MODES: ConfigMode[] = ['inrepo.json', 'package.json'];

/** Build an env map that runs the CLI non-interactively against a given config mode. */
export function envFor(mode: ConfigMode): { INREPO_NONINTERACTIVE: '1'; INREPO_CONFIG: ConfigMode } {
  return { INREPO_NONINTERACTIVE: '1', INREPO_CONFIG: mode };
}

/** Read a JSON file and return its parsed object. */
export async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/**
 * Write the given inrepo config to whichever location `mode` selects.
 * For the `package.json` mode, the file must already exist (use {@link bootstrapHostPackageJson}).
 */
export async function writeConfig(
  cwd: string,
  mode: ConfigMode,
  config: Record<string, unknown>,
): Promise<void> {
  if (mode === 'inrepo.json') {
    await writeFile(join(cwd, 'inrepo.json'), `${JSON.stringify(config)}\n`, 'utf8');
    return;
  }
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  pkg.inrepo = config;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/** Read whichever config the mode selects, returning the inrepo subtree only. */
export async function readConfig(cwd: string, mode: ConfigMode): Promise<Record<string, unknown>> {
  if (mode === 'inrepo.json') {
    return readJson(join(cwd, 'inrepo.json'));
  }
  const pkg = await readJson(join(cwd, 'package.json'));
  return pkg.inrepo as Record<string, unknown>;
}

/** Write a minimal host `package.json` (no `inrepo` field) into the test cwd. */
export async function bootstrapHostPackageJson(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, 'package.json'),
    `${JSON.stringify({ name: 'host', version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
}
