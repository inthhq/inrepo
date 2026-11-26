import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
import { resolveTargetUrl } from "../mirror/resolve-target-url.js";
import { selectMirrorPaths } from "../mirror/select-mirror-paths.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type { InrepoMirror } from "../types/inrepo-mirror.js";
import { validateExcludeList } from "./validate-exclude-list.js";
import { validateKeepList } from "./validate-keep-list.js";

const requiredString = function requiredString(
  raw: JsonValue | undefined,
  label: string
): string {
  if (!isString(raw) || !raw.trim()) {
    throw new Error(`${label} is required and must be a non-empty string`);
  }
  return raw.trim();
};

/**
 * Reject path spellings that the shared keep/exclude validators would quietly
 * rewrite (surrounding whitespace is trimmed, `\\` becomes `/` in keep), so a
 * mirror never filters a different path than the one written in config.
 */
const assertExactPaths = function assertExactPaths(
  raw: JsonValue | undefined,
  label: string,
  allowRegex: boolean
): void {
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (!isString(value)) {
      continue;
    }
    const isRegex = allowRegex && value.startsWith("/");
    // Every path segment, not just the whole entry: "src /" would otherwise
    // lose its trailing slash and then its space, and select "src".
    const segments = isRegex ? [value] : value.split("/");
    if (segments.some((segment) => segment !== segment.trim())) {
      throw new Error(
        `${label} entry ${JSON.stringify(value)} must not have whitespace at the start or end of a path segment`
      );
    }
    if (!isRegex && value.includes("\\")) {
      throw new Error(
        `${label} entry ${JSON.stringify(value)} must use POSIX "/" separators`
      );
    }
  }
};

/**
 * Compare targets the way publishing resolves them: `./a/`, `a`, and the
 * absolute path to `a` are the same repository.
 */
const targetKey = function targetKey(git: string, configDir: string): string {
  return resolveTargetUrl(configDir, git.replace(/\/+$/u, ""));
};

const validateMirror = function validateMirror(
  entry: JsonValue,
  label: string
): InrepoMirror {
  if (!isJsonObject(entry)) {
    throw new Error(`${label} must be an object`);
  }
  if (Array.isArray(entry.keep) && entry.keep.length === 0) {
    throw new Error(
      `${label}.keep must list at least one path when set; omit it to publish the whole directory`
    );
  }
  assertExactPaths(entry.keep, `${label}.keep`, false);
  assertExactPaths(entry.exclude, `${label}.exclude`, true);
  assertExactPaths(entry.directory, `${label}.directory`, false);
  const mirror: InrepoMirror = {
    branch: "main",
    exclude: validateExcludeList(entry.exclude, `${label}.exclude`),
    git: requiredString(entry.git, `${label}.git`),
    keep: validateKeepList(entry.keep, `${label}.keep`),
    name: requiredString(entry.name, `${label}.name`),
  };
  // Fail at load time, not halfway through a mirror run, on a bad pattern.
  selectMirrorPaths([], mirror.keep, mirror.exclude);
  if (mirror.git.startsWith("-")) {
    throw new Error(`${label}.git must be a repository URL or path`);
  }
  if (entry.branch != null) {
    mirror.branch = requiredString(entry.branch, `${label}.branch`);
    if (mirror.branch.startsWith("-") || mirror.branch.startsWith("refs/")) {
      throw new Error(
        `${label}.branch must be a branch name such as "main", not a full ref`
      );
    }
  }
  if (entry.directory != null) {
    if (!isString(entry.directory)) {
      throw new TypeError(`${label}.directory must be a string when set`);
    }
    const directory = normalizeRepositoryDirectory(
      entry.directory,
      `${label}.directory`
    );
    if (directory != null) {
      mirror.directory = directory;
    }
  }
  return mirror;
};

/** Validate the optional `mirrors` array of an inrepo config object. */
export const validateMirrors = function validateMirrors(
  raw: JsonValue | undefined,
  label: string,
  /** Directory relative target paths resolve against; defaults to the process cwd. */
  configDir = process.cwd()
): InrepoMirror[] {
  if (raw == null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TypeError(`${label} must be an array when set`);
  }
  const mirrors = raw.map((entry, i) =>
    validateMirror(entry, `${label}[${i}]`)
  );
  const seen = new Set<string>();
  const targets = new Map<string, string>();
  for (const mirror of mirrors) {
    if (seen.has(mirror.name)) {
      throw new Error(
        `${label} has more than one mirror named "${mirror.name}"`
      );
    }
    seen.add(mirror.name);
    // Two mirrors on one branch would each replace the other's files.
    const target = `${targetKey(mirror.git, configDir)}\n${mirror.branch}`;
    const other = targets.get(target);
    if (other != null) {
      throw new Error(
        `${label}: mirrors "${other}" and "${mirror.name}" both publish to branch "${mirror.branch}" of the same repository`
      );
    }
    targets.set(target, mirror.name);
  }
  return mirrors;
};
