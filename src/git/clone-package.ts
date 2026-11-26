import { InrepoError } from "../cli/errors.js";
import type { JsonObject } from "../json/unknown.js";
import { runGitCapture } from "./run-git-capture.js";
import { runGit } from "./run-git.js";

const looksLikeSha = function looksLikeSha(ref: string): boolean {
  return ref.length >= 7 && ref.length <= 40 && /^[0-9a-f]+$/iu.test(ref);
};

export interface ClonePackageOptions {
  dest: string;
  gitUrl: string;
  ref?: string;
}

/** True when git itself could not be started (not installed / not on PATH). */
export const isGitSpawnFailure = function isGitSpawnFailure(
  error: Error
): boolean {
  return (
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "ENOENT"
  );
};

/**
 * Re-tag a failed network-facing git command (clone, fetch, ls-remote) as
 * `UPSTREAM_UNAVAILABLE`, keeping the git message. A missing git binary is a
 * local problem and passes through unchanged.
 */
export const asUpstreamGitError = function asUpstreamGitError(
  error: Error,
  details: { url: string; ref?: string | null }
): Error {
  if (error instanceof InrepoError || isGitSpawnFailure(error)) {
    return error;
  }
  const payload: JsonObject = { url: details.url };
  if (details.ref != null && details.ref !== "") {
    payload.ref = details.ref;
  }
  return new InrepoError("UPSTREAM_UNAVAILABLE", error.message, {
    cause: error,
    details: payload,
    hint: "Check the git URL and ref, your network, and git credentials, then retry.",
  });
};

const fetchIntoDest = async function fetchIntoDest({
  dest,
  gitUrl,
  ref,
}: ClonePackageOptions): Promise<void> {
  const shallowArgs = ["--depth", "1"];

  if (!ref) {
    await runGit(["clone", ...shallowArgs, gitUrl, dest]);
  } else if (looksLikeSha(ref)) {
    await runGit(["init", dest]);
    await runGit(["remote", "add", "origin", gitUrl], { cwd: dest });
    await runGit(["fetch", ...shallowArgs, "origin", ref], { cwd: dest });
    await runGit(["checkout", "FETCH_HEAD"], { cwd: dest });
  } else {
    await runGit(["clone", ...shallowArgs, "--branch", ref, gitUrl, dest]);
  }
};

/**
 * Clone a git repository into dest and return resolved HEAD + origin URL.
 * Clone/fetch failures throw `UPSTREAM_UNAVAILABLE` with `details.url`.
 */
export const clonePackage = async function clonePackage({
  dest,
  gitUrl,
  ref,
}: ClonePackageOptions): Promise<{ commit: string; originUrl: string }> {
  try {
    await fetchIntoDest({ dest, gitUrl, ref });
  } catch (error) {
    throw asUpstreamGitError(
      error instanceof Error ? error : new Error(String(error)),
      { ref, url: gitUrl }
    );
  }

  const commit = await runGitCapture(["rev-parse", "HEAD"], { cwd: dest });
  const originUrl = await runGitCapture(["remote", "get-url", "origin"], {
    cwd: dest,
  });
  if (!/^[0-9a-f]{40}$/iu.test(commit)) {
    throw new Error(`Unexpected commit format from git rev-parse: ${commit}`);
  }
  return { commit: commit.toLowerCase(), originUrl };
};
