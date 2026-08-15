import { normalizeGithubHttpsUrl } from "./normalize-github-https-url.js";

/** Canonical identity used to compare and content-address clone URLs. */
export const normalizeRepositoryUrlIdentity =
  function normalizeRepositoryUrlIdentity(
    raw: string | undefined | null
  ): string | null {
    if (!raw?.trim()) {
      return null;
    }

    const trimmed = raw.trim().replace(/^git\+/iu, "");
    const github = normalizeGithubHttpsUrl(trimmed);
    if (github) {
      return github;
    }

    const hasUrlScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);
    const scpLike = hasUrlScheme
      ? null
      : /^(?<user>[^@]+@)?(?<host>[^:/]+):(?<path>.+)$/u.exec(trimmed);
    if (scpLike?.groups) {
      const user = scpLike.groups.user ?? "";
      const host = scpLike.groups.host.toLowerCase();
      const path = scpLike.groups.path.replace(/\.git$/iu, "");
      return `${user}${host}:${path}`;
    }

    try {
      const parsed = new URL(trimmed);
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname.replace(/\.git$/iu, "");
      const normalized = parsed.toString();
      return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    } catch {
      return trimmed.replace(/\.git$/iu, "");
    }
  };
