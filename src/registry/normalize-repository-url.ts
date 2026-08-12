import { isAbsolute } from 'node:path';
import { normalizeGithubHttpsUrl } from './normalize-github-https-url.js';

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[^@\s]+@[^:/\s]+:.+$/;
const GITHUB_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9_.-]+$/;

function isGithubOwnerRepo(value: string): boolean {
  const parts = value.replace(/\.git$/i, '').split('/');
  return parts.length === 2 && parts.every((part) => GITHUB_SEGMENT.test(part));
}

/**
 * Normalize an npm `repository` field to something git can clone.
 *
 * Wider than {@link normalizeGithubHttpsUrl}: dependency resolution accepts any
 * clone URL the registry advertises (GitHub shorthand, plain HTTPS/SSH, or a
 * local path for mirrors), because a dependency's repository is not something
 * the user can hand-correct without vendoring it separately. Shorthand forms
 * that are not GitHub (`owner/repo`, `gist:id`) stay unresolvable.
 */
export function normalizeRepositoryUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/^git\+/i, '');
  if (!trimmed) return null;

  const github = normalizeGithubHttpsUrl(trimmed);
  if (github) return github;

  // npm metadata in the wild sometimes uses the historical `owner/repo`
  // shorthand without a `github:` prefix (for example nypm). Keep this strict:
  // exactly two safe path segments, with no ref, query, or traversal syntax.
  if (isGithubOwnerRepo(trimmed)) {
    const withoutSuffix = trimmed.replace(/\.git$/i, '');
    return `https://github.com/${withoutSuffix}.git`;
  }

  if (URL_SCHEME.test(trimmed)) return trimmed;
  if (SCP_LIKE.test(trimmed)) return trimmed;
  if (isAbsolute(trimmed)) return trimmed;
  return null;
}
