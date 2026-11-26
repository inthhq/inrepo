import nodePath from "node:path";

/**
 * The configured mirror target as git should see it from a scratch
 * repository: URLs (`scheme://`, `host:path`) as written, filesystem paths
 * resolved against the config directory.
 */
export const resolveTargetUrl = function resolveTargetUrl(
  configDir: string,
  git: string
): string {
  if (nodePath.isAbsolute(git) || git.includes("://")) {
    return git;
  }
  const colon = git.indexOf(":");
  const slash = git.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return git;
  }
  return nodePath.resolve(configDir, git);
};
