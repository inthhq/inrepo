import nodePath from "node:path";

export const packageJsonPath = function packageJsonPath(cwd: string): string {
  return nodePath.join(cwd, "package.json");
};
