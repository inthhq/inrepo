import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import {
  seriesDirPath,
  updateDirPath,
  updateSeriesSnapshotPath,
  updateStatePath,
} from '../overlay/overlay-paths.js';
import { copyTree } from '../overlay/tree-utils.js';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';

/**
 * Everything `inrepo update --continue` / `--abort` needs while an update is
 * still landing. Written under `.inrepo/updates/<package>/` before any
 * committed project write, and removed only after lock, config, and
 * materialize all succeed.
 */
export type UpdateState = {
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
};

function parseUpdateState(raw: string, path: string): UpdateState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid update state in ${path}: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid update state in ${path}: expected an object`);
  }
  const rec = parsed as Record<string, unknown>;
  for (const key of ['name', 'gitUrl', 'oldCommit', 'newCommit', 'newBase', 'startedAt']) {
    if (typeof rec[key] !== 'string') {
      throw new Error(`Invalid update state in ${path}: missing required field "${key}"`);
    }
  }
  if (rec.ref !== null && typeof rec.ref !== 'string') {
    throw new Error(`Invalid update state in ${path}: "ref" must be a string or null`);
  }
  if (
    rec.repositoryDirectory !== undefined &&
    rec.repositoryDirectory !== null &&
    typeof rec.repositoryDirectory !== 'string'
  ) {
    throw new Error(
      `Invalid update state in ${path}: "repositoryDirectory" must be a string or null`,
    );
  }
  return {
    name: rec.name as string,
    gitUrl: rec.gitUrl as string,
    repositoryDirectory:
      typeof rec.repositoryDirectory === 'string'
        ? normalizeRepositoryDirectory(
            rec.repositoryDirectory,
            `update state in ${path} repositoryDirectory`,
          )
        : null,
    oldCommit: rec.oldCommit as string,
    newCommit: rec.newCommit as string,
    ref: rec.ref as string | null,
    persistRef: rec.persistRef === true,
    newBase: rec.newBase as string,
    startedAt: rec.startedAt as string,
  };
}

/** True when an update is waiting for `--continue` or `--abort`. */
export function isUpdateInProgress(cwd: string, name: string): boolean {
  return existsSync(updateStatePath(cwd, name));
}

/** Error when another command cannot run because this package's update is paused. */
export function updateInProgressError(cwd: string, name: string, action?: string): Error {
  const finish = `Finish it with "inrepo update ${name} --continue" or discard it with "inrepo update ${name} --abort"`;
  return new Error(
    [
      `An update for "${name}" is already in progress in ${relative(cwd, updateDirPath(cwd, name))}.`,
      action ? `${finish} before ${action}.` : `${finish}.`,
    ].join('\n'),
  );
}

/** Copy the committed series aside so a failed finalize can put it back. */
export async function snapshotUpdateSeries(cwd: string, name: string): Promise<void> {
  const live = seriesDirPath(cwd, name);
  const snap = updateSeriesSnapshotPath(cwd, name);
  await rm(snap, { recursive: true, force: true });
  await mkdir(snap, { recursive: true });
  if (existsSync(live)) await copyTree(live, snap);
}

/**
 * Replace the live series with the snapshot taken before it was rewritten.
 * No-op when no snapshot exists (the series was never replaced).
 */
export async function restoreUpdateSeries(cwd: string, name: string): Promise<void> {
  const snap = updateSeriesSnapshotPath(cwd, name);
  if (!existsSync(snap)) return;
  const live = seriesDirPath(cwd, name);
  await rm(live, { recursive: true, force: true });
  if ((await readdir(snap)).length === 0) return;
  await copyTree(snap, live);
}

export async function readUpdateState(cwd: string, name: string): Promise<UpdateState | null> {
  const path = updateStatePath(cwd, name);
  if (!existsSync(path)) return null;
  return parseUpdateState(await readFile(path, 'utf8'), path);
}

export async function writeUpdateState(
  cwd: string,
  name: string,
  state: UpdateState,
): Promise<void> {
  const path = updateStatePath(cwd, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Discard an in-progress update, scratch repository included. */
export async function clearUpdate(cwd: string, name: string): Promise<void> {
  await rm(updateDirPath(cwd, name), { recursive: true, force: true });
}
