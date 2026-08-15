import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";

/** Runtime dependency name → version range from package.json. */
export interface PackageDependencyMap {
  [name: string]: string;
}

/** The parts of a package's own package.json that dependency vendoring needs. */
export interface PackageManifest {
  name: string | null;
  version: string | null;
  /** Runtime `dependencies` only; dev and peer dependencies are never vendored. */
  dependencies: PackageDependencyMap;
}

const stringRecord = function stringRecord(
  raw: JsonValue | undefined
): PackageDependencyMap {
  if (!isJsonObject(raw)) {
    return {};
  }
  const out: PackageDependencyMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isString(value)) {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Read `<dir>/package.json`. Returns null when the file is absent, which is a
 * legitimate outcome for a checkout narrowed by `keep` or `exclude`.
 */
export const readPackageManifest = async function readPackageManifest(
  dir: string
): Promise<PackageManifest | null> {
  const path = nodePath.join(dir, "package.json");
  if (!existsSync(path)) {
    return null;
  }
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse produces a JSON value from file contents.
    parsed = JSON.parse(await readFile(path, "utf-8")) as JsonValue;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid package.json in ${dir}: ${err.message}`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    return null;
  }
  return {
    dependencies: stringRecord(parsed.dependencies),
    name: isString(parsed.name) ? parsed.name : null,
    version: isString(parsed.version) ? parsed.version : null,
  };
};
