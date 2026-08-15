import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { isJsonObject, isString } from "../json/unknown.js";
import {
  seriesDirPath,
  updateDirPath,
  updateSeriesSnapshotPath,
  updateStatePath,
} from "../overlay/overlay-paths.js";
import { copyTree } from "../overlay/tree-utils.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";

/**
 * Everything `inrepo update --continue` / `--abort` needs while an update is
 * still landing. Written under `.inrepo/updates/<package>/` before any
 * committed project write, and removed only after lock, config, and
 * materialize all succeed.
 */
export interface UpdateState {
  name: string;
  gitUrl: string;
  /** Package root within the repository; null means the repository root. */
  repositoryDirectory: string | null;
  /** Commit the package was pinned to when the update started. */
  oldCommit: string;
  /** Commit the series is being rebased onto. */
  newCommit: string;
  /** Ref recorded in config and the lockfile on success; null means default branch. */
  ref: string | null;
  /** True when `--ref` was given, so the new ref should be written to config. */
  persistRef: boolean;
  /** Commit id of the new upstream base inside the scratch repository. */
  newBase: string;
  startedAt: string;
}

const parseUpdateState = function parseUpdateState(
  raw: string,
  path: string
): UpdateState {
  let parsed: unknown;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid update state in ${path}: ${err.message}`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid update state in ${path}: expected an object`);
  }
  const rec = parsed;
  for (const key of [
    "name",
    "gitUrl",
    "oldCommit",
    "newCommit",
    "newBase",
    "startedAt",
  ]) {
    if (!isString(rec[key])) {
      throw new TypeError(
        `Invalid update state in ${path}: missing required field "${key}"`
      );
    }
  }
  if (rec.ref != null && !isString(rec.ref)) {
    throw new Error(
      `Invalid update state in ${path}: "ref" must be a string or null`
    );
  }
  if (
    rec.repositoryDirectory !== undefined &&
    rec.repositoryDirectory != null &&
    !isString(rec.repositoryDirectory)
  ) {
    throw new Error(
      `Invalid update state in ${path}: "repositoryDirectory" must be a string or null`
    );
  }
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return {
    gitUrl: rec.gitUrl as string,
    name: rec.name as string,
    newBase: rec.newBase as string,
    newCommit: rec.newCommit as string,
    oldCommit: rec.oldCommit as string,
    persistRef: rec.persistRef === true,
    ref: rec.ref as string | null,
    repositoryDirectory: isString(rec.repositoryDirectory)
      ? normalizeRepositoryDirectory(
          rec.repositoryDirectory,
          `update state in ${path} repositoryDirectory`
        )
      : null,
    startedAt: rec.startedAt as string,
  };
};

/** True when an update is waiting for `--continue` or `--abort`. */
export const isUpdateInProgress = function isUpdateInProgress(
  cwd: string,
  name: string
): boolean {
  return existsSync(updateStatePath(cwd, name));
};

/** Error when another command cannot run because this package's update is paused. */
export const updateInProgressError = function updateInProgressError(
  cwd: string,
  name: string,
  action?: string
): Error {
  const finish = `Finish it with "inrepo update ${name} --continue" or discard it with "inrepo update ${name} --abort"`;
  return new Error(
    [
      `An update for "${name}" is already in progress in ${nodePath.relative(cwd, updateDirPath(cwd, name))}.`,
      action ? `${finish} before ${action}.` : `${finish}.`,
    ].join("\n")
  );
};

/** Copy the committed series aside so a failed finalize can put it back. */
export const snapshotUpdateSeries = async function snapshotUpdateSeries(
  cwd: string,
  name: string
): Promise<void> {
  const live = seriesDirPath(cwd, name);
  const snap = updateSeriesSnapshotPath(cwd, name);
  await rm(snap, { force: true, recursive: true });
  await mkdir(snap, { recursive: true });
  if (existsSync(live)) {
    await copyTree(live, snap);
  }
};

/**
 * Replace the live series with the snapshot taken before it was rewritten.
 * No-op when no snapshot exists (the series was never replaced).
 */
export const restoreUpdateSeries = async function restoreUpdateSeries(
  cwd: string,
  name: string
): Promise<void> {
  const snap = updateSeriesSnapshotPath(cwd, name);
  if (!existsSync(snap)) {
    return;
  }
  const live = seriesDirPath(cwd, name);
  await rm(live, { force: true, recursive: true });
  if ((await readdir(snap)).length === 0) {
    return;
  }
  await copyTree(snap, live);
};

export const readUpdateState = async function readUpdateState(
  cwd: string,
  name: string
): Promise<UpdateState | null> {
  const path = updateStatePath(cwd, name);
  if (!existsSync(path)) {
    return null;
  }
  return parseUpdateState(await readFile(path, "utf-8"), path);
};

export const writeUpdateState = async function writeUpdateState(
  cwd: string,
  name: string,
  state: UpdateState
): Promise<void> {
  const path = updateStatePath(cwd, name);
  await mkdir(nodePath.dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};

/** Discard an in-progress update, scratch repository included. */
export const clearUpdate = async function clearUpdate(
  cwd: string,
  name: string
): Promise<void> {
  await rm(updateDirPath(cwd, name), { force: true, recursive: true });
};
