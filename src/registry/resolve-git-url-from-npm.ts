import { fetchPackument } from './fetch-packument.js';
import { normalizeGithubHttpsUrl } from './normalize-github-https-url.js';

export function repositoryToUrl(repository: unknown): string | null {
  if (repository == null) return null;
  if (typeof repository === 'string') return repository;
  if (typeof repository === 'object' && repository !== null && 'url' in repository) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return null;
}

/**
 * Resolve npm package name to a GitHub HTTPS clone URL using the public registry.
 */
export async function resolveGitUrlFromNpm(packageName: string): Promise<string> {
  const data = await fetchPackument(packageName);

  let repo = repositoryToUrl(data.repository);
  if (!repo) {
    const distTags = data['dist-tags'];
    const versions = data.versions;
    const latest = distTags?.latest;
    if (latest && versions?.[latest]) {
      repo = repositoryToUrl(versions[latest].repository);
    }
  }
  if (!repo) {
    throw new Error(
      `No "repository" field for "${packageName}" on the npm registry. Set "git" in inrepo config.`,
    );
  }

  const normalized = normalizeGithubHttpsUrl(repo);
  if (!normalized) {
    throw new Error(
      `Could not normalize repository URL to GitHub HTTPS for "${packageName}": ${repo}`,
    );
  }
  return normalized;
}
