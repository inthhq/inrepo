#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureInrepoInitialized } from './config/ensure-inrepo-initialized.js';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from './config/load-config.js';
import { resolveGitUrlFromNpm } from './registry/resolve-git-url-from-npm.js';
import { applyVendorExcludes } from './git/apply-vendor-excludes.js';
import { applyVendorKeep } from './git/apply-vendor-keep.js';
import { clonePackage } from './git/clone-package.js';
import { finalizeVendorCheckout } from './git/finalize-vendor-checkout.js';
import { removeDestIfExists } from './git/remove-dest-if-exists.js';
import { upsertLockModule } from './lockfile/upsert-lock-module.js';
import { verifyLock } from './verify/verify-lock.js';
import { upsertInrepoJson, type InrepoJsonEntry } from './inrepo-json/upsert-inrepo-json.js';
import { upsertPackageJsonInrepo } from './inrepo-json/upsert-package-json-inrepo.js';
import { inrepoConfigPath } from './paths/inrepo-config-path.js';
import { moduleDestPath } from './paths/module-dest-path.js';
import { upsertRootPackageJsonDependency } from './package-json/upsert-vendored-package-ref.js';

function printHelp(): void {
  console.log(`inrepo — vendor git dependencies into inrepo_modules/

Usage:
  inrepo sync
  inrepo verify
  inrepo add [-D|--dev] <name> [--git <url>] [--ref <ref>] [--no-save]

Commands:
  sync     Read inrepo.json (or package.json "inrepo"), clone/update packages, and set package.json dependencies (or devDependencies when "dev": true) to file:inrepo_modules/... entries.
  verify   Check vendored dirs match inrepo.lock.json (git checkout, or .inrepo-vendor.json after sync strips .git).
  add      Clone a single package by npm name (or --git URL) into inrepo_modules (updates package.json when package.json exists).

Options (add):
  -D, --dev     Wire package.json#devDependencies instead of #dependencies
  --git <url>   Git clone URL (optional if npm registry has a GitHub repository field)
  --ref <ref>   Branch, tag, or commit SHA to pin
  --no-save     Do not upsert config and skip first-time setup (by default, add records the entry in inrepo.json — or package.json "inrepo" — after a successful checkout)

Config:
  On the first sync or add in a project without inrepo.json or package.json "inrepo", you are prompted where config should live (or set INREPO_CONFIG=inrepo.json|package.json, or INREPO_NONINTERACTIVE=1 with one of those files already present).
  Prefer inrepo.json at the project root; otherwise package.json field "inrepo".
  Shape: { "packages": [ { "name", "git?", "ref?", "dev?", "exclude?", "keep?" } ], "exclude?", "keep?" } or a bare JSON array of package entries (no root "exclude"/"keep" on bare arrays).
  Optional "keep": non-empty list of relative path prefixes — only those trees (and listed root files) remain; runs before "exclude".
  Each exclude entry is either a relative path (e.g. ".agents") or a slash-style regex "/pattern/flags" matched against paths under the module (forward slashes, e.g. /^(?!docs\\/|packages\\/).*/).
`);
}

type AddArgs = {
  name: string;
  git?: string;
  ref?: string;
  save: boolean;
  dev: boolean;
};

function parseAddArgs(argv: string[]): AddArgs {
  let save = true;
  let dev = false;
  let git: string | undefined;
  let ref: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-save') {
      save = false;
    } else if (a === '-D' || a === '--dev') {
      dev = true;
    } else if (a === '--git') {
      const raw = argv[++i];
      const v = raw == null ? null : raw.trim();
      if (v == null || v === '' || v.startsWith('-')) throw new Error('--git requires a URL');
      git = v;
    } else if (a === '--ref') {
      const raw = argv[++i];
      const v = raw == null ? null : raw.trim();
      if (v == null || v === '' || v.startsWith('-')) throw new Error('--ref requires a value');
      ref = v;
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) throw new Error('add requires a package <name>');
  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(' ')}`);
  }
  return { name: positional[0], save, git, ref, dev };
}

function mergedVendorExcludes(
  globalExclude: string[],
  pkg: { exclude?: string[] },
): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
}

function mergedVendorKeeps(globalKeep: string[], pkg: { keep?: string[] }): string[] {
  return [...new Set([...globalKeep, ...(pkg.keep ?? [])])];
}

async function materializePackage(
  cwd: string,
  pkg: {
    name: string;
    git?: string;
    ref?: string;
    dev?: boolean;
    exclude?: string[];
    keep?: string[];
  },
  globalExclude: string[],
  globalKeep: string[],
): Promise<void> {
  const gitUrl = pkg.git?.trim()
    ? pkg.git.trim()
    : await resolveGitUrlFromNpm(pkg.name);
  const dest = moduleDestPath(cwd, pkg.name);
  const ref = pkg.ref?.trim() || undefined;

  if (existsSync(dest)) {
    console.warn(`Warning: replacing existing checkout: ${dest}`);
  }
  await removeDestIfExists(dest);

  const { commit } = await clonePackage({ dest, gitUrl, ref });

  const keepList = mergedVendorKeeps(globalKeep, pkg);
  if (keepList.length > 0) {
    await applyVendorKeep(dest, keepList);
  }
  await applyVendorExcludes(dest, mergedVendorExcludes(globalExclude, pkg));

  await finalizeVendorCheckout(dest, { commit, gitUrl });

  await upsertLockModule(cwd, pkg.name, {
    source: pkg.name,
    gitUrl,
    commit,
    ref: ref ?? null,
    updatedAt: new Date().toISOString(),
  });

  await upsertRootPackageJsonDependency(cwd, pkg.name, pkg.dev === true);

  console.log(`Synced "${pkg.name}" @ ${commit.slice(0, 7)} → ${dest}`);
}

async function cmdSync(cwd: string): Promise<void> {
  await ensureInrepoInitialized(cwd);
  const { packages, exclude: globalExclude, keep: globalKeep } = await loadConfig(cwd);
  if (packages.length === 0) {
    throw new Error('Config has an empty "packages" array. Add at least one package.');
  }
  for (const pkg of packages) {
    await materializePackage(cwd, pkg, globalExclude, globalKeep);
  }
  console.log(`Done. ${packages.length} package(s) synced.`);
}

async function cmdVerify(cwd: string): Promise<void> {
  const result = await verifyLock(cwd);
  if (!result.ok) {
    for (const line of result.errors) console.error(line);
    process.exitCode = 1;
    return;
  }
  console.log('inrepo verify: all lockfile entries match checkouts.');
}

async function cmdAdd(cwd: string, argv: string[]): Promise<void> {
  const args = parseAddArgs(argv);
  // First-time setup is only required when we're going to persist the entry.
  // `--no-save` is an explicit "one-off vendor" — it has no business creating
  // an empty inrepo.json or rejecting the run for lack of a TTY.
  if (args.save) {
    await ensureInrepoInitialized(cwd);
  }

  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  let pkgExclude: string[] | undefined;
  let pkgKeep: string[] | undefined;
  try {
    const cfg = await loadConfig(cwd);
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
    const entry = cfg.packages.find((p) => p.name === args.name);
    pkgExclude = entry?.exclude;
    pkgKeep = entry?.keep;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  await materializePackage(
    cwd,
    {
      name: args.name,
      git: args.git,
      ref: args.ref,
      dev: args.dev,
      exclude: pkgExclude,
      keep: pkgKeep,
    },
    globalExclude,
    globalKeep,
  );

  if (args.save) {
    const entry: InrepoJsonEntry = {
      name: args.name,
      dev: args.dev,
    };
    if (args.git !== undefined && args.git !== '') {
      entry.git = args.git;
    }
    if (args.ref !== undefined && args.ref !== '') {
      entry.ref = args.ref;
    }
    if (existsSync(inrepoConfigPath(cwd))) {
      await upsertInrepoJson(cwd, entry);
    } else {
      await upsertPackageJsonInrepo(cwd, entry);
    }
  }
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    if (!cmd) process.exitCode = 1;
    return;
  }

  try {
    if (cmd === 'sync') {
      if (rest.length) throw new Error('sync does not take arguments');
      await cmdSync(cwd);
    } else if (cmd === 'verify') {
      if (rest.length) throw new Error('verify does not take arguments');
      await cmdVerify(cwd);
    } else if (cmd === 'add') {
      await cmdAdd(cwd, rest);
    } else {
      throw new Error(`Unknown command: ${cmd}\nRun: inrepo --help`);
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(err.message);
    process.exitCode = 1;
  }
}

await main();
