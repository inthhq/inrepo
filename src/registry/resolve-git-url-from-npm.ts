import type { JsonValue } from "../json/unknown.js";
import { isJsonObject, isString } from "../json/unknown.js";
import { fetchPackument } from "./fetch-packument.js";
import { normalizeGithubHttpsUrl } from "./normalize-github-https-url.js";
import { normalizeRepositoryDirectory } from "./normalize-repository-directory.js";

export interface RepositorySource {
  gitUrl: string;
  repositoryDirectory: string | null;
}

/** Read an npm `repository` value without imposing a hosting-provider policy. */
export const repositoryToSource = function repositoryToSource(
  repository: JsonValue | undefined
): RepositorySource | null {
  if (repository == null) {
    return null;
  }
  if (isString(repository)) {
    return { gitUrl: repository, repositoryDirectory: null };
  }
  if (!isJsonObject(repository) || !("url" in repository)) {
    return null;
  }
  if (!isString(repository.url)) {
    return null;
  }
  if (repository.directory != null && !isString(repository.directory)) {
    throw new Error("repository.directory must be a string when set");
  }
  return {
    gitUrl: repository.url,
    repositoryDirectory: isString(repository.directory)
      ? normalizeRepositoryDirectory(repository.directory)
      : null,
  };
};

export const repositoryToUrl = function repositoryToUrl(
  repository: JsonValue | undefined
): string | null {
  return repositoryToSource(repository)?.gitUrl ?? null;
};

/**
 * Resolve npm package name to its GitHub checkout plus package root using the
 * public registry.
 */
export const resolvePackageSourceFromNpm =
  async function resolvePackageSourceFromNpm(
    packageName: string
  ): Promise<RepositorySource> {
    const data = await fetchPackument(packageName);

    let repo = repositoryToSource(data.repository);
    if (!repo) {
      const distTags = data["dist-tags"];
      const { versions } = data;
      const latest = distTags?.latest;
      if (latest && versions?.[latest]) {
        repo = repositoryToSource(versions[latest].repository);
      }
    }
    if (!repo) {
      throw new Error(
        `No "repository" field for "${packageName}" on the npm registry. Set "git" in inrepo config.`
      );
    }

    const normalized = normalizeGithubHttpsUrl(repo.gitUrl);
    if (!normalized) {
      throw new Error(
        `Could not normalize repository URL to GitHub HTTPS for "${packageName}": ${repo.gitUrl}`
      );
    }
    return {
      gitUrl: normalized,
      repositoryDirectory: repo.repositoryDirectory,
    };
  };

/** Compatibility wrapper for callers that only need the clone URL. */
export const resolveGitUrlFromNpm = async function resolveGitUrlFromNpm(
  packageName: string
): Promise<string> {
  return (await resolvePackageSourceFromNpm(packageName)).gitUrl;
};
