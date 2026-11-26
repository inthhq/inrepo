import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import nodePath from "node:path";

import { resolveRemoteCommit } from "../git/resolve-remote-commit.js";
import { upsertLockModule } from "../lockfile/upsert-lock-module.js";
import { assembleModuleTree } from "../overlay/assemble-module.js";
import { ensurePristine } from "../overlay/cache.js";
import { compareTrees } from "../overlay/compare-trees.js";
import { readModuleState, writeModuleState } from "../overlay/module-state.js";
import {
  backupDirPath,
  overlayDirPath,
  seriesDirPath,
} from "../overlay/overlay-paths.js";
import { hashTree } from "../overlay/tree-hash.js";
import { copyTree } from "../overlay/tree-utils.js";
import { readPackageManifest } from "../package-json/read-package-manifest.js";
import { upsertRootPackageJsonDependency } from "../package-json/upsert-vendored-package-ref.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { normalizeRepositoryUrlIdentity } from "../registry/normalize-repository-url-identity.js";
import { resolvePackageSourceFromNpm } from "../registry/resolve-git-url-from-npm.js";
import type { RewireReport } from "../rewire/rewire-tree.js";
import { readSeries } from "../series/read-series.js";
import type { LockModule } from "../types/lock-module.js";
import { InrepoError } from "./errors.js";
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
  s?: ReturnType<typeof spinner>
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
  s?.message(`Resolving "${pkg.name}" from npm registry`);
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

export const overlayConflictMessage = function overlayConflictMessage(
  name: string
): string {
  return `both "inrepo_patches/${name}" and "inrepo_modules/${name}" changed since the last sync; run "inrepo sync" to rebuild or reconcile them manually`;
};

const uncapturedEditsMessage = function uncapturedEditsMessage(
  name: string
): string {
  return `uncaptured edits in "inrepo_modules/${name}"; run "inrepo patch ${name}" to capture, or "inrepo sync --force" to discard`;
};

/** Cap on the file list attached to an `UNCAPTURED_EDITS` failure. */
const MAX_REPORTED_FILES = 50;

const driftFiles = function driftFiles(
  drift: Awaited<ReturnType<typeof compareTrees>>
): string[] {
  return [
    ...new Set([
      ...drift.modified,
      ...drift.added,
      ...drift.removed,
      ...drift.typeChanges,
    ]),
  ]
    .toSorted()
    .slice(0, MAX_REPORTED_FILES);
};

/**
 * Sync refuses to overwrite hand edits in `inrepo_modules/<pkg>` that were
 * never captured into `inrepo_patches/`. `files` lists what differs from the
 * tree sync would build, when that is known.
 */
const uncapturedEditsError = function uncapturedEditsError(
  name: string,
  files?: string[]
): InrepoError {
  return new InrepoError("UNCAPTURED_EDITS", uncapturedEditsMessage(name), {
    details: files == null ? { package: name } : { files, package: name },
    hint: `Capture them with: inrepo patch ${name} -m "<reason>", or discard them with: inrepo sync --force`,
    nextCommand: `inrepo patch ${name} -m "<reason>"`,
  });
};

const overlayConflictError = function overlayConflictError(
  name: string
): InrepoError {
  return new InrepoError("UNCAPTURED_EDITS", overlayConflictMessage(name), {
    details: { overlayChanged: true, package: name },
    hint: `Reconcile inrepo_patches/${name} with inrepo_modules/${name} by hand, or discard the checkout edits with: inrepo sync --force`,
    nextCommand: "inrepo sync --force",
  });
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

/**
 * What a sync/add did, or (under `--dry-run`) would do, to one package's
 * generated checkout.
 *
 * - `created`: the package had no checkout or no lockfile entry; one was built.
 * - `updated`: the pin (commit, source, or ref) moved; the checkout was rebuilt.
 * - `rebuilt`: same pin, but the generated tree changed (patches, filters, or
 *   discarded edits under `--force`).
 * - `unchanged`: same pin and an identical tree.
 * - `reused`: `add --with-deps` found an existing pin that already satisfies
 *   the graph; nothing was rebuilt.
 * - `would-*`: the `--dry-run` predictions of the actions above.
 */
export type MaterializeAction =
  | "created"
  | "rebuilt"
  | "reused"
  | "unchanged"
  | "updated"
  | "would-create"
  | "would-rebuild"
  | "would-update";

export interface MaterializeResult {
  action: MaterializeAction;
  /** Backup of discarded checkout edits (`--force`), relative to the project. */
  backup: string | null;
  /** Upstream commit the checkout is (or would be) built from. */
  commit: string;
  git: string;
  module: string;
  name: string;
  /** Generated checkout, relative to the project root. */
  path: string;
  /** Patch files in `inrepo_patches/<module>/series/`. */
  patches: number;
  /** Lockfile commit before this run; null when the package was not locked. */
  previousCommit: string | null;
  ref: string | null;
  repositoryDirectory: string | null;
}

const projectRelative = function projectRelative(
  cwd: string,
  path: string
): string {
  return nodePath.relative(cwd, path).split(nodePath.sep).join("/");
};

export const countSeriesPatches = async function countSeriesPatches(
  cwd: string,
  module: string
): Promise<number> {
  return (await readSeries(seriesDirPath(cwd, module))).length;
};

interface ResolvedMaterializeSource {
  gitUrl: string;
  repositoryDirectory: string | null;
  ref: string | undefined;
  /** Commit to reuse; null means "fetch the moving tip of `ref`". */
  pinnedCommit: string | null;
}

const resolveMaterializeSource = async function resolveMaterializeSource(
  pkg: PackageSpec,
  opts: MaterializeOptions,
  s?: ReturnType<typeof spinner>
): Promise<ResolvedMaterializeSource> {
  const ref = normalizedRef(pkg.ref);
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
  const { gitUrl, repositoryDirectory } = source;
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
  return { gitUrl, pinnedCommit, ref, repositoryDirectory };
};

/** True when the lockfile entry would be rewritten for this resolved pin. */
const pinChanged = function pinChanged(
  lockEntry: LockModule | undefined,
  pin: {
    commit: string;
    gitUrl: string;
    ref: string | null;
    repositoryDirectory: string | null;
  }
): boolean {
  return (
    !lockEntry ||
    lockEntry.commit !== pin.commit ||
    lockEntry.gitUrl !== pin.gitUrl ||
    (lockEntry.repositoryDirectory ?? null) !== pin.repositoryDirectory ||
    lockEntry.ref !== pin.ref
  );
};

const ABBREVIATED_SHA = /^[0-9a-f]{7,39}$/iu;

/**
 * Read-only preview of {@link materializePackage} for `--dry-run`.
 *
 * Resolves the source and the commit (from the lockfile pin or with
 * `git ls-remote`) and checks for uncaptured edits using the recorded sync
 * state, but never clones, writes the lockfile, package.json, `.inrepo/`, or
 * `inrepo_modules/`. Edits in a checkout with no recorded sync state can only
 * be detected by building the tree, so they are not reported here.
 */
export const planMaterialize = async function planMaterialize(
  cwd: string,
  pkg: PackageSpec,
  opts: MaterializeOptions
): Promise<MaterializeResult> {
  const module = pkg.module ?? pkg.name;
  const dest = moduleDestPath(cwd, module);
  const s = spinner();
  s.start(`Resolving "${pkg.name}"`);
  try {
    const source = await resolveMaterializeSource(pkg, opts, s);
    const ref = source.ref ?? null;
    let commit = source.pinnedCommit;
    if (commit == null) {
      s.message(`Resolving ${ref ?? "default branch"} in ${source.gitUrl}`);
      try {
        commit = await resolveRemoteCommit(source.gitUrl, ref);
      } catch (error) {
        // An abbreviated commit id cannot be expanded without fetching; a real
        // run would fetch it, so preview it as given. resolveRemoteCommit
        // reports exactly that case as USAGE; anything else is real trouble.
        const isShortCommitRef =
          error instanceof InrepoError &&
          error.code === "USAGE" &&
          ref != null &&
          ABBREVIATED_SHA.test(ref);
        if (!isShortCommitRef) {
          throw error;
        }
        commit = ref.toLowerCase();
      }
    }

    const exists = existsSync(dest);
    const state = exists ? await readModuleState(cwd, module) : null;
    let checkoutMatchesState = false;
    if (exists && state) {
      const overlayChanged =
        (await hashTree(overlayDirPath(cwd, module))) !== state.overlayHash;
      const moduleChanged = (await hashTree(dest)) !== state.moduleHash;
      if (!opts.force && overlayChanged && moduleChanged) {
        throw overlayConflictError(module);
      }
      if (!opts.force && !overlayChanged && moduleChanged) {
        throw uncapturedEditsError(module);
      }
      checkoutMatchesState = !overlayChanged && !moduleChanged;
    }

    const changed = pinChanged(opts.lockEntry, {
      commit,
      gitUrl: source.gitUrl,
      ref,
      repositoryDirectory: source.repositoryDirectory,
    });
    let action: MaterializeAction = "would-rebuild";
    if (!exists || !opts.lockEntry) {
      action = "would-create";
    } else if (changed) {
      action = "would-update";
    } else if (checkoutMatchesState) {
      action = "unchanged";
    }

    s.stop(
      `Would sync "${pkg.name}" @ ${commit.slice(0, 7)} → ${dest} (${action})`
    );
    return {
      action,
      backup: null,
      commit,
      git: source.gitUrl,
      module,
      name: pkg.name,
      patches: await countSeriesPatches(cwd, module),
      path: projectRelative(cwd, dest),
      previousCommit: opts.lockEntry?.commit ?? null,
      ref,
      repositoryDirectory: source.repositoryDirectory,
    };
  } catch (error) {
    s.error(`Failed to resolve "${pkg.name}"`);
    throw error;
  }
};

export const materializePackage = async function materializePackage(
  cwd: string,
  pkg: PackageSpec,
  globalExclude: string[],
  globalKeep: string[],
  opts: MaterializeOptions
): Promise<MaterializeResult> {
  const module = pkg.module ?? pkg.name;
  const dest = moduleDestPath(cwd, module);
  const existedBefore = existsSync(dest);

  // Pre-checkout warning needs to be on stderr (e2e contract). We emit it
  // before the spinner starts so it doesn't get tangled in spinner re-renders.
  if (existedBefore) {
    warn(`Warning: replacing existing checkout: ${dest}`);
  }

  const s = spinner();
  s.start(`Vendoring "${pkg.name}"`);

  try {
    const keepList = mergedVendorKeeps(globalKeep, pkg);
    const excludeList = mergedVendorExcludes(globalExclude, pkg);
    const source = await resolveMaterializeSource(pkg, opts, s);
    const { ref, pinnedCommit, repositoryDirectory } = source;
    let { gitUrl } = source;

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
    let backup: string | null = null;
    let treeChanged = true;

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
      treeChanged = currentModuleHash !== stageHash;

      if (existsSync(dest)) {
        if (state) {
          const overlayChanged = overlayHash !== state.overlayHash;
          const moduleChanged = currentModuleHash !== state.moduleHash;
          if (!opts.force && overlayChanged && moduleChanged) {
            throw overlayConflictError(module);
          }
          if (!opts.force && !overlayChanged && moduleChanged) {
            // Only list files when the pin is unchanged; otherwise the diff
            // would mix upstream changes with the local edits.
            const files =
              opts.lockEntry?.commit === pristine.commit
                ? driftFiles(await compareTrees(stage, dest))
                : undefined;
            throw uncapturedEditsError(module, files);
          }
        } else {
          const drift = await compareTrees(stage, dest);
          if (!opts.force && hasTreeDrift(drift)) {
            throw uncapturedEditsError(module, driftFiles(drift));
          }
        }

        if (opts.force && treeChanged) {
          s.message("Saving working tree backup");
          backup = await snapshotModuleBackup(cwd, module, dest);
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

    const lockPinChanged = pinChanged(opts.lockEntry, {
      commit: pristine.commit,
      gitUrl,
      ref: ref ?? null,
      repositoryDirectory,
    });
    if (opts.mode === "add" || lockPinChanged) {
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

    let action: MaterializeAction = "unchanged";
    if (!existedBefore || !opts.lockEntry) {
      action = "created";
    } else if (lockPinChanged) {
      action = "updated";
    } else if (treeChanged) {
      action = "rebuilt";
    }
    return {
      action,
      backup: backup == null ? null : projectRelative(cwd, backup),
      commit: pristine.commit,
      git: gitUrl,
      module,
      name: pkg.name,
      patches: await countSeriesPatches(cwd, module),
      path: projectRelative(cwd, dest),
      previousCommit: opts.lockEntry?.commit ?? null,
      ref: ref ?? null,
      repositoryDirectory,
    };
  } catch (error) {
    // Keep the spinner failure terse; the full error is printed by main() so we
    // do not duplicate the message.
    s.error(`Failed to vendor "${pkg.name}"`);
    throw error;
  }
};
