import { parseExcludeEntries } from "../git/apply-vendor-excludes.js";
import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
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

const validateMirror = function validateMirror(
  entry: JsonValue,
  label: string
): InrepoMirror {
  if (!isJsonObject(entry)) {
    throw new Error(`${label} must be an object`);
  }
  const mirror: InrepoMirror = {
    branch: "main",
    exclude: validateExcludeList(entry.exclude, `${label}.exclude`),
    git: requiredString(entry.git, `${label}.git`),
    keep: validateKeepList(entry.keep, `${label}.keep`),
    name: requiredString(entry.name, `${label}.name`),
  };
  // Fail at load time, not halfway through a mirror run, on a bad pattern.
  parseExcludeEntries(mirror.exclude);
  if (entry.branch != null) {
    mirror.branch = requiredString(entry.branch, `${label}.branch`);
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
  label: string
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
  for (const mirror of mirrors) {
    if (seen.has(mirror.name)) {
      throw new Error(
        `${label} has more than one mirror named "${mirror.name}"`
      );
    }
    seen.add(mirror.name);
  }
  return mirrors;
};
