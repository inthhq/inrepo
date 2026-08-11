import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { isLoadConfigNotFoundError, loadConfig } from '../../config/load-config.js';
import { resolveRemoteCommit } from '../../git/resolve-remote-commit.js';
import { upsertInrepoJson, type InrepoJsonEntry } from '../../inrepo-json/upsert-inrepo-json.js';
import { upsertPackageJsonInrepo } from '../../inrepo-json/upsert-package-json-inrepo.js';
import { upsertLockModule } from '../../lockfile/upsert-lock-module.js';
import { ensurePristine } from '../../overlay/cache.js';
import { readModuleState } from '../../overlay/module-state.js';
import {
  overlayDirPath,
  seriesDirPath,
  updateDirPath,
  updateRepoPath,
} from '../../overlay/overlay-paths.js';
import { hashTree } from '../../overlay/tree-hash.js';
import { inrepoConfigPath } from '../../paths/inrepo-config-path.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import { listLegacyOverlayEntries } from '../../series/legacy-overlay.js';
import { readSeries } from '../../series/read-series.js';
import {
  continueSeriesRebase,
  startSeriesRebase,
  writeRebasedSeries,
  type RebasedPatch,
  type SeriesRebaseResult,
} from '../../series/rebase-series.js';
import { resolveSeriesAuthor } from '../../series/resolve-series-author.js';
import {
  clearUpdate,
  isUpdateInProgress,
  readUpdateState,
  writeUpdateState,
  type UpdateState,
} from '../../series/update-state.js';
import type { LockModule } from '../../types/lock-module.js';
import { parseUpdateArgs } from '../args.js';
import { selectPackages } from '../package-selection.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts, PackageSpec, UpdateArgs } from '../types.js';
import { intro, outro, spinner, warn } from '../ui.js';
import { materializePackage, mergedVendorExcludes, mergedVendorKeeps } from '../vendor.js';

type SeriesConflict = Extract<SeriesRebaseResult, { status: 'conflict' }>;

function short(commit: string): string {
  return commit.slice(0, 7);
}

function refLabel(ref: string | null): string {
  return ref ? ` (${ref})` : ' (default branch)';
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function inProgressMessage(cwd: string, name: string): string {
  return [
    `An update for "${name}" is already in progress in ${relative(cwd, updateDirPath(cwd, name))}.`,
    `Finish it with "inrepo update ${name} --continue" or discard it with "inrepo update ${name} --abort".`,
  ].join('\n');
}

/** Conflict report: what stopped, where to fix it, and how to carry on. */
function conflictMessage(cwd: string, name: string, result: SeriesConflict): string {
  const number = String(result.number).padStart(4, '0');
  return [
    `Rebasing "${name}" stopped on patch ${number} "${result.subject}".`,
    result.files.length > 0
      ? ['Conflicted files:', ...result.files.map((file) => `  ${file}`)].join('\n')
      : 'The patch could not be applied automatically.',
    `Resolve them in ${relative(cwd, updateRepoPath(cwd, name))}, then run:`,
    `  inrepo update ${name} --continue   finish the rebase and move the pin`,
    `  inrepo update ${name} --abort      discard the update and leave everything as it is`,
    'Nothing in inrepo_patches/, the config, the lockfile, or inrepo_modules/ has changed.',
  ].join('\n');
}

/**
 * Refuse to update on top of edits that are not in the series yet: the update
 * rebuilds `inrepo_modules/<name>`, which would discard them.
 */
async function assertModuleCaptured(cwd: string, name: string): Promise<void> {
  const dest = moduleDestPath(cwd, name);
  if (!existsSync(dest)) return;
  const state = await readModuleState(cwd, name);
  if (!state) return;
  if ((await hashTree(dest)) === state.moduleHash) return;
  throw new Error(
    `uncaptured edits in "inrepo_modules/${name}"; run "inrepo patch ${name} -m \"reason\"" to capture them or "inrepo sync --force" to discard them before updating`,
  );
}

/** Record a new `ref` in the inrepo config. False when the package is lockfile-only. */
async function persistConfigRef(cwd: string, name: string, ref: string): Promise<boolean> {
  let entry: PackageSpec | undefined;
  try {
    const cfg = await loadConfig(cwd);
    entry = cfg.packages.find((pkg) => pkg.name === name);
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    return false;
  }
  if (!entry) return false;

  // `dev` has to be restated: the upsert helpers treat an absent flag as a
  // request to clear it.
  const next: InrepoJsonEntry = { name, ref, dev: entry.dev === true };
  if (existsSync(inrepoConfigPath(cwd))) await upsertInrepoJson(cwd, next);
  else await upsertPackageJsonInrepo(cwd, next);
  return true;
}

type UpdateContext = {
  cwd: string;
  pkg: PackageSpec;
  lockEntry: LockModule;
  globalExclude: string[];
  globalKeep: string[];
};

async function loadUpdateContext(cwd: string, name: string): Promise<UpdateContext> {
  const { packages, modules, globalExclude, globalKeep } = await selectPackages(cwd, name, 'update');
  const pkg = packages[0];
  const lockEntry = modules[pkg.name];
  if (!lockEntry) {
    throw new Error(
      `Cannot update "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`,
    );
  }
  return { cwd, pkg, lockEntry, globalExclude, globalKeep };
}

/** Upstream checkout for one end of the update, filtered like every other command. */
function pristineFor(
  ctx: UpdateContext,
  opts: { ref: string | null; commit: string | null },
): Promise<{ dir: string; commit: string }> {
  return ensurePristine({
    cwd: ctx.cwd,
    name: ctx.pkg.name,
    gitUrl: ctx.lockEntry.gitUrl,
    ref: opts.ref,
    commit: opts.commit,
    keep: mergedVendorKeeps(ctx.globalKeep, ctx.pkg),
    exclude: mergedVendorExcludes(ctx.globalExclude, ctx.pkg),
  });
}

/**
 * Commit the outcome of a finished update: the rebased series, the new pin in
 * config and the lockfile, and a rebuilt `inrepo_modules/<name>`. Nothing here
 * runs until the rebase has completed, so a conflicted update never leaves half
 * of it behind.
 */
async function finalizeUpdate(
  ctx: UpdateContext,
  state: UpdateState,
  /** Rebased series to commit, or null when the series is unchanged. */
  patches: RebasedPatch[] | null,
): Promise<void> {
  const { cwd } = ctx;
  const name = state.name;
  await assertModuleCaptured(cwd, name);

  if (patches != null) {
    await writeRebasedSeries(seriesDirPath(cwd, name), patches);
  }

  if (state.persistRef && state.ref) {
    if (!(await persistConfigRef(cwd, name, state.ref))) {
      warn(`"${name}" is not in the inrepo config, so --ref was recorded in inrepo.lock.json only.`);
    }
  }

  const lockEntry: LockModule = {
    source: name,
    gitUrl: state.gitUrl,
    commit: state.newCommit,
    ref: state.ref,
    updatedAt: new Date().toISOString(),
  };
  await upsertLockModule(cwd, name, lockEntry);

  await materializePackage(
    cwd,
    { ...ctx.pkg, ref: state.ref ?? undefined },
    ctx.globalExclude,
    ctx.globalKeep,
    { mode: 'sync', force: false, lockEntry },
  );

  await clearUpdate(cwd, name);
}

function reportSuccess(state: UpdateState, patches: RebasedPatch[] | null): void {
  console.log(
    `Updated "${state.name}" ${short(state.oldCommit)} → ${short(state.newCommit)}${refLabel(state.ref)}`,
  );
  for (const patch of patches ?? []) {
    console.log(`  ${String(patch.number).padStart(4, '0')}  ${patch.subject || '(no subject)'}`);
  }
  console.log(`Review the result with: inrepo diff ${state.name}`);
}

type StartOutcome =
  | { kind: 'up-to-date'; commit: string; ref: string | null }
  | { kind: 'repinned'; state: UpdateState }
  | { kind: 'rebased'; state: UpdateState; patches: RebasedPatch[] }
  | { kind: 'conflict'; state: UpdateState; result: SeriesConflict };

/**
 * Resolve the new commit and, when the package has patches to carry, rebase
 * them onto it. Everything this touches is either read-only or confined to
 * `.inrepo/`.
 */
async function prepareUpdate(
  ctx: UpdateContext,
  args: UpdateArgs,
  s: ReturnType<typeof spinner>,
): Promise<StartOutcome> {
  const { cwd, lockEntry } = ctx;
  const name = ctx.pkg.name;
  const seriesDir = seriesDirPath(cwd, name);
  const patches = await readSeries(seriesDir);
  const targetRef = args.ref ?? ctx.pkg.ref ?? lockEntry.ref ?? null;

  s.message(`Resolving ${targetRef ? `"${targetRef}"` : 'the default branch'}`);
  const resolved = await resolveRemoteCommit(lockEntry.gitUrl, targetRef);
  if (resolved === lockEntry.commit && (lockEntry.ref ?? null) === targetRef) {
    return { kind: 'up-to-date', commit: resolved, ref: targetRef };
  }

  const base = {
    name,
    gitUrl: lockEntry.gitUrl,
    oldCommit: lockEntry.commit,
    ref: targetRef,
    persistRef: args.ref != null,
    startedAt: new Date().toISOString(),
  };

  // The checkout is authoritative about which commit the ref names; the
  // `ls-remote` probe above only decides whether there is work to do.
  const materializeNew = (): Promise<{ dir: string; commit: string }> =>
    pristineFor(ctx, { ref: targetRef, commit: null });

  if (patches.length === 0 || resolved === lockEntry.commit) {
    // Nothing to rebase: this is a re-pin plus a rebuild.
    s.message(`Fetching ${short(resolved)}`);
    const pristine = await materializeNew();
    return { kind: 'repinned', state: { ...base, newCommit: pristine.commit, newBase: '' } };
  }

  // The old upstream tree has to be captured before the cache is refreshed,
  // which is why the new checkout happens inside the rebase.
  const oldPristine = await pristineFor(ctx, { ref: lockEntry.ref, commit: lockEntry.commit });

  let newCommit = resolved;
  s.message(`Rebasing ${plural(patches.length, 'patch', 'patches')} onto ${short(resolved)}`);
  const started = await startSeriesRebase({
    repoRoot: updateRepoPath(cwd, name),
    seriesDir,
    oldRoot: oldPristine.dir,
    resolveNewRoot: async () => {
      const pristine = await materializeNew();
      newCommit = pristine.commit;
      return pristine.dir;
    },
    author: await resolveSeriesAuthor(cwd),
    onPatch: (patch) => s.message(`Replaying ${patch.fileName}`),
  });

  const state: UpdateState = { ...base, newCommit, newBase: started.newBase };
  return started.result.status === 'conflict'
    ? { kind: 'conflict', state, result: started.result }
    : { kind: 'rebased', state, patches: started.result.patches };
}

async function startUpdate(cwd: string, args: UpdateArgs, opts: DispatchOpts): Promise<void> {
  const ctx = await loadUpdateContext(cwd, args.name);
  const name = ctx.pkg.name;

  if (isUpdateInProgress(cwd, name)) throw new Error(inProgressMessage(cwd, name));

  const legacyEntries = await listLegacyOverlayEntries(overlayDirPath(cwd, name));
  if (legacyEntries.length > 0) {
    throw new Error(
      `"${name}" still uses a legacy whole-file overlay, which cannot be rebased onto a new commit. Run "inrepo migrate ${name}" first, then "inrepo update ${name}".`,
    );
  }
  await assertModuleCaptured(cwd, name);

  const s = spinner();
  s.start(`Updating "${name}"`);
  let outcome: StartOutcome;
  try {
    outcome = await prepareUpdate(ctx, args, s);
  } catch (e) {
    s.error(`Failed to update "${name}"`);
    throw e;
  }

  if (outcome.kind === 'up-to-date') {
    s.stop(`"${name}" is already at ${short(outcome.commit)}${refLabel(outcome.ref)}`);
    if (!opts.suppressBanners) outro('Nothing to update.');
    return;
  }
  if (outcome.kind === 'conflict') {
    await writeUpdateState(cwd, name, outcome.state);
    s.error(`Rebase of "${name}" stopped on a conflict`);
    throw new Error(conflictMessage(cwd, name, outcome.result));
  }

  const patches = outcome.kind === 'rebased' ? outcome.patches : null;
  s.stop(
    outcome.kind === 'rebased'
      ? `Rebased ${plural(outcome.patches.length, 'patch', 'patches')} for "${name}" onto ${short(outcome.state.newCommit)}`
      : `Re-pinned "${name}" to ${short(outcome.state.newCommit)}`,
  );

  await finalizeUpdate(ctx, outcome.state, patches);
  reportSuccess(outcome.state, patches);
  if (!opts.suppressBanners) outro(`Updated "${name}".`);
}

async function continueUpdate(cwd: string, name: string, opts: DispatchOpts): Promise<void> {
  const state = await readUpdateState(cwd, name);
  if (!state) {
    throw new Error(`No update in progress for "${name}". Start one with "inrepo update ${name}".`);
  }
  const repoRoot = updateRepoPath(cwd, state.name);
  if (!existsSync(repoRoot)) {
    throw new Error(
      `The scratch repository for "${state.name}" is missing from ${relative(cwd, repoRoot)}. Run "inrepo update ${state.name} --abort" and start the update again.`,
    );
  }
  const ctx = await loadUpdateContext(cwd, state.name);

  const s = spinner();
  s.start(`Continuing the update of "${state.name}"`);
  let result: SeriesRebaseResult;
  try {
    result = await continueSeriesRebase({
      repoRoot,
      newBase: state.newBase,
      author: await resolveSeriesAuthor(cwd),
    });
  } catch (e) {
    s.error(`Failed to continue the update of "${state.name}"`);
    throw e;
  }

  if (result.status === 'conflict') {
    s.error(`Rebase of "${state.name}" stopped on another conflict`);
    throw new Error(conflictMessage(cwd, state.name, result));
  }
  s.stop(
    `Rebased ${plural(result.patches.length, 'patch', 'patches')} for "${state.name}" onto ${short(state.newCommit)}`,
  );

  await finalizeUpdate(ctx, state, result.patches);
  reportSuccess(state, result.patches);
  if (!opts.suppressBanners) outro(`Updated "${state.name}".`);
}

async function abortUpdate(cwd: string, name: string, opts: DispatchOpts): Promise<void> {
  if (!isUpdateInProgress(cwd, name)) {
    throw new Error(`No update in progress for "${name}".`);
  }
  await clearUpdate(cwd, name);
  console.log(`Discarded the in-progress update for "${name}".`);
  if (!opts.suppressBanners) outro(`"${name}" is unchanged.`);
}

/**
 * Move a package to a newer upstream commit by rebasing its committed patch
 * series onto it.
 *
 * The rebase runs in a scratch repository under `.inrepo/updates/<name>/`. A
 * clean rebase rewrites the series, the pin, and the generated module in one
 * go; a conflicted one leaves that scratch repository in place for the user to
 * resolve and changes nothing else.
 */
export async function cmdUpdate(
  cwd: string,
  argv: string[],
  opts: DispatchOpts = {},
): Promise<void> {
  const args = parseUpdateArgs(argv);
  if (!opts.suppressBanners) printBanner();

  if (args.abort) {
    if (!opts.suppressBanners) intro(`inrepo update — ${args.name} (abort)`);
    await abortUpdate(cwd, args.name, opts);
    return;
  }
  if (args.continue) {
    if (!opts.suppressBanners) intro(`inrepo update — ${args.name} (continue)`);
    await continueUpdate(cwd, args.name, opts);
    return;
  }

  if (!opts.suppressBanners) intro(`inrepo update — ${args.name}`);
  await startUpdate(cwd, args, opts);
}
