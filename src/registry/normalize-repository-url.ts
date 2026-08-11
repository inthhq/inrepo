import { isAbsolute } from 'node:path';
import { normalizeGithubHttpsUrl } from './normalize-github-https-url.js';

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[^@\s]+@[^:/\s]+:.+$/;

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

  if (URL_SCHEME.test(trimmed)) return trimmed;
  if (SCP_LIKE.test(trimmed)) return trimmed;
  if (isAbsolute(trimmed)) return trimmed;
  return null;
}
