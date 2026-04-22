import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { inrepoConfigPath } from '../paths/inrepo-config-path.js';
import { packageJsonPath } from '../paths/package-json-path.js';

const STUB = `{
  "packages": []
}
`;

function packageJsonHasInrepoKey(cwd: string): boolean {
  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) return false;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    if (!raw.trim()) return false;
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return (
      pkg != null &&
      typeof pkg === 'object' &&
      'inrepo' in pkg &&
      pkg.inrepo != null
    );
  } catch {
    return false;
  }
}

async function writeInrepoJsonStub(cwd: string): Promise<void> {
  await writeFile(inrepoConfigPath(cwd), STUB, 'utf8');
}

async function writePackageJsonInrepoStub(cwd: string): Promise<void> {
  const pkgPath = packageJsonPath(cwd);
  const raw = await readFile(pkgPath, 'utf8');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (pkg == null || typeof pkg !== 'object') {
    throw new Error('package.json must contain a JSON object');
  }
  if (pkg.inrepo != null) return;
  pkg.inrepo = { packages: [] };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function isNonInteractive(): boolean {
  return (
    !input.isTTY ||
    !output.isTTY ||
    process.env.CI === 'true' ||
    process.env.INREPO_NONINTERACTIVE === '1'
  );
}

function nonInteractiveHint(): string {
  return (
    'Create inrepo.json with {"packages":[]}, or add "inrepo": {"packages":[]} to package.json. ' +
    'Alternatively set INREPO_CONFIG=inrepo.json or INREPO_CONFIG=package.json (non-interactive setup).'
  );
}

/**
 * First-time setup: if there is no inrepo.json and no package.json#inrepo, prompt (TTY) or
 * read INREPO_CONFIG / fail with instructions (CI).
 */
export async function ensureInrepoInitialized(cwd: string): Promise<void> {
  if (existsSync(inrepoConfigPath(cwd))) return;
  if (packageJsonHasInrepoKey(cwd)) return;

  const envRaw = process.env.INREPO_CONFIG?.trim().toLowerCase();
  if (envRaw === 'inrepo.json' || envRaw === 'package.json') {
    if (envRaw === 'package.json') {
      if (!existsSync(packageJsonPath(cwd))) {
        throw new Error('INREPO_CONFIG=package.json requires a package.json in the project root.');
      }
      await writePackageJsonInrepoStub(cwd);
    } else {
      await writeInrepoJsonStub(cwd);
    }
    return;
  }

  if (isNonInteractive()) {
    throw new Error(`inrepo: first-time setup needs an interactive terminal.\n${nonInteractiveHint()}`);
  }

  const hasPackageJson = existsSync(packageJsonPath(cwd));
  console.log('');
  console.log('inrepo — first-time setup');
  console.log('');
  console.log('Where should vendoring configuration live?');
  console.log('  1) inrepo.json (dedicated file at the project root)');
  if (hasPackageJson) {
    console.log('  2) package.json under the "inrepo" field');
  } else {
    console.log('  (package.json not found — only option 1 is available.)');
  }

  const rl = readline.createInterface({ input, output });
  try {
    const defaultChoice = '1';
    const line = (await rl.question(`Enter 1${hasPackageJson ? ' or 2' : ''} [${defaultChoice}]: `)).trim();
    const ans = line || defaultChoice;
    if (ans === '1') {
      await writeInrepoJsonStub(cwd);
      return;
    }
    if (ans === '2' && hasPackageJson) {
      await writePackageJsonInrepoStub(cwd);
      return;
    }
    throw new Error(hasPackageJson ? 'Enter 1 or 2.' : 'Enter 1.');
  } finally {
    rl.close();
  }
}
