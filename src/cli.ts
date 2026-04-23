#!/usr/bin/env node
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canPromptInteractively,
  ensureInrepoInitialized,
  InrepoSetupCancelledError,
  isInrepoInitialized,
} from './config/ensure-inrepo-initialized.js';
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

// Route Clack output that represents diagnostics to stderr so it composes
// cleanly with shell pipelines and CI log capture (and matches existing
// e2e expectations like `r.stderr` matching warnings/errors).
const ERR = { output: process.stderr } as const;

function printHelp(): void {
  console.log(`inrepo — vendor git dependencies into inrepo_modules/

Usage:
  inrepo                                       (first-time init, then prints help)
  inrepo init
  inrepo sync
  inrepo verify
  inrepo add [-D|--dev] <name> [--git <url>] [--ref <ref>] [--no-save]

Commands:
  init     Create an empty inrepo config (inrepo.json or package.json "inrepo"); no-op if already initialized.
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
  const dest = moduleDestPath(cwd, pkg.name);
  const ref = pkg.ref?.trim() || undefined;

  // Pre-checkout warning needs to be on stderr (e2e contract). We emit it
  // before the spinner starts so it doesn't get tangled in spinner re-renders.
  if (existsSync(dest)) {
    log.warn(`Warning: replacing existing checkout: ${dest}`, ERR);
  }

  const s = spinner();
  s.start(`Vendoring "${pkg.name}"`);

  try {
    let gitUrl: string;
    if (pkg.git?.trim()) {
      gitUrl = pkg.git.trim();
    } else {
      s.message(`Resolving "${pkg.name}" from npm registry`);
      gitUrl = await resolveGitUrlFromNpm(pkg.name);
    }

    s.message(`Cleaning ${dest}`);
    await removeDestIfExists(dest);

    s.message(`Cloning ${gitUrl}${ref ? ` @ ${ref}` : ''}`);
    const { commit } = await clonePackage({ dest, gitUrl, ref });

    const keepList = mergedVendorKeeps(globalKeep, pkg);
    if (keepList.length > 0) {
      s.message(`Applying keep filter (${keepList.length} entr${keepList.length === 1 ? 'y' : 'ies'})`);
      await applyVendorKeep(dest, keepList);
    }

    const excludeList = mergedVendorExcludes(globalExclude, pkg);
    if (excludeList.length > 0) {
      s.message(`Applying excludes (${excludeList.length} entr${excludeList.length === 1 ? 'y' : 'ies'})`);
      await applyVendorExcludes(dest, excludeList);
    }

    s.message('Finalizing vendor checkout');
    await finalizeVendorCheckout(dest, { commit, gitUrl });

    s.message('Updating lockfile');
    await upsertLockModule(cwd, pkg.name, {
      source: pkg.name,
      gitUrl,
      commit,
      ref: ref ?? null,
      updatedAt: new Date().toISOString(),
    });

    s.message('Updating package.json');
    await upsertRootPackageJsonDependency(cwd, pkg.name, pkg.dev === true);

    // Final stop message preserves the e2e contract: `Synced "<name>" @ <sha7>` on stdout.
    s.stop(`Synced "${pkg.name}" @ ${commit.slice(0, 7)} → ${dest}`);
  } catch (e) {
    // Keep the spinner failure terse; the full error is printed by the
    // top-level catch in main() so we don't duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw e;
  }
}

async function cmdInit(cwd: string): Promise<void> {
  if (isInrepoInitialized(cwd)) {
    log.info('inrepo is already initialized in this project.');
    return;
  }
  await ensureInrepoInitialized(cwd);
  // ensureInrepoInitialized already prints intro/outro on success.
  log.message(
    'Next: run `inrepo add <name>` to vendor a package, or edit the config and run `inrepo sync`.',
  );
}

/**
 * When `suppressBanners` is set we are running inside an outer Clack frame
 * (e.g. `cmdInteractive`'s session intro/outro) and must not open a competing
 * frame of our own. Spinners, `log.*`, and error reporting still render — only
 * `intro` / `outro` / final `cancel` banners are suppressed.
 */
type DispatchOpts = { suppressBanners?: boolean };

async function cmdSync(cwd: string, opts: DispatchOpts = {}): Promise<void> {
  await ensureInrepoInitialized(cwd);
  const { packages, exclude: globalExclude, keep: globalKeep } = await loadConfig(cwd);
  if (packages.length === 0) {
    throw new Error('Config has an empty "packages" array. Add at least one package.');
  }

  if (!opts.suppressBanners) intro(`inrepo sync — ${packages.length} package(s)`);
  for (const pkg of packages) {
    await materializePackage(cwd, pkg, globalExclude, globalKeep);
  }
  if (!opts.suppressBanners) outro(`Done. ${packages.length} package(s) synced.`);
}

/**
 * Returns `true` when every lockfile entry matches its checkout, `false`
 * otherwise. Also sets `process.exitCode = 1` on failure so the standalone
 * `inrepo verify` invocation surfaces the correct shell exit code via
 * `main()`. Callers in interactive flows should branch on the return value
 * rather than reading `process.exitCode`, which is a global side-effect.
 */
async function cmdVerify(cwd: string, opts: DispatchOpts = {}): Promise<boolean> {
  if (!opts.suppressBanners) intro('inrepo verify');
  const s = spinner();
  s.start('Checking lockfile entries');
  let result;
  try {
    result = await verifyLock(cwd);
  } catch (e) {
    s.error('Verification failed');
    throw e;
  }

  if (!result.ok) {
    s.error('Verification failed');
    for (const line of result.errors) {
      log.error(line, ERR);
    }
    if (!opts.suppressBanners) {
      cancel('inrepo verify: lockfile and checkouts disagree.');
    }
    process.exitCode = 1;
    return false;
  }

  // Final stop message preserves the e2e contract: `inrepo verify: all lockfile entries match checkouts` on stdout.
  s.stop('inrepo verify: all lockfile entries match checkouts.');
  if (!opts.suppressBanners) outro('All vendored modules match the lockfile.');
  return true;
}

async function performAdd(cwd: string, args: AddArgs, opts: DispatchOpts = {}): Promise<void> {
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

  if (!opts.suppressBanners) intro(`inrepo add — ${args.name}${args.dev ? ' (dev)' : ''}`);

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

  if (!opts.suppressBanners) {
    outro(
      args.save
        ? `Recorded "${args.name}" in inrepo config.`
        : `Vendored "${args.name}" (not saved to config).`,
    );
  }
}

async function cmdAdd(cwd: string, argv: string[]): Promise<void> {
  await performAdd(cwd, parseAddArgs(argv));
}

/**
 * Bare-invocation menu: when the user runs `inrepo` with no arguments in an
 * interactive terminal and the project is already initialized, present a Clack
 * `select` of common actions and dispatch into the matching command.
 */
async function cmdInteractive(cwd: string): Promise<void> {
  let packagesCount: number | null = null;
  try {
    const cfg = await loadConfig(cwd);
    packagesCount = cfg.packages.length;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
  }

  intro('inrepo');

  type Action = 'sync' | 'add' | 'verify' | 'exit';
  // The default action is always `add`. Sync is destructive enough that it
  // should be a deliberate choice, never something a stray Enter triggers.
  const action = await select<Action>({
    message: 'What would you like to do?',
    initialValue: 'add',
    options: [
      {
        value: 'add',
        label: 'Add a package',
        hint: 'vendor a new git dependency',
      },
      {
        value: 'sync',
        label: `Sync packages${packagesCount != null ? ` (${packagesCount})` : ''}`,
        hint: 'clone/refresh all configured packages',
      },
      {
        value: 'verify',
        label: 'Verify lockfile',
        hint: 'check vendored dirs match the lockfile',
      },
      { value: 'exit', label: 'Exit' },
    ],
  });

  if (isCancel(action) || action === 'exit') {
    cancel('Goodbye.');
    return;
  }

  // The dispatched commands run inside this same Clack frame: pass
  // `suppressBanners` so they don't open competing intros/outros, and let
  // `cmdInteractive` close the session with a single contextual banner.
  //
  // The try/catch guarantees `intro('inrepo')` is always paired with a closing
  // `cancel(...)` even when a dispatched command throws — otherwise the frame
  // dangles on stdout while main() prints the error on stderr.
  try {
    if (action === 'sync') {
      await cmdSync(cwd, { suppressBanners: true });
      outro('Sync complete.');
    } else if (action === 'verify') {
      const ok = await cmdVerify(cwd, { suppressBanners: true });
      if (ok) {
        outro('All vendored modules match the lockfile.');
      } else {
        cancel('inrepo verify: lockfile and checkouts disagree.');
      }
    } else {
      const args = await promptAddArgs({ suppressBanners: true });
      if (args == null) {
        cancel('Add cancelled.');
        return;
      }
      await performAdd(cwd, args, { suppressBanners: true });
      outro(`Recorded "${args.name}" in inrepo config.`);
    }
  } catch (e) {
    const summary = e instanceof Error ? e.message.split('\n')[0] : String(e);
    cancel(`inrepo ${action} failed: ${summary}`);
    throw e;
  }
}

/**
 * Drive the four `add` inputs through Clack prompts. Returns null if the user
 * cancels at any point. When `suppressBanners` is true we are running inside
 * an outer frame and must neither open our own intro/outro nor emit a closing
 * `cancel` banner on cancellation — the caller handles framing.
 */
async function promptAddArgs(opts: DispatchOpts = {}): Promise<AddArgs | null> {
  if (!opts.suppressBanners) intro('inrepo add');

  const onCancel = (): null => {
    if (!opts.suppressBanners) cancel('Cancelled.');
    return null;
  };

  const name = await text({
    message: 'Package name',
    placeholder: 'e.g. lodash or @scope/pkg',
    validate: (v) => (v == null || v.trim() === '' ? 'Package name is required' : undefined),
  });
  if (isCancel(name)) return onCancel();

  const git = await text({
    message: 'Git URL (optional)',
    placeholder: 'leave blank to resolve from npm registry',
  });
  if (isCancel(git)) return onCancel();

  const ref = await text({
    message: 'Ref (branch / tag / SHA, optional)',
    placeholder: 'leave blank for default branch',
  });
  if (isCancel(ref)) return onCancel();

  const dev = await confirm({
    message: 'Save under devDependencies?',
    initialValue: false,
  });
  if (isCancel(dev)) return onCancel();

  if (!opts.suppressBanners) outro('Starting vendor checkout');

  const trimmedGit = typeof git === 'string' ? git.trim() : '';
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  return {
    name: (name as string).trim(),
    git: trimmedGit === '' ? undefined : trimmedGit,
    ref: trimmedRef === '' ? undefined : trimmedRef,
    dev: dev === true,
    save: true,
  };
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const [, , cmd, ...rest] = process.argv;

  if (cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }

  try {
    if (!cmd) {
      // Bare `inrepo` invocation:
      //   - interactive TTY: first-time init wizard if needed, otherwise an
      //     action picker (sync / add / verify / exit).
      //   - non-interactive: print help. Exit 1 if uninitialized so CI/scripts
      //     get a clear pointer that something needs doing.
      if (canPromptInteractively()) {
        if (isInrepoInitialized(cwd)) {
          await cmdInteractive(cwd);
        } else {
          await cmdInit(cwd);
        }
        return;
      }
      printHelp();
      if (!isInrepoInitialized(cwd)) process.exitCode = 1;
      return;
    } else if (cmd === 'init') {
      if (rest.length) throw new Error('init does not take arguments');
      await cmdInit(cwd);
    } else if (cmd === 'sync') {
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
    if (e instanceof InrepoSetupCancelledError) {
      // Setup already printed its own cancel banner; exit silently.
      return;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    // log.error pipes to stderr to preserve e2e expectations.
    log.error(err.message, ERR);
    process.exitCode = 1;
  }
}

await main();
