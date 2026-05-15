import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assembleModuleTree } from '../overlay/assemble-module.js';
import { ensurePristine } from '../overlay/cache.js';
import { compareTrees } from '../overlay/compare-trees.js';
import { backupDirPath, overlayDirPath } from '../overlay/overlay-paths.js';
import { hashTree } from '../overlay/tree-hash.js';
import { copyTree } from '../overlay/tree-utils.js';
import { upsertRootPackageJsonDependency } from '../package-json/upsert-vendored-package-ref.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { normalizeGithubHttpsUrl } from '../registry/normalize-github-https-url.js';
import { resolveGitUrlFromNpm } from '../registry/resolve-git-url-from-npm.js';
import { upsertLockModule } from '../lockfile/upsert-lock-module.js';
import { readModuleState, writeModuleState } from '../overlay/module-state.js';
import { spinner, warn } from './ui.js';
import type { MaterializeOptions, PackageSpec } from './types.js';

export const EMPTY_TREE_HASH = createHash('sha256').update('', 'utf8').digest('hex');

export function mergedVendorExcludes(
  globalExclude: string[],
  pkg: { exclude?: string[] },
): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
}

export function mergedVendorKeeps(globalKeep: string[], pkg: { keep?: string[] }): string[] {
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

  const hasUrlScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const scpLike = hasUrlScheme
    ? null
    : /^(?<user>[^@]+@)?(?<host>[^:/]+):(?<path>.+)$/.exec(trimmed);
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

export async function makeSiblingStage(dest: string, prefix: string): Promise<string> {
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

export function overlayConflictMessage(name: string): string {
  return `both "inrepo_patches/${name}" and "inrepo_modules/${name}" changed since the last sync; run "inrepo sync" to rebuild or reconcile them manually`;
}

export function hasTreeDrift(result: Awaited<ReturnType<typeof compareTrees>>): boolean {
  return (
    result.added.length > 0 ||
    result.modified.length > 0 ||
    result.removed.length > 0 ||
    result.typeChanges.length > 0
  );
}

export async function materializePackage(
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
    warn(`Warning: replacing existing checkout: ${dest}`);
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
          if (!opts.force && hasTreeDrift(drift)) {
            throw new Error(uncapturedEditsMessage(pkg.name));
          }
        }

        if (opts.force && currentModuleHash !== stageHash) {
          s.message('Saving working tree backup');
          const backup = await snapshotModuleBackup(cwd, pkg.name, dest);
          warn(`Saved checkout backup: ${backup}`);
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
    // Keep the spinner failure terse; the full error is printed by main() so we
    // do not duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw e;
  }
}
