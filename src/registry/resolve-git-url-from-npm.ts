import { fetchPackument } from './fetch-packument.js';
import { normalizeGithubHttpsUrl } from './normalize-github-https-url.js';
import { normalizeRepositoryDirectory } from './normalize-repository-directory.js';

export type RepositorySource = {
  gitUrl: string;
  repositoryDirectory: string | null;
};

/** Read an npm `repository` value without imposing a hosting-provider policy. */
export function repositoryToSource(repository: unknown): RepositorySource | null {
  if (repository == null) return null;
  if (typeof repository === 'string') {
    return { gitUrl: repository, repositoryDirectory: null };
  }
  if (typeof repository !== 'object' || !('url' in repository)) return null;
  const rec = repository as { url?: unknown; directory?: unknown };
  if (typeof rec.url !== 'string') return null;
  if (rec.directory != null && typeof rec.directory !== 'string') {
    throw new Error('repository.directory must be a string when set');
  }
  return {
    gitUrl: rec.url,
    repositoryDirectory:
      typeof rec.directory === 'string'
        ? normalizeRepositoryDirectory(rec.directory)
        : null,
  };
}

export function repositoryToUrl(repository: unknown): string | null {
  return repositoryToSource(repository)?.gitUrl ?? null;
}

/**
 * Resolve npm package name to its GitHub checkout plus package root using the
 * public registry.
 */
export async function resolvePackageSourceFromNpm(packageName: string): Promise<RepositorySource> {
  const data = await fetchPackument(packageName);

  let repo = repositoryToSource(data.repository);
  if (!repo) {
    const distTags = data['dist-tags'];
    const versions = data.versions;
    const latest = distTags?.latest;
    if (latest && versions?.[latest]) {
      repo = repositoryToSource(versions[latest].repository);
    }
  }
  if (!repo) {
    throw new Error(
      `No "repository" field for "${packageName}" on the npm registry. Set "git" in inrepo config.`,
    );
  }

  const normalized = normalizeGithubHttpsUrl(repo.gitUrl);
  if (!normalized) {
    throw new Error(
      `Could not normalize repository URL to GitHub HTTPS for "${packageName}": ${repo.gitUrl}`,
    );
  }
  return { gitUrl: normalized, repositoryDirectory: repo.repositoryDirectory };
}

/** Compatibility wrapper for callers that only need the clone URL. */
export async function resolveGitUrlFromNpm(packageName: string): Promise<string> {
  return (await resolvePackageSourceFromNpm(packageName)).gitUrl;
}
