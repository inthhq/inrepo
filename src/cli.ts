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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
import { readLockfile } from './lockfile/read-lockfile.js';
import { upsertLockModule } from './lockfile/upsert-lock-module.js';
import { assembleModuleTree } from './overlay/assemble-module.js';
import { buildOverlay } from './overlay/build-overlay.js';
import { ensurePristine } from './overlay/cache.js';
import { compareTrees } from './overlay/compare-trees.js';
import { readModuleState, writeModuleState } from './overlay/module-state.js';
import { backupDirPath, overlayDirPath } from './overlay/overlay-paths.js';
import { hashTree } from './overlay/tree-hash.js';
import { copyTree } from './overlay/tree-utils.js';
import { normalizeGithubHttpsUrl } from './registry/normalize-github-https-url.js';
import { verifyLock } from './verify/verify-lock.js';
import { upsertInrepoJson, type InrepoJsonEntry } from './inrepo-json/upsert-inrepo-json.js';
import { upsertPackageJsonInrepo } from './inrepo-json/upsert-package-json-inrepo.js';
import { inrepoConfigPath } from './paths/inrepo-config-path.js';
import { moduleDestPath } from './paths/module-dest-path.js';
import { upsertRootPackageJsonDependency } from './package-json/upsert-vendored-package-ref.js';
import type { LockModule } from './types/lock-module.js';

// Route Clack output that represents diagnostics to stderr so it composes
// cleanly with shell pipelines and CI log capture (and matches existing
// e2e expectations like `r.stderr` matching warnings/errors).
const ERR = { output: process.stderr } as const;

// Trailing whitespace is part of the artwork (each row is a fixed width); keep
// the lines verbatim and disable the editor's whitespace-trimming instinct by
// concatenating with explicit `\n` rather than a template literal.
const BANNER_LINES = [
  '░██                                                        ',
  '                                                           ',
  '░██░████████     ░██░████  ░███████  ░████████   ░███████  ',
  '░██░██    ░██    ░███     ░██    ░██ ░██    ░██ ░██    ░██ ',
  '░██░██    ░██    ░██      ░█████████ ░██    ░██ ░██    ░██ ',
  '░██░██    ░██    ░██      ░██        ░███   ░██ ░██    ░██ ',
  '░██░██    ░██    ░██       ░███████  ░██░█████   ░███████  ',
  '                                     ░██                   ',
  '                                     ░██                   ',
];

// Track whether we've already shown the banner in this process so nested
// dispatch (e.g. `cmdInteractive` → `cmdSync`) doesn't print it twice even if
// callers forget to pass `suppressBanners`.
let bannerShown = false;

function printBanner(): void {
  if (bannerShown) return;
  bannerShown = true;
  console.log(BANNER_LINES.join('\n'));
}

function printHelp(): void {
  console.log(`inrepo — vendor git dependencies into inrepo_modules/

Usage:
  inrepo                                       (first-time init, then prints help)
  inrepo init
  inrepo sync [--force]
  inrepo patch [<name>]
  inrepo verify
  inrepo add [-D|--dev] <name> [--git <url>] [--ref <ref>] [--no-save]

Commands:
  init     Create an empty inrepo config (inrepo.json or package.json "inrepo"); no-op if already initialized.
  sync     Build inrepo_modules from the pinned upstream lockfile state plus any committed files in inrepo_patches/.
  patch    Capture edits from inrepo_modules back into committed overlay files under inrepo_patches/.
  verify   Check vendored dirs match the lockfile plus any committed overlays.
  add      Vendor or refresh a single package pin, then rebuild its generated checkout in inrepo_modules.

Options (add):
  -D, --dev     Wire package.json#devDependencies instead of #dependencies
  --git <url>   Git clone URL (optional if npm registry has a GitHub repository field)
  --ref <ref>   Branch, tag, or commit SHA to pin
  --no-save     Do not upsert config and skip first-time setup (by default, add records the entry in inrepo.json — or package.json "inrepo" — after a successful checkout)

Options (sync):
  --force       Discard uncaptured edits in inrepo_modules after saving a backup under .inrepo/backups/

Config:
  On the first sync or add in a project without inrepo.json or package.json "inrepo", you are prompted where config should live (or set INREPO_CONFIG=inrepo.json|package.json, or INREPO_NONINTERACTIVE=1 with one of those files already present).
  Prefer inrepo.json at the project root; otherwise package.json field "inrepo".
  Shape: { "packages": [ { "name", "git?", "ref?", "dev?", "exclude?", "keep?" } ], "exclude?", "keep?" } or a bare JSON array of package entries (no root "exclude"/"keep" on bare arrays).
  Optional "keep": non-empty list of relative path prefixes — only those trees (and listed root files) remain; runs before "exclude".
  Each exclude entry is either a relative path (e.g. ".agents") or a slash-style regex "/pattern/flags" matched against paths under the module (forward slashes, e.g. /^(?!docs\\/|packages\\/).*/).

Workflow:
  Think of inrepo_modules/ as generated output and inrepo_patches/ as your team's fork layer.
  Keep inrepo_modules/ and .inrepo/ in .gitignore; init recommends or adds those entries for you.
  Typical loop: inrepo add|sync -> edit files in inrepo_modules/<name>/ -> inrepo patch <name> -> git commit -> teammates pull -> inrepo sync.
`);
}

type AddArgs = {
  name: string;
  git?: string;
  ref?: string;
  save: boolean;
  dev: boolean;
};

type SyncArgs = {
  force: boolean;
};

type PatchArgs = {
  name?: string;
};

type PackageSpec = {
  name: string;
  git?: string;
  ref?: string;
  dev?: boolean;
  exclude?: string[];
  keep?: string[];
};

type MaterializeOptions = {
  mode: 'sync' | 'add';
  force: boolean;
  lockEntry?: LockModule;
};

const EMPTY_TREE_HASH = createHash('sha256').update('', 'utf8').digest('hex');

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

function parseSyncArgs(argv: string[]): SyncArgs {
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      throw new Error('sync does not take arguments');
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { force };
}

function parsePatchArgs(argv: string[]): PatchArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(' ')}`);
  }
  return { name: positional[0] };
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

function normalizedRef(ref?: string | null): string | undefined {
  const trimmed = ref?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGitUrlForComparison(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;

  const trimmed = raw.trim().replace(/^git\+/i, '');
  const github = normalizeGithubHttpsUrl(trimmed);
  if (github) return github;

  const scpLike = /^(?<user>[^@]+@)?(?<host>[^:/]+):(?<path>.+)$/.exec(trimmed);
  if (scpLike?.groups) {
    const user = scpLike.groups.user ?? '';
    const host = scpLike.groups.host.toLowerCase();
    const path = scpLike.groups.path.replace(/\.git$/i, '');
    return `${user}${host}:${path}`;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\.git$/i, '');
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return trimmed.replace(/\.git$/i, '');
  }
}

async function resolvePackageGitUrl(
  pkg: PackageSpec,
  fallbackGitUrl: string | undefined,
  s: ReturnType<typeof spinner>,
): Promise<string> {
  if (pkg.git?.trim()) return pkg.git.trim();
  if (fallbackGitUrl) return fallbackGitUrl;
  s.message(`Resolving "${pkg.name}" from npm registry`);
  return resolveGitUrlFromNpm(pkg.name);
}

async function makeSiblingStage(dest: string, prefix: string): Promise<string> {
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

function backupTimestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function snapshotModuleBackup(cwd: string, name: string, dest: string): Promise<string> {
  const backup = backupDirPath(cwd, name, backupTimestamp());
  await copyTree(dest, backup, { treatMissingAsEmpty: true });
  return backup;
}

function uncapturedEditsMessage(name: string): string {
  return `uncaptured edits in "inrepo_modules/${name}"; run "inrepo patch ${name}" to capture, or "inrepo sync --force" to discard`;
}

function overlayConflictMessage(name: string): string {
  return `both "inrepo_patches/${name}" and "inrepo_modules/${name}" changed since the last sync; run "inrepo sync" to rebuild or reconcile them manually`;
}

function hasTreeDrift(result: Awaited<ReturnType<typeof compareTrees>>): boolean {
  return (
    result.added.length > 0 ||
    result.modified.length > 0 ||
    result.removed.length > 0 ||
    result.typeChanges.length > 0
  );
}

async function materializePackage(
  cwd: string,
  pkg: PackageSpec,
  globalExclude: string[],
  globalKeep: string[],
  opts: MaterializeOptions,
): Promise<void> {
  const dest = moduleDestPath(cwd, pkg.name);
  const ref = normalizedRef(pkg.ref);

  // Pre-checkout warning needs to be on stderr (e2e contract). We emit it
  // before the spinner starts so it doesn't get tangled in spinner re-renders.
  if (existsSync(dest)) {
    log.warn(`Warning: replacing existing checkout: ${dest}`, ERR);
  }

  const s = spinner();
  s.start(`Vendoring "${pkg.name}"`);

  try {
    const keepList = mergedVendorKeeps(globalKeep, pkg);
    const excludeList = mergedVendorExcludes(globalExclude, pkg);
    let gitUrl = await resolvePackageGitUrl(pkg, opts.lockEntry?.gitUrl, s);
    const resolvedLockGitUrl = normalizeGitUrlForComparison(opts.lockEntry?.gitUrl);
    const usePinnedLock =
      opts.mode === 'sync' &&
      opts.lockEntry != null &&
      resolvedLockGitUrl === normalizeGitUrlForComparison(gitUrl) &&
      opts.lockEntry.ref === (ref ?? null);

    s.message(
      usePinnedLock
        ? `Preparing upstream cache @ ${opts.lockEntry?.commit.slice(0, 7)}`
        : `Preparing upstream cache${ref ? ` @ ${ref}` : ''}`,
    );
    const pristine = await ensurePristine({
      cwd,
      name: pkg.name,
      gitUrl,
      ref: ref ?? null,
      commit: usePinnedLock ? opts.lockEntry?.commit ?? null : null,
      keep: keepList,
      exclude: excludeList,
    });
    gitUrl = pristine.gitUrl;

    const overlayHash = await hashTree(overlayDirPath(cwd, pkg.name));
    const stage = await makeSiblingStage(dest, '.inrepo-next-');

    try {
      s.message('Assembling generated vendor tree');
      await assembleModuleTree({
        cwd,
        name: pkg.name,
        pristineRoot: pristine.dir,
        commit: pristine.commit,
        gitUrl,
        targetRoot: stage,
      });

      const stageHash = await hashTree(stage);
      const state = await readModuleState(cwd, pkg.name);
      const currentModuleHash = existsSync(dest) ? await hashTree(dest) : EMPTY_TREE_HASH;

      if (existsSync(dest)) {
        if (state) {
          const overlayChanged = overlayHash !== state.overlayHash;
          const moduleChanged = currentModuleHash !== state.moduleHash;
          if (!opts.force && overlayChanged && moduleChanged) {
            throw new Error(overlayConflictMessage(pkg.name));
          }
          if (!opts.force && !overlayChanged && moduleChanged) {
            throw new Error(uncapturedEditsMessage(pkg.name));
          }
        } else {
          const drift = await compareTrees(stage, dest);
          const hasDrift =
            drift.added.length > 0 ||
            drift.modified.length > 0 ||
            drift.removed.length > 0 ||
            drift.typeChanges.length > 0;
          if (!opts.force && hasDrift) {
            throw new Error(uncapturedEditsMessage(pkg.name));
          }
        }

        if (opts.force && currentModuleHash !== stageHash) {
          s.message('Saving working tree backup');
          const backup = await snapshotModuleBackup(cwd, pkg.name, dest);
          log.warn(`Saved checkout backup: ${backup}`, ERR);
        }

        s.message(`Replacing ${dest}`);
        await rm(dest, { recursive: true, force: true });
      }

      await rename(stage, dest);
      await writeModuleState(cwd, pkg.name, {
        overlayHash,
        moduleHash: stageHash,
      });
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }

    if (
      opts.mode === 'add' ||
      !opts.lockEntry ||
      opts.lockEntry.commit !== pristine.commit ||
      opts.lockEntry.gitUrl !== gitUrl ||
      opts.lockEntry.ref !== (ref ?? null)
    ) {
      s.message('Updating lockfile');
      await upsertLockModule(cwd, pkg.name, {
        source: pkg.name,
        gitUrl,
        commit: pristine.commit,
        ref: ref ?? null,
        updatedAt: new Date().toISOString(),
      });
    }

    s.message('Updating package.json');
    await upsertRootPackageJsonDependency(cwd, pkg.name, pkg.dev === true);

    // Final stop message preserves the e2e contract: `Synced "<name>" @ <sha7>` on stdout.
    s.stop(`Synced "${pkg.name}" @ ${pristine.commit.slice(0, 7)} → ${dest}`);
  } catch (e) {
    // Keep the spinner failure terse; the full error is printed by the
    // top-level catch in main() so we don't duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw e;
  }
}

async function cmdInit(cwd: string): Promise<void> {
  printBanner();
  if (isInrepoInitialized(cwd)) {
    log.info('inrepo is already initialized in this project.');
    return;
  }
  await ensureInrepoInitialized(cwd);
  // ensureInrepoInitialized already prints intro/outro on success.
  log.message(
    'Next: run `inrepo add <name>` to pin a package, or edit the config and run `inrepo sync`; later use `inrepo patch <name>` to capture shared changes.',
  );
}

/**
 * When `suppressBanners` is set we are running inside an outer Clack frame
 * (e.g. `cmdInteractive`'s session intro/outro) and must not open a competing
 * frame of our own. Spinners, `log.*`, and error reporting still render — only
 * `intro` / `outro` / final `cancel` banners are suppressed.
 */
type DispatchOpts = { suppressBanners?: boolean };

async function cmdSync(cwd: string, argv: string[] = [], opts: DispatchOpts = {}): Promise<void> {
  const args = parseSyncArgs(argv);
  if (!opts.suppressBanners) printBanner();
  await ensureInrepoInitialized(cwd);
  const { packages, exclude: globalExclude, keep: globalKeep } = await loadConfig(cwd);
  const { modules } = await readLockfile(cwd);
  if (packages.length === 0) {
    throw new Error('Config has an empty "packages" array. Add at least one package.');
  }

  if (!opts.suppressBanners) intro(`inrepo sync — ${packages.length} package(s)`);
  for (const pkg of packages) {
    await materializePackage(cwd, pkg, globalExclude, globalKeep, {
      mode: 'sync',
      force: args.force,
      lockEntry: modules[pkg.name],
    });
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
  if (!opts.suppressBanners) {
    printBanner();
    intro('inrepo verify');
  }
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

async function cmdPatch(cwd: string, argv: string[], opts: DispatchOpts = {}): Promise<void> {
  const args = parsePatchArgs(argv);
  if (!opts.suppressBanners) printBanner();

  let configPackages: PackageSpec[] = [];
  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  try {
    const cfg = await loadConfig(cwd);
    configPackages = cfg.packages;
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  const { modules } = await readLockfile(cwd);
  const configByName = new Map(configPackages.map((pkg) => [pkg.name, pkg] as const));

  const packageList: PackageSpec[] = args.name
    ? [
        configByName.get(args.name) ?? {
          name: args.name,
          git: modules[args.name]?.gitUrl,
          ref: modules[args.name]?.ref ?? undefined,
        },
      ]
    : configPackages.length > 0
      ? configPackages
      : Object.keys(modules)
          .sort()
          .map((name) => ({
            name,
            git: modules[name]?.gitUrl,
            ref: modules[name]?.ref ?? undefined,
          }));

  if (packageList.length === 0) {
    throw new Error('Nothing to patch: no configured or locked packages.');
  }
  if (args.name && !configByName.has(args.name) && !modules[args.name]) {
    throw new Error(`No configured or locked package named "${args.name}".`);
  }

  if (!opts.suppressBanners) intro(`inrepo patch — ${packageList.length} package(s)`);

  for (const pkg of packageList) {
    const lockEntry = modules[pkg.name];
    if (!lockEntry) {
      throw new Error(
        `Cannot patch "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`,
      );
    }

    const dest = moduleDestPath(cwd, pkg.name);
    const s = spinner();
    s.start(`Capturing "${pkg.name}"`);

    try {
      if (!existsSync(dest)) {
        throw new Error(`Missing directory for "${pkg.name}": ${dest}`);
      }

      const keepList = mergedVendorKeeps(globalKeep, pkg);
      const excludeList = mergedVendorExcludes(globalExclude, pkg);

      s.message(`Preparing upstream cache @ ${lockEntry.commit.slice(0, 7)}`);
      const pristine = await ensurePristine({
        cwd,
        name: pkg.name,
        gitUrl: lockEntry.gitUrl,
        ref: lockEntry.ref,
        commit: lockEntry.commit,
        keep: keepList,
        exclude: excludeList,
      });

      const state = await readModuleState(cwd, pkg.name);
      const overlayHashBefore = await hashTree(overlayDirPath(cwd, pkg.name));
      const moduleHash = await hashTree(dest);

      if (state) {
        const overlayChanged = overlayHashBefore !== state.overlayHash;
        const moduleChanged = moduleHash !== state.moduleHash;
        if (overlayChanged && moduleChanged) {
          throw new Error(overlayConflictMessage(pkg.name));
        }
        if (overlayChanged) {
          throw new Error(
            `overlay for "${pkg.name}" changed since the last sync; run "inrepo sync" before patching`,
          );
        }
      } else if (overlayHashBefore !== EMPTY_TREE_HASH) {
        const stage = await makeSiblingStage(dest, '.inrepo-patch-check-');
        try {
          await assembleModuleTree({
            cwd,
            name: pkg.name,
            pristineRoot: pristine.dir,
            commit: pristine.commit,
            gitUrl: lockEntry.gitUrl,
            targetRoot: stage,
          });
          const drift = await compareTrees(stage, dest);
          if (hasTreeDrift(drift)) {
            throw new Error(
              `overlay for "${pkg.name}" exists but this checkout has no sync state; run "inrepo sync" before patching`,
            );
          }
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }

      s.message('Writing committed overlay');
      await buildOverlay({
        pristineRoot: pristine.dir,
        moduleRoot: dest,
        overlayRoot: overlayDirPath(cwd, pkg.name),
      });
      const overlayHashAfter = await hashTree(overlayDirPath(cwd, pkg.name));
      await writeModuleState(cwd, pkg.name, {
        overlayHash: overlayHashAfter,
        moduleHash,
      });
      s.stop(`Patched "${pkg.name}" → ${overlayDirPath(cwd, pkg.name)}`);
    } catch (e) {
      s.error(`Failed to patch "${pkg.name}"`);
      throw e;
    }
  }

  if (!opts.suppressBanners) outro(`Done. ${packageList.length} package(s) patched.`);
}

async function performAdd(cwd: string, args: AddArgs, opts: DispatchOpts = {}): Promise<void> {
  if (!opts.suppressBanners) printBanner();
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
  let hasConfigEntry = false;
  const { modules } = await readLockfile(cwd);
  try {
    const cfg = await loadConfig(cwd);
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
    const entry = cfg.packages.find((p) => p.name === args.name);
    hasConfigEntry = entry != null;
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
    {
      mode: 'add',
      force:
        !hasConfigEntry &&
        !modules[args.name] &&
        existsSync(moduleDestPath(cwd, args.name)),
      lockEntry: modules[args.name],
    },
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

  printBanner();
  intro('inrepo');

  type Action = 'sync' | 'add' | 'verify' | 'patch' | 'exit';
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
      {
        value: 'patch',
        label: 'Patch packages',
        hint: 'capture edits into inrepo_patches',
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
      await cmdSync(cwd, [], { suppressBanners: true });
      outro('Sync complete.');
    } else if (action === 'verify') {
      const ok = await cmdVerify(cwd, { suppressBanners: true });
      if (ok) {
        outro('All vendored modules match the lockfile.');
      } else {
        cancel('inrepo verify: lockfile and checkouts disagree.');
      }
    } else if (action === 'patch') {
      await cmdPatch(cwd, [], { suppressBanners: true });
      outro('Patch capture complete.');
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
      await cmdSync(cwd, rest);
    } else if (cmd === 'patch') {
      await cmdPatch(cwd, rest);
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
