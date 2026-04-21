/**
 * Normalize various GitHub URL forms to https://github.com/org/repo.git
 */
export function normalizeGithubHttpsUrl(raw: string): string | null {
  if (!raw) return null;
  let u = raw.trim();
  u = u.replace(/^git\+/i, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(u);
  if (ssh) {
    return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}.git`;
  }
  const sshSlash = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(u);
  if (sshSlash) {
    return `https://github.com/${sshSlash[1]}/${sshSlash[2].replace(/\.git$/i, '')}.git`;
  }
  const short = /^github:([^/]+)\/(.+)$/i.exec(u);
  if (short) {
    return `https://github.com/${short[1]}/${short[2].replace(/\.git$/i, '')}.git`;
  }
  try {
    const parsed = new URL(u);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const org = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    return `https://github.com/${org}/${repo}.git`;
  } catch {
    return null;
  }
}
