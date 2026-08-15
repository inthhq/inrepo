import nodePath from "node:path";

export const inrepoConfigPath = function inrepoConfigPath(cwd: string): string {
  return nodePath.join(cwd, "inrepo.json");
};
