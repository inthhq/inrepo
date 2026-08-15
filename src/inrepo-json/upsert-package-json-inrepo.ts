import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonObject, JsonValue } from "../json/unknown.js";
import { packageJsonPath } from "../paths/package-json-path.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type { InrepoJsonEntry } from "./upsert-inrepo-json.js";

interface InrepoData {
  packages: JsonObject[];
  exclude?: JsonValue;
  keep?: JsonValue;
  /** Object.keys order from object-shaped config (stable round-trip, includes unknown keys). */
  fullKeyOrder?: string[];
  /** Shallow snapshot of the parsed root object (object form only); preserves unknown top-level keys. */
  rootSnapshot?: JsonObject;
}

const parseExistingInrepo = function parseExistingInrepo(
  existing: JsonValue | undefined
): InrepoData {
  if (existing == null) {
    return { packages: [] };
  }
  if (Array.isArray(existing)) {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    return { packages: existing as JsonObject[] };
  }
  if (isJsonObject(existing) && Array.isArray(existing.packages)) {
    // SAFETY: packages is a JSON array of package objects from on-disk config.
    const packages = existing.packages as JsonObject[];
    const data: InrepoData = {
      fullKeyOrder: Object.keys(existing),
      packages,
      rootSnapshot: { ...existing },
    };
    if ("exclude" in existing) {
      data.exclude = existing.exclude;
    }
    if ("keep" in existing) {
      data.keep = existing.keep;
    }
    return data;
  }
  throw new Error(
    'package.json "inrepo" must be a JSON array or an object with a "packages" array'
  );
};

/** Upsert a package entry into package.json#inrepo (preserves other package.json keys). */
export const upsertPackageJsonInrepo = async function upsertPackageJsonInrepo(
  cwd: string,
  entry: InrepoJsonEntry
): Promise<void> {
  const path = packageJsonPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      "package.json not found; create it or use a project root that contains package.json."
    );
  }
  const raw = await readFile(path, "utf-8");
  let pkg: JsonObject;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    pkg = JSON.parse(raw) as JsonObject;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid package.json: ${err.message}`, { cause: error });
  }
  if (!isJsonObject(pkg)) {
    throw new Error("package.json must contain a JSON object");
  }

  const data = parseExistingInrepo(pkg.inrepo);

  const identity = entry.module ?? entry.name;
  const ix = data.packages.findIndex((p) => {
    if (!isJsonObject(p)) {
      return false;
    }
    return (isString(p.module) ? p.module : p.name) === identity;
  });
  const next: JsonObject = { name: entry.name };
  if (entry.module) {
    next.module = entry.module;
  }
  if (entry.git) {
    next.git = entry.git;
  }
  if (entry.ref) {
    next.ref = entry.ref;
  }
  const repositoryDirectory = isString(entry.repositoryDirectory)
    ? normalizeRepositoryDirectory(
        entry.repositoryDirectory,
        "repositoryDirectory"
      )
    : entry.repositoryDirectory;
  if (repositoryDirectory != null) {
    next.repositoryDirectory = repositoryDirectory;
  }

  if (ix === -1) {
    if (entry.dev === true) {
      next.dev = true;
    }
    data.packages.push(next);
  } else {
    const merged = { ...data.packages[ix], ...next };
    if (entry.repositoryDirectory === null || repositoryDirectory === null) {
      delete merged.repositoryDirectory;
    }
    if (entry.dev === true) {
      merged.dev = true;
    } else {
      delete merged.dev;
    }
    data.packages[ix] = merged;
  }

  let out: JsonObject;
  if (data.fullKeyOrder && data.rootSnapshot) {
    out = {};
    for (const k of data.fullKeyOrder) {
      if (k === "packages") {
        out.packages = data.packages;
      } else if (k === "exclude" && data.exclude !== undefined) {
        out.exclude = data.exclude;
      } else if (k === "keep" && data.keep !== undefined) {
        out.keep = data.keep;
      } else {
        out[k] = data.rootSnapshot[k];
      }
    }
  } else {
    out = { packages: data.packages };
    if (data.exclude !== undefined) {
      out.exclude = data.exclude;
    }
    if (data.keep !== undefined) {
      out.keep = data.keep;
    }
  }
  pkg.inrepo = out;

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
};
