import nodePath from "node:path";

export const lockfilePath = function lockfilePath(cwd: string): string {
  return nodePath.join(cwd, "inrepo.lock.json");
};
