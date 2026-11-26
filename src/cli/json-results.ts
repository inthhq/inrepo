import nodePath from "node:path";

import type { StagedFileChange } from "../series/series-git.js";
import type { FileChange, FileChangeStat } from "./types.js";

/** POSIX path of `absolute` relative to the project root, for JSON output. */
export const projectRelativePath = function projectRelativePath(
  cwd: string,
  absolute: string
): string {
  return nodePath.relative(cwd, absolute).split(nodePath.sep).join("/");
};

export const toFileChanges = function toFileChanges(
  files: StagedFileChange[]
): FileChange[] {
  return files.map((file) => ({ path: file.path, status: file.status }));
};

export const toFileChangeStats = function toFileChangeStats(
  files: StagedFileChange[]
): FileChangeStat[] {
  return files.map((file) => ({
    additions: file.additions,
    deletions: file.deletions,
    path: file.path,
    status: file.status,
  }));
};
