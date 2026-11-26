import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { PackageSpec } from "../cli/types.js";
import {
  hasTreeDrift,
  mergedVendorExcludes,
  mergedVendorKeeps,
} from "../cli/vendor.js";
import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
import { assembleModuleTree } from "../overlay/assemble-module.js";
import { compareTrees } from "../overlay/compare-trees.js";
import { filtersHash } from "../overlay/filters-hash.js";
import { readModuleState } from "../overlay/module-state.js";
import {
  cacheDirPath,
  cacheMetaPath,
  overlayDirPath,
  seriesDirPath,
  updateRepoPath,
} from "../overlay/overlay-paths.js";
import { hashTree } from "../overlay/tree-hash.js";
import { walkTree } from "../overlay/tree-utils.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { listLegacyOverlayEntries } from "../series/legacy-overlay.js";
import { readSeriesHeaders } from "../series/read-patch-header.js";
import { inspectSeriesRebase } from "../series/rebase-series.js";
import { isUpdateInProgress, readUpdateState } from "../series/update-state.js";
import type { LockModule } from "../types/lock-module.js";

/** Overall condition of one package, most urgent first. */
export type PackageCondition =
  /** `inrepo update` stopped; finish or abort it before anything else. */
  | "update-in-progress"
  /** Both the checkout and inrepo_patches/ changed since the last sync. */
  | "diverged"
  /** inrepo_modules/<pkg> has edits not captured in inrepo_patches/. */
  | "uncaptured-edits"
  /** Configured but not in the lockfile yet. */
  | "not-locked"
  /** Locked but inrepo_modules/<pkg> does not exist. */
  | "missing"
  /** Checkout is behind the lockfile or the committed patches. */
  | "needs-sync"
  /** Checkout exists but inrepo has no sync record to compare it against. */
  | "unverified"
  | "clean";

export interface StatusPatch {
  number: number;
  subject: string;
  fileName: string;
}

export interface StatusPatches {
  /** `series`: ordered git patches; `overlay`: legacy whole-file snapshots. */
  format: "series" | "overlay" | "none";
  /** Patches in the series, or files in the legacy overlay. */
  count: number;
  series: StatusPatch[];
  /** Legacy overlay file paths (relative to inrepo_patches/<pkg>/). */
  overlayFiles: string[];
}

export interface StatusCheckout {
  /** Project-relative path of the generated checkout. */
  path: string;
  present: boolean;
  /** Commit recorded in the checkout's vendor marker. */
  commit: string | null;
  /** True when an `inrepo sync`/`patch` record exists for this checkout. */
  tracked: boolean;
  /** Null when it cannot be known offline (no checkout or no sync record). */
  uncapturedEdits: boolean | null;
  /** True when inrepo_patches/<pkg>/ changed since the checkout was built. */
  patchesChangedSinceSync: boolean | null;
  /**
   * Paths that differ from the committed state. Null when the upstream cache
   * needed to compute them is not available offline.
   */
  changedFiles: string[] | null;
}

export interface StatusUpdate {
  inProgress: true;
  fromCommit: string | null;
  targetRef: string | null;
  targetCommit: string | null;
  startedAt: string | null;
  /** True while the scratch rebase is stopped on a patch. */
  rebaseStopped: boolean;
  stoppedAt: { number: number; subject: string } | null;
  /** Unmerged paths in the scratch repository. */
  conflictedFiles: string[];
  /** Conflicted paths that still carry conflict markers. */
  unresolvedFiles: string[];
  /** True when `inrepo update <pkg> --continue` can proceed. */
  readyToContinue: boolean;
  /** Project-relative scratch repository to resolve conflicts in. */
  repoPath: string;
}

export interface PackageStatus {
  name: string;
  module: string;
  dev: boolean;
  /** True when the package is declared in the inrepo config. */
  configured: boolean;
  git: string | null;
  ref: string | null;
  repositoryDirectory: string | null;
  /** Commit pinned in the lockfile; null when not locked yet. */
  commit: string | null;
  lockedRef: string | null;
  condition: PackageCondition;
  patches: StatusPatches;
  checkout: StatusCheckout;
  update: StatusUpdate | null;
  /** Commands that move this package forward, most important first. */
  nextActions: string[];
}

interface StatusInput {
  cwd: string;
  pkg: PackageSpec;
  configured: boolean;
  lockEntry: LockModule | undefined;
  globalExclude: string[];
  globalKeep: string[];
}

const parseJsonFile = async function parseJsonFile(
  path: string
): Promise<JsonValue | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    // SAFETY: JSON.parse produces a JSON value from file contents.
    return JSON.parse(await readFile(path, "utf-8")) as JsonValue;
  } catch {
    return null;
  }
};

const readMarkerCommit = async function readMarkerCommit(
  dest: string
): Promise<string | null> {
  const marker = await parseJsonFile(
    nodePath.join(dest, ".inrepo-vendor.json")
  );
  return isJsonObject(marker) && isString(marker.commit) ? marker.commit : null;
};

const readPatches = async function readPatches(
  cwd: string,
  module: string
): Promise<StatusPatches> {
  const headers = await readSeriesHeaders(seriesDirPath(cwd, module));
  if (headers.length > 0) {
    return {
      count: headers.length,
      format: "series",
      overlayFiles: [],
      series: headers.map((header) => ({
        fileName: header.fileName,
        number: header.index,
        subject: header.subject,
      })),
    };
  }
  const overlayRoot = overlayDirPath(cwd, module);
  if ((await listLegacyOverlayEntries(overlayRoot)).length === 0) {
    return { count: 0, format: "none", overlayFiles: [], series: [] };
  }
  const entries = await walkTree(overlayRoot, {
    skip: (relPosix) => relPosix === "series" || relPosix.startsWith("series/"),
    treatMissingAsEmpty: true,
  });
  const files = [...entries.entries()]
    .filter(([, entry]) => entry.kind !== "dir")
    .map(([relPosix]) => relPosix)
    .toSorted();
  return {
    count: files.length,
    format: "overlay",
    overlayFiles: files,
    series: [],
  };
};

/**
 * The cached upstream tree for the locked commit, when it is already on disk
 * with the same filters. Never fetches.
 */
const offlinePristine = async function offlinePristine(
  input: StatusInput
): Promise<string | null> {
  const { cwd, pkg, lockEntry } = input;
  if (!lockEntry) {
    return null;
  }
  const module = pkg.module ?? pkg.name;
  const dir = cacheDirPath(cwd, module);
  const meta = await parseJsonFile(cacheMetaPath(cwd, module));
  if (!isJsonObject(meta) || !existsSync(dir)) {
    return null;
  }
  const expectedFilters = filtersHash(
    mergedVendorKeeps(input.globalKeep, pkg),
    mergedVendorExcludes(input.globalExclude, pkg)
  );
  const repositoryDirectory =
    pkg.repositoryDirectory ?? lockEntry.repositoryDirectory ?? null;
  const cachedDirectory = isString(meta.repositoryDirectory)
    ? meta.repositoryDirectory
    : null;
  const cachedIntegrity = isString(meta.artifactIntegrity)
    ? meta.artifactIntegrity
    : null;
  if (
    meta.commit !== lockEntry.commit ||
    meta.filtersHash !== expectedFilters ||
    cachedDirectory !== repositoryDirectory ||
    cachedIntegrity !== (lockEntry.artifact?.integrity ?? null)
  ) {
    return null;
  }
  return dir;
};

/**
 * Files in the checkout that differ from what `inrepo sync` would build.
 * Assembles into the OS temp directory so the project is never written.
 */
const diffAgainstCommitted = async function diffAgainstCommitted(
  input: StatusInput,
  dest: string
): Promise<string[] | null> {
  const { cwd, pkg, lockEntry } = input;
  const pristine = await offlinePristine(input);
  if (pristine == null || !lockEntry) {
    return null;
  }
  const work = await mkdtemp(nodePath.join(tmpdir(), "inrepo-status-"));
  try {
    const target = nodePath.join(work, "module");
    await assembleModuleTree({
      commit: lockEntry.commit,
      cwd,
      gitUrl: lockEntry.gitUrl,
      name: pkg.module ?? pkg.name,
      pristineRoot: pristine,
      repositoryDirectory:
        pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
      targetRoot: target,
    });
    const drift = await compareTrees(target, dest);
    if (!hasTreeDrift(drift)) {
      return [];
    }
    return [
      ...drift.added,
      ...drift.modified,
      ...drift.removed,
      ...drift.typeChanges,
    ].toSorted();
  } catch {
    return null;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};

const readCheckout = async function readCheckout(
  input: StatusInput
): Promise<StatusCheckout> {
  const { cwd, pkg } = input;
  const module = pkg.module ?? pkg.name;
  const dest = moduleDestPath(cwd, module);
  const checkout: StatusCheckout = {
    changedFiles: null,
    commit: null,
    patchesChangedSinceSync: null,
    path: nodePath.relative(cwd, dest),
    present: existsSync(dest),
    tracked: false,
    uncapturedEdits: null,
  };
  if (!checkout.present) {
    return checkout;
  }
  checkout.commit = await readMarkerCommit(dest);

  let state: Awaited<ReturnType<typeof readModuleState>> = null;
  try {
    state = await readModuleState(cwd, module);
  } catch {
    state = null;
  }
  if (state) {
    checkout.tracked = true;
    checkout.uncapturedEdits = (await hashTree(dest)) !== state.moduleHash;
    checkout.patchesChangedSinceSync =
      (await hashTree(overlayDirPath(cwd, module))) !== state.overlayHash;
    if (!checkout.uncapturedEdits) {
      checkout.changedFiles = [];
      return checkout;
    }
    // The diff is only meaningful against the patches the checkout was built
    // from; once those moved, any file list would mix both changes.
    if (!checkout.patchesChangedSinceSync) {
      checkout.changedFiles = await diffAgainstCommitted(input, dest);
    }
    return checkout;
  }

  // No sync record (for example a fresh clone): compare against the cache
  // when it happens to be on disk, otherwise leave the answer unknown.
  const changed = await diffAgainstCommitted(input, dest);
  if (changed != null) {
    checkout.changedFiles = changed;
    checkout.uncapturedEdits = changed.length > 0;
  }
  return checkout;
};

const readUpdate = async function readUpdate(
  cwd: string,
  module: string
): Promise<StatusUpdate | null> {
  if (!isUpdateInProgress(cwd, module)) {
    return null;
  }
  const repoRoot = updateRepoPath(cwd, module);
  let state: Awaited<ReturnType<typeof readUpdateState>> = null;
  try {
    state = await readUpdateState(cwd, module);
  } catch {
    state = null;
  }
  const inspection = await inspectSeriesRebase(
    repoRoot,
    state?.newBase ?? "HEAD"
  ).catch(() => null);
  return {
    conflictedFiles: inspection?.conflictedFiles ?? [],
    fromCommit: state?.oldCommit ?? null,
    inProgress: true,
    readyToContinue:
      existsSync(repoRoot) && (inspection?.unresolvedFiles.length ?? 0) === 0,
    rebaseStopped: inspection?.inProgress ?? false,
    repoPath: nodePath.relative(cwd, repoRoot),
    startedAt: state?.startedAt ?? null,
    stoppedAt: inspection?.stoppedAt ?? null,
    targetCommit: state?.newCommit ?? null,
    targetRef: state?.ref ?? null,
    unresolvedFiles: inspection?.unresolvedFiles ?? [],
  };
};

const conditionOf = function conditionOf(
  lockEntry: LockModule | undefined,
  checkout: StatusCheckout,
  update: StatusUpdate | null
): PackageCondition {
  if (update) {
    return "update-in-progress";
  }
  if (!lockEntry) {
    return "not-locked";
  }
  if (!checkout.present) {
    return "missing";
  }
  if (checkout.uncapturedEdits === true) {
    return checkout.patchesChangedSinceSync === true
      ? "diverged"
      : "uncaptured-edits";
  }
  if (
    checkout.patchesChangedSinceSync === true ||
    (checkout.commit != null && checkout.commit !== lockEntry.commit)
  ) {
    return "needs-sync";
  }
  if (checkout.uncapturedEdits == null) {
    return "unverified";
  }
  return "clean";
};

const nextActionsFor = function nextActionsFor(
  name: string,
  condition: PackageCondition,
  format: StatusPatches["format"]
): string[] {
  switch (condition) {
    case "update-in-progress": {
      return [
        `inrepo update ${name} --continue`,
        `inrepo update ${name} --abort`,
      ];
    }
    case "diverged": {
      return ["inrepo sync --force"];
    }
    case "uncaptured-edits": {
      return [
        format === "overlay"
          ? `inrepo patch ${name}`
          : `inrepo patch ${name} -m "<reason>"`,
        "inrepo sync --force",
      ];
    }
    case "not-locked":
    case "missing":
    case "needs-sync": {
      return ["inrepo sync"];
    }
    case "unverified": {
      return ["inrepo verify"];
    }
    case "clean": {
      return format === "overlay" ? [`inrepo migrate ${name}`] : [];
    }
    default: {
      return [];
    }
  }
};

/** Read-only status of one vendored package. Never fetches or writes. */
export const readPackageStatus = async function readPackageStatus(
  input: StatusInput
): Promise<PackageStatus> {
  const { cwd, pkg, lockEntry } = input;
  const module = pkg.module ?? pkg.name;
  const [patches, checkout, update] = await Promise.all([
    readPatches(cwd, module),
    readCheckout(input),
    readUpdate(cwd, module),
  ]);
  const condition = conditionOf(lockEntry, checkout, update);
  return {
    checkout,
    commit: lockEntry?.commit ?? null,
    condition,
    configured: input.configured,
    dev: pkg.dev === true,
    git: pkg.git ?? lockEntry?.gitUrl ?? null,
    lockedRef: lockEntry?.ref ?? null,
    module,
    name: pkg.name,
    nextActions: nextActionsFor(pkg.name, condition, patches.format),
    patches,
    ref: pkg.ref ?? lockEntry?.ref ?? null,
    repositoryDirectory:
      pkg.repositoryDirectory ?? lockEntry?.repositoryDirectory ?? null,
    update,
  };
};
