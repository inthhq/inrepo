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
import { readPackageManifest } from '../package-json/read-package-manifest.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { normalizeRepositoryUrlIdentity } from '../registry/normalize-repository-url-identity.js';
import { resolvePackageSourceFromNpm } from '../registry/resolve-git-url-from-npm.js';
import { upsertLockModule } from '../lockfile/upsert-lock-module.js';
import { readModuleState, writeModuleState } from '../overlay/module-state.js';
import type { RewireReport } from '../rewire/rewire-tree.js';
import { spinner, warn } from './ui.js';
import type { MaterializeOptions, PackageSpec } from './types.js';

export const EMPTY_TREE_HASH = createHash('sha256').update('', 'utf8').digest('hex');

export function mergedVendorExcludes(globalExclude: string[], pkg: { exclude?: string[] }): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
}

export function mergedVendorKeeps(globalKeep: string[], pkg: { keep?: string[] }): string[] {
  return [...new Set([...globalKeep, ...(pkg.keep ?? [])])];
}

function normalizedRef(ref?: string | null): string | undefined {
  const trimmed = ref?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolvePackageSource(
  pkg: PackageSpec,
  fallback: { gitUrl: string; repositoryDirectory?: string } | undefined,
  s: ReturnType<typeof spinner>,
): Promise<{ gitUrl: string; repositoryDirectory: string | null }> {
  if (pkg.git?.trim()) {
    const gitUrl = pkg.git.trim();
    const sameRepository =
      fallback != null && normalizeRepositoryUrlIdentity(gitUrl) === normalizeRepositoryUrlIdentity(fallback.gitUrl);
    return {
      gitUrl,
      repositoryDirectory:
        pkg.repositoryDirectory ?? (sameRepository ? fallback.repositoryDirectory : undefined) ?? null,
    };
  }
  if (fallback) {
    return {
      gitUrl: fallback.gitUrl,
      repositoryDirectory: pkg.repositoryDirectory ?? fallback.repositoryDirectory ?? null,
    };
  }
  s.message(`Resolving "${pkg.name}" from npm registry`);
  return resolvePackageSourceFromNpm(pkg.name);
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

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * Report the generated import rewiring for one package: what it rewrote, and
 * every specifier that named a vendored dependency but resolved to no file.
 * Unresolved specifiers are a warning rather than a failure — they are left
 * exactly as upstream wrote them, so the tree stays deterministic either way.
 */
function reportRewire(name: string, report: RewireReport | null): void {
  if (report == null) return;
  if (report.specifiers > 0) {
    console.log(
      `  Rewired ${countLabel(report.specifiers, 'import specifier')} in ` +
        `${countLabel(report.files, 'file')} of "${name}"`,
    );
  }
  if (report.unresolved.length > 0) {
    const shown = report.unresolved.slice(0, 5);
    const suffix =
      report.unresolved.length > shown.length ? `, … (+${report.unresolved.length - shown.length} more)` : '';
    warn(
      `Warning: could not rewire ${countLabel(report.unresolved.length, 'specifier')} in "${name}" ` +
        `(left unchanged): ` +
        shown.map((entry) => `${entry.specifier} in ${entry.file}`).join(', ') +
        suffix,
    );
  }
}

export function hasTreeDrift(result: Awaited<ReturnType<typeof compareTrees>>): boolean {
  return (
    result.added.length > 0 || result.modified.length > 0 || result.removed.length > 0 || result.typeChanges.length > 0
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
    const source = await resolvePackageSource(
      pkg,
      opts.lockEntry
        ? {
            gitUrl: opts.lockEntry.gitUrl,
            repositoryDirectory: opts.lockEntry.repositoryDirectory,
          }
        : undefined,
      s,
    );
    let gitUrl = source.gitUrl;
    const repositoryDirectory = source.repositoryDirectory;
    const resolvedLockGitUrl = normalizeRepositoryUrlIdentity(opts.lockEntry?.gitUrl);
    const usePinnedLock =
      opts.mode === 'sync' &&
      opts.lockEntry != null &&
      resolvedLockGitUrl === normalizeRepositoryUrlIdentity(gitUrl) &&
      opts.lockEntry.ref === (ref ?? null);
    const pinnedCommit =
      pkg.commit?.trim() ||
      (usePinnedLock ? opts.lockEntry?.commit : null) ||
      (opts.mode === 'add' ? (opts.resolvedCommit ?? null) : null) ||
      null;

    s.message(
      pinnedCommit
        ? `Preparing upstream cache @ ${pinnedCommit.slice(0, 7)}`
        : `Preparing upstream cache${ref ? ` @ ${ref}` : ''}`,
    );
    const pristine = await ensurePristine({
      cwd,
      name: pkg.name,
      gitUrl,
      repositoryDirectory,
      ref: ref ?? null,
      commit: pinnedCommit,
      keep: keepList,
      exclude: excludeList,
    });
    gitUrl = pristine.gitUrl;
    if (opts.mode === 'add' && repositoryDirectory != null) {
      const manifest = await readPackageManifest(pristine.dir);
      if (manifest == null) {
        throw new Error(`Cannot vendor "${pkg.name}": its selected repository directory has no package.json.`);
      }
      if (manifest.name !== pkg.name) {
        throw new Error(
          manifest.name == null
            ? `Cannot vendor "${pkg.name}": its selected repository directory package.json has no name.`
            : `Cannot vendor "${pkg.name}": its selected repository directory declares package "${manifest.name}".`,
        );
      }
    }

    const overlayHash = await hashTree(overlayDirPath(cwd, pkg.name));
    const stage = await makeSiblingStage(dest, '.inrepo-next-');
    let rewire: RewireReport | null = null;

    try {
      s.message('Assembling generated vendor tree');
      await assembleModuleTree({
        cwd,
        name: pkg.name,
        pristineRoot: pristine.dir,
        commit: pristine.commit,
        gitUrl,
        repositoryDirectory,
        targetRoot: stage,
        onRewire: (report) => {
          rewire = report;
        },
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
      (opts.lockEntry.repositoryDirectory ?? null) !== repositoryDirectory ||
      opts.lockEntry.ref !== (ref ?? null)
    ) {
      s.message('Updating lockfile');
      await upsertLockModule(cwd, pkg.name, {
        source: pkg.name,
        gitUrl,
        ...(repositoryDirectory == null ? {} : { repositoryDirectory }),
        commit: pristine.commit,
        ref: ref ?? null,
        updatedAt: new Date().toISOString(),
      });
    }

    s.message('Updating package.json');
    await upsertRootPackageJsonDependency(cwd, pkg.name, pkg.dev === true);

    // Final stop message preserves the e2e contract: `Synced "<name>" @ <sha7>` on stdout.
    s.stop(`Synced "${pkg.name}" @ ${pristine.commit.slice(0, 7)} → ${dest}`);
    reportRewire(pkg.name, rewire);
  } catch (e) {
    // Keep the spinner failure terse; the full error is printed by main() so we
    // do not duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw e;
  }
}
