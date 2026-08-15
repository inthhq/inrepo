import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { isJsonObject, isString } from "../json/unknown.js";
import type { JsonObject, JsonValue } from "../json/unknown.js";
import { inrepoConfigPath } from "../paths/inrepo-config-path.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import { defaultInrepoJsonSchemaRef } from "./default-inrepo-json-schema-ref.js";

export interface InrepoJsonEntry {
  name: string;
  module?: string;
  git?: string;
  /** null explicitly clears a previously recorded package subdirectory. */
  repositoryDirectory?: string | null;
  ref?: string;
  dev?: boolean;
}

interface InrepoFileData {
  packages: JsonObject[];
  exclude?: JsonValue;
  keep?: JsonValue;
  /** Set when the file had a non-empty string `$schema` (trimmed). */
  schemaRef?: string;
  /** Object.keys order from object-shaped config (stable round-trip, includes unknown keys). */
  fullKeyOrder?: string[];
  /** Shallow snapshot of the parsed root object (object form only); preserves unknown top-level keys. */
  rootSnapshot?: JsonObject;
}

/** Upsert a package entry into inrepo.json. Adds `$schema` at the end when the file did not already define it. */
export const upsertInrepoJson = async function upsertInrepoJson(
  cwd: string,
  entry: InrepoJsonEntry
): Promise<void> {
  const path = inrepoConfigPath(cwd);
  let data: InrepoFileData = {
    packages: [],
  };

  if (existsSync(path)) {
    const raw = await readFile(path, "utf-8");
    if (raw.trim()) {
      let parsed: unknown;
      try {
        // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Invalid JSON in inrepo.json: ${err.message}`, {
          cause: error,
        });
      }
      if (Array.isArray(parsed)) {
        // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
        data = { packages: parsed as JsonObject[] };
      } else if (isJsonObject(parsed) && Array.isArray(parsed.packages)) {
        // SAFETY: packages is a JSON array of package objects from on-disk config.
        const packages = parsed.packages as JsonObject[];
        const next: InrepoFileData = {
          fullKeyOrder: Object.keys(parsed),
          packages,
          rootSnapshot: { ...parsed },
        };
        if ("exclude" in parsed) {
          next.exclude = parsed.exclude;
        }
        if ("keep" in parsed) {
          next.keep = parsed.keep;
        }
        if (isString(parsed.$schema) && parsed.$schema.trim()) {
          next.schemaRef = parsed.$schema.trim();
        }
        data = next;
      } else {
        throw new Error(
          'inrepo.json must be a JSON array or { "packages": [...] }'
        );
      }
    }
  }

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

  const fallbackSchemaRef = data.schemaRef ?? defaultInrepoJsonSchemaRef;

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
      } else if (k === "$schema") {
        if (data.schemaRef !== undefined) {
          out.$schema = data.schemaRef;
        } else if ("$schema" in data.rootSnapshot) {
          out.$schema = data.rootSnapshot.$schema;
        }
      } else {
        out[k] = data.rootSnapshot[k];
      }
    }
    if (!("$schema" in out)) {
      out.$schema = fallbackSchemaRef;
    }
  } else {
    out = { packages: data.packages };
    if (data.exclude !== undefined) {
      out.exclude = data.exclude;
    }
    if (data.keep !== undefined) {
      out.keep = data.keep;
    }
    out.$schema = fallbackSchemaRef;
  }

  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
};
