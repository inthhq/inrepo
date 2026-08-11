import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { updateDirPath, updateStatePath } from '../overlay/overlay-paths.js';

/**
 * Everything `inrepo update --continue` needs to finish an update whose rebase
 * stopped on a conflict. It is written next to the scratch repository under
 * `.inrepo/updates/<package>/` and removed once the update lands.
 */
export type UpdateState = {
  name: string;
  gitUrl: string;
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
  return {
    name: rec.name as string,
    gitUrl: rec.gitUrl as string,
    oldCommit: rec.oldCommit as string,
    newCommit: rec.newCommit as string,
    ref: rec.ref as string | null,
    persistRef: rec.persistRef === true,
    newBase: rec.newBase as string,
    startedAt: rec.startedAt as string,
  };
}

/** True when a conflicted update is waiting for `--continue` or `--abort`. */
export function isUpdateInProgress(cwd: string, name: string): boolean {
  return existsSync(updateStatePath(cwd, name));
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
