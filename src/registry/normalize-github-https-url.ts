/**
 * Normalize various GitHub URL forms to https://github.com/org/repo.git
 */
export const normalizeGithubHttpsUrl = function normalizeGithubHttpsUrl(
  raw: string
): string | null {
  if (!raw) {
    return null;
  }
  let u = raw.trim();
  u = u.replace(/^git\+/iu, "");
  const ssh = /^git@github\.com:(?<g1>[^/]+)\/(?<g2>.+?)(?:\.git)?$/iu.exec(u);
  if (ssh) {
    return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/iu, "")}.git`;
  }
  const sshSlash =
    /^ssh:\/\/git@github\.com\/(?<g1>[^/]+)\/(?<g2>.+?)(?:\.git)?$/iu.exec(u);
  if (sshSlash) {
    return `https://github.com/${sshSlash[1]}/${sshSlash[2].replace(/\.git$/iu, "")}.git`;
  }
  const short = /^github:(?<g1>[^/]+)\/(?<g2>.+)$/iu.exec(u);
  if (short) {
    return `https://github.com/${short[1]}/${short[2].replace(/\.git$/iu, "")}.git`;
  }
  try {
    const parsed = new URL(u);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const parts = parsed.pathname
      .replace(/^\/+/u, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const [org, repoName] = parts;
    const repo = repoName.replace(/\.git$/iu, "");
    return `https://github.com/${org}/${repo}.git`;
  } catch {
    return null;
  }
};
