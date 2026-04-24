import { cancel, confirm, intro, isCancel, log, outro, select } from '@clack/prompts';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { defaultInrepoJsonSchemaRef } from '../inrepo-json/default-inrepo-json-schema-ref.js';
import { inrepoConfigPath } from '../paths/inrepo-config-path.js';
import { packageJsonPath } from '../paths/package-json-path.js';

const STUB = `{
  "packages": [],
  "$schema": "${defaultInrepoJsonSchemaRef}"
}
`;

const GITIGNORE_LINES = ['/inrepo_modules/', '/.inrepo/'] as const;
const GITIGNORE_RECOMMENDATION =
  'Keep "/inrepo_modules/" and "/.inrepo/" in .gitignore (init recommends or adds them; never ignore "inrepo_patches/").';

function normalizeGitignoreLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function packageJsonHasInrepoKey(cwd: string): boolean {
  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) return false;
  const raw = readFileSync(pkgPath, 'utf8');
  if (!raw.trim()) {
    throw new Error('Invalid package.json: file is empty');
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid package.json: ${err.message}`);
  }
  if (pkg == null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error('Invalid package.json: expected a JSON object at the root');
  }
  const obj = pkg as Record<string, unknown>;
  return 'inrepo' in obj && obj.inrepo != null;
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
  if (pkg == null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error('package.json must contain a JSON object');
  }
  if (pkg.inrepo != null) return;
  pkg.inrepo = { packages: [] };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function appendGitignoreLines(
  cwd: string,
  opts: { interactive: boolean },
): Promise<string[]> {
  const path = join(cwd, '.gitignore');
  const raw = existsSync(path) ? await readFile(path, 'utf8') : '';
  const existing = new Set(raw.split(/\r?\n/).map(normalizeGitignoreLine));
  const missing = GITIGNORE_LINES.filter((line) => !existing.has(normalizeGitignoreLine(line)));
  if (missing.length === 0) return [];

  if (opts.interactive) {
    const shouldAppend = await confirm({
      message: `Add these lines to .gitignore?\n${missing.map((line) => `  ${line}`).join('\n')}`,
      initialValue: true,
    });
    if (isCancel(shouldAppend) || shouldAppend !== true) {
      return [];
    }
  }

  const prefix = raw === '' ? '' : raw.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${raw}${prefix}${missing.join('\n')}\n`, 'utf8');
  return missing;
}

function logGitignoreRecommendation(added: string[]): void {
  if (added.length > 0) {
    log.info(`Added to .gitignore: ${added.join(', ')}`);
  }
  log.message(GITIGNORE_RECOMMENDATION);
}

function isNonInteractive(): boolean {
  return (
    !input.isTTY ||
    !output.isTTY ||
    process.env.CI === 'true' ||
    process.env.INREPO_NONINTERACTIVE === '1'
  );
}

/**
 * Whether the current process can run interactive Clack prompts: a TTY on both
 * stdin/stdout, not in CI, and not explicitly opted out via INREPO_NONINTERACTIVE.
 */
export function canPromptInteractively(): boolean {
  return !isNonInteractive();
}

function nonInteractiveHint(): string {
  const example = JSON.stringify({
    packages: [],
    $schema: defaultInrepoJsonSchemaRef,
  });
  return (
    `Create inrepo.json with ${example}, or add "inrepo": {"packages":[]} to package.json. ` +
    'Alternatively set INREPO_CONFIG=inrepo.json or INREPO_CONFIG=package.json (non-interactive setup).'
  );
}

/**
 * Whether this project already has inrepo configuration in either supported
 * location (dedicated `inrepo.json` or a `package.json#inrepo` field).
 *
 * Throws if `package.json` is present but malformed, so callers surface a
 * clear error instead of silently treating the project as uninitialized.
 */
export function isInrepoInitialized(cwd: string): boolean {
  if (existsSync(inrepoConfigPath(cwd))) return true;
  return packageJsonHasInrepoKey(cwd);
}

/** Thrown when the user aborts first-time setup (e.g. Escape); the CLI exits without a generic error line. */
export class InrepoSetupCancelledError extends Error {
  constructor() {
    super('First-time setup cancelled.');
    this.name = 'InrepoSetupCancelledError';
  }
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
    const added = await appendGitignoreLines(cwd, { interactive: false });
    logGitignoreRecommendation(added);
    return;
  }

  if (isNonInteractive()) {
    throw new Error(`inrepo: first-time setup needs an interactive terminal.\n${nonInteractiveHint()}`);
  }

  const hasPackageJson = existsSync(packageJsonPath(cwd));

  intro('inrepo — first-time setup');

  type ConfigLocation = 'inrepo.json' | 'package.json';
  const options: { value: ConfigLocation; label: string; hint: string }[] = [
    {
      value: 'inrepo.json',
      label: 'inrepo.json',
      hint: 'Dedicated file at the project root',
    },
  ];
  if (hasPackageJson) {
    options.push({
      value: 'package.json',
      label: 'package.json',
      hint: '"inrepo" field',
    });
  }

  const choice = await select<ConfigLocation>({
    message: 'Where should vendoring configuration live?',
    options,
    initialValue: 'inrepo.json',
  });

  if (isCancel(choice)) {
    cancel('First-time setup cancelled.');
    throw new InrepoSetupCancelledError();
  }

  if (choice === 'inrepo.json') {
    await writeInrepoJsonStub(cwd);
    const added = await appendGitignoreLines(cwd, { interactive: true });
    outro('Created inrepo.json with an empty packages list.');
    logGitignoreRecommendation(added);
  } else {
    await writePackageJsonInrepoStub(cwd);
    const added = await appendGitignoreLines(cwd, { interactive: true });
    outro('Added "inrepo" to package.json.');
    logGitignoreRecommendation(added);
  }
}
