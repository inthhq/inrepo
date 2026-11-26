import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
import { targetIdentity } from "../mirror/resolve-target-url.js";
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

const validateMirror = function validateMirror(
  entry: JsonValue,
  label: string
): InrepoMirror {
  if (!isJsonObject(entry)) {
    throw new Error(`${label} must be an object`);
  }
  // A present-but-null exclude would otherwise mean "exclude nothing".
  if (Object.hasOwn(entry, "exclude") && !Array.isArray(entry.exclude)) {
    throw new TypeError(
      `${label}.exclude must be an array of strings when set`
    );
  }
  // An omitted keep publishes the whole directory; a present one must narrow it.
  if (
    Object.hasOwn(entry, "keep") &&
    (!Array.isArray(entry.keep) || entry.keep.length === 0)
  ) {
    throw new Error(
      `${label}.keep must list at least one path when set; omit it to publish the whole directory`
    );
  }
  assertExactPaths(entry.keep, `${label}.keep`, false);
  assertExactPaths(entry.exclude, `${label}.exclude`, true);
  assertExactPaths(entry.directory, `${label}.directory`, false);
  // git and branch are passed to git verbatim; a trimmed copy could name a
  // different repository ("sdk.git " vs "sdk.git").
  for (const field of ["git", "branch"] as const) {
    const value = entry[field];
    if (isString(value) && value !== value.trim()) {
      throw new Error(
        `${label}.${field} must not start or end with whitespace`
      );
    }
  }
  const mirror: InrepoMirror = {
    branch: "main",
    exclude: validateExcludeList(entry.exclude, `${label}.exclude`),
    git: requiredString(entry.git, `${label}.git`),
    keep: validateKeepList(entry.keep, `${label}.keep`),
    name: requiredString(entry.name, `${label}.name`),
  };
  // The name goes into a commit trailer as "<name>@<config dir hash>".
  const breaksTrailer = [...mirror.name].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return ch === ":" || code < 0x20 || code === 0x7f;
  });
  if (breaksTrailer) {
    throw new Error(
      `${label}.name must not contain ":" or control characters such as line breaks`
    );
  }
  // Fail at load time, not halfway through a mirror run, on a bad pattern.
  selectMirrorPaths([], mirror.keep, mirror.exclude);
  if (mirror.git.startsWith("-")) {
    throw new Error(`${label}.git must be a repository URL or path`);
  }
  if (Object.hasOwn(entry, "branch")) {
    mirror.branch = requiredString(entry.branch, `${label}.branch`);
    if (mirror.branch.startsWith("-") || mirror.branch.startsWith("refs/")) {
      throw new Error(
        `${label}.branch must be a branch name such as "main", not a full ref`
      );
    }
  }
  if (Object.hasOwn(entry, "directory")) {
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
    const target = `${targetIdentity(configDir, mirror.git)}\n${mirror.branch}`;
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
