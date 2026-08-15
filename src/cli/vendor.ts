import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import nodePath from "node:path";

import { upsertLockModule } from "../lockfile/upsert-lock-module.js";
import { assembleModuleTree } from "../overlay/assemble-module.js";
import { ensurePristine } from "../overlay/cache.js";
import { compareTrees } from "../overlay/compare-trees.js";
import { readModuleState, writeModuleState } from "../overlay/module-state.js";
import { backupDirPath, overlayDirPath } from "../overlay/overlay-paths.js";
import { hashTree } from "../overlay/tree-hash.js";
import { copyTree } from "../overlay/tree-utils.js";
import { readPackageManifest } from "../package-json/read-package-manifest.js";
import { upsertRootPackageJsonDependency } from "../package-json/upsert-vendored-package-ref.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { normalizeRepositoryUrlIdentity } from "../registry/normalize-repository-url-identity.js";
import { resolvePackageSourceFromNpm } from "../registry/resolve-git-url-from-npm.js";
import type { RewireReport } from "../rewire/rewire-tree.js";
import type { LockModule } from "../types/lock-module.js";
import type { MaterializeOptions, PackageSpec } from "./types.js";
import { spinner, warn } from "./ui.js";

export const EMPTY_TREE_HASH = createHash("sha256")
  .update("", "utf-8")
  .digest("hex");

export const mergedVendorExcludes = function mergedVendorExcludes(
  globalExclude: string[],
  pkg: { exclude?: string[] }
): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
};

export const mergedVendorKeeps = function mergedVendorKeeps(
  globalKeep: string[],
  pkg: { keep?: string[] }
): string[] {
  return [...new Set([...globalKeep, ...(pkg.keep ?? [])])];
};

const normalizedRef = function normalizedRef(
  ref?: string | null
): string | undefined {
  const trimmed = ref?.trim();
  return trimmed || undefined;
};

const resolvePackageSource = async function resolvePackageSource(
  pkg: PackageSpec,
  fallback: { gitUrl: string; repositoryDirectory?: string } | undefined,
  s: ReturnType<typeof spinner>
): Promise<{ gitUrl: string; repositoryDirectory: string | null }> {
  if (pkg.git?.trim()) {
    const gitUrl = pkg.git.trim();
    const sameRepository =
      fallback != null &&
      normalizeRepositoryUrlIdentity(gitUrl) ===
        normalizeRepositoryUrlIdentity(fallback.gitUrl);
    return {
      gitUrl,
      repositoryDirectory:
        pkg.repositoryDirectory ??
        (sameRepository ? fallback.repositoryDirectory : undefined) ??
        null,
    };
  }
  if (fallback) {
    return {
      gitUrl: fallback.gitUrl,
      repositoryDirectory:
        pkg.repositoryDirectory ?? fallback.repositoryDirectory ?? null,
    };
  }
  s.message(`Resolving "${pkg.name}" from npm registry`);
  return await resolvePackageSourceFromNpm(pkg.name);
};

export const makeSiblingStage = async function makeSiblingStage(
  dest: string,
  prefix: string
): Promise<string> {
  const parent = nodePath.dirname(dest);
  await mkdir(parent, { recursive: true });
  return mkdtemp(nodePath.join(parent, prefix));
};

const backupTimestamp = function backupTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
};

const snapshotModuleBackup = async function snapshotModuleBackup(
  cwd: string,
  name: string,
  dest: string
): Promise<string> {
  const backup = backupDirPath(cwd, name, backupTimestamp());
  await copyTree(dest, backup, { treatMissingAsEmpty: true });
  return backup;
};

const uncapturedEditsMessage = function uncapturedEditsMessage(
  name: string
): string {
  return `uncaptured edits in "inrepo_modules/${name}"; run "inrepo patch ${name}" to capture, or "inrepo sync --force" to discard`;
};

export const overlayConflictMessage = function overlayConflictMessage(
  name: string
): string {
  return `both "inrepo_patches/${name}" and "inrepo_modules/${name}" changed since the last sync; run "inrepo sync" to rebuild or reconcile them manually`;
};

const countLabel = function countLabel(
  count: number,
  singular: string
): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
};

/**
 * Report the generated import rewiring for one package: what it rewrote, and
 * every specifier that named a vendored dependency but resolved to no file.
 * Unresolved specifiers are a warning rather than a failure — they are left
 * exactly as upstream wrote them, so the tree stays deterministic either way.
 */
const reportRewire = function reportRewire(
  name: string,
  report: RewireReport | null
): void {
  if (report == null) {
    return;
  }
  if (report.specifiers > 0) {
    console.log(
      `  Rewired ${countLabel(report.specifiers, "import specifier")} in ` +
        `${countLabel(report.files, "file")} of "${name}"`
    );
  }
  if (report.unresolved.length > 0) {
    const shown = report.unresolved.slice(0, 5);
    const suffix =
      report.unresolved.length > shown.length
        ? `, … (+${report.unresolved.length - shown.length} more)`
        : "";
    warn(
      `Warning: could not rewire ${countLabel(report.unresolved.length, "specifier")} in "${name}" ` +
        `(left unchanged): ${shown
          .map((entry) => `${entry.specifier} in ${entry.file}`)
          .join(", ")}${suffix}`
    );
  }
};

export const hasTreeDrift = function hasTreeDrift(
  result: Awaited<ReturnType<typeof compareTrees>>
): boolean {
  return (
    result.added.length > 0 ||
    result.modified.length > 0 ||
    result.removed.length > 0 ||
    result.typeChanges.length > 0
  );
};

export const materializePackage = async function materializePackage(
  cwd: string,
  pkg: PackageSpec,
  globalExclude: string[],
  globalKeep: string[],
  opts: MaterializeOptions
): Promise<void> {
  const module = pkg.module ?? pkg.name;
  const dest = moduleDestPath(cwd, module);
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
      s
    );
    let { gitUrl } = source;
    const { repositoryDirectory } = source;
    const resolvedLockGitUrl = normalizeRepositoryUrlIdentity(
      opts.lockEntry?.gitUrl
    );
    const usePinnedLock =
      opts.mode === "sync" &&
      opts.lockEntry != null &&
      resolvedLockGitUrl === normalizeRepositoryUrlIdentity(gitUrl) &&
      opts.lockEntry.ref === (ref ?? null);
    const pinnedCommit =
      pkg.commit?.trim() ||
      (usePinnedLock ? opts.lockEntry?.commit : null) ||
      (opts.mode === "add" ? (opts.resolvedCommit ?? null) : null) ||
      null;

    s.message(
      pinnedCommit
        ? `Preparing upstream cache @ ${pinnedCommit.slice(0, 7)}`
        : `Preparing upstream cache${ref ? ` @ ${ref}` : ""}`
    );
    const pristine = await ensurePristine({
      artifact: pkg.artifact ?? opts.lockEntry?.artifact,
      commit: pinnedCommit,
      cwd,
      exclude: excludeList,
      gitUrl,
      keep: keepList,
      name: module,
      ref: ref ?? null,
      repositoryDirectory,
    });
    ({ gitUrl } = pristine);
    if (opts.mode === "add" && repositoryDirectory != null) {
      const manifest = await readPackageManifest(pristine.dir);
      if (manifest == null) {
        throw new Error(
          `Cannot vendor "${pkg.name}": its selected repository directory has no package.json.`
        );
      }
      if (manifest.name !== pkg.name) {
        throw new Error(
          manifest.name == null
            ? `Cannot vendor "${pkg.name}": its selected repository directory package.json has no name.`
            : `Cannot vendor "${pkg.name}": its selected repository directory declares package "${manifest.name}".`
        );
      }
    }

    const overlayHash = await hashTree(overlayDirPath(cwd, module));
    const stage = await makeSiblingStage(dest, ".inrepo-next-");
    let rewire: RewireReport | null = null;

    try {
      s.message("Assembling generated vendor tree");
      await assembleModuleTree({
        commit: pristine.commit,
        cwd,
        gitUrl,
        name: module,
        onRewire: (report) => {
          rewire = report;
        },
        pristineRoot: pristine.dir,
        repositoryDirectory,
        targetRoot: stage,
      });

      const stageHash = await hashTree(stage);
      const state = await readModuleState(cwd, module);
      const currentModuleHash = existsSync(dest)
        ? await hashTree(dest)
        : EMPTY_TREE_HASH;

      if (existsSync(dest)) {
        if (state) {
          const overlayChanged = overlayHash !== state.overlayHash;
          const moduleChanged = currentModuleHash !== state.moduleHash;
          if (!opts.force && overlayChanged && moduleChanged) {
            throw new Error(overlayConflictMessage(module));
          }
          if (!opts.force && !overlayChanged && moduleChanged) {
            throw new Error(uncapturedEditsMessage(module));
          }
        } else {
          const drift = await compareTrees(stage, dest);
          if (!opts.force && hasTreeDrift(drift)) {
            throw new Error(uncapturedEditsMessage(module));
          }
        }

        if (opts.force && currentModuleHash !== stageHash) {
          s.message("Saving working tree backup");
          const backup = await snapshotModuleBackup(cwd, module, dest);
          warn(`Saved checkout backup: ${backup}`);
        }

        s.message(`Replacing ${dest}`);
        await rm(dest, { force: true, recursive: true });
      }

      await rename(stage, dest);
      await writeModuleState(cwd, module, {
        moduleHash: stageHash,
        overlayHash,
      });
    } catch (error) {
      await rm(stage, { force: true, recursive: true });
      throw error;
    }

    if (
      opts.mode === "add" ||
      !opts.lockEntry ||
      opts.lockEntry.commit !== pristine.commit ||
      opts.lockEntry.gitUrl !== gitUrl ||
      (opts.lockEntry.repositoryDirectory ?? null) !== repositoryDirectory ||
      opts.lockEntry.ref !== (ref ?? null)
    ) {
      s.message("Updating lockfile");
      const lockModule: LockModule = {
        commit: pristine.commit,
        gitUrl,
        ref: ref ?? null,
        source: pkg.name,
        updatedAt: new Date().toISOString(),
      };
      if (repositoryDirectory != null) {
        lockModule.repositoryDirectory = repositoryDirectory;
      }
      const artifact = pkg.artifact ?? opts.lockEntry?.artifact;
      if (artifact != null) {
        lockModule.artifact = artifact;
      }
      await upsertLockModule(cwd, module, lockModule);
    }

    // Graph-managed dependency instances are reached through each dependent's
    // recorded/re-written edge. Linking them all into the host package.json
    // would collapse incompatible versions back to one package-name key.
    if (module === pkg.name) {
      s.message("Updating package.json");
      await upsertRootPackageJsonDependency(
        cwd,
        pkg.name,
        pkg.dev === true,
        module
      );
    }

    // Final stop message preserves the e2e contract: `Synced "<name>" @ <sha7>` on stdout.
    s.stop(`Synced "${pkg.name}" @ ${pristine.commit.slice(0, 7)} → ${dest}`);
    reportRewire(pkg.name, rewire);
  } catch (error) {
    // Keep the spinner failure terse; the full error is printed by main() so we
    // do not duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw error;
  }
};
