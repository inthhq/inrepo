import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { isJsonObject } from "../json/unknown.js";
import type { JsonObject, JsonValue } from "../json/unknown.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { packageJsonPath } from "../paths/package-json-path.js";

const localFilePackageSpecifier = function localFilePackageSpecifier(
  cwd: string,
  module: string
): string {
  const dest = moduleDestPath(cwd, module);
  const rel = nodePath.relative(cwd, dest);
  const normalized = rel.split(nodePath.sep).join("/");
  return `file:${normalized}`;
};

const omitJsonKey = function omitJsonKey(
  obj: JsonObject,
  key: string
): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== key) {
      out[k] = v;
    }
  }
  return out;
};

const ensureDepObject = function ensureDepObject(
  data: JsonObject,
  key: "dependencies" | "devDependencies"
): JsonObject {
  let obj = data[key];
  if (obj == null) {
    obj = {};
    data[key] = obj;
  }
  if (!isJsonObject(obj)) {
    throw new Error(`package.json "${key}" must be a JSON object when present`);
  }
  return obj;
};

const pruneLegacyPackagesMap = function pruneLegacyPackagesMap(
  data: JsonObject,
  packageName: string
): void {
  const pkgs = data.packages;
  if (pkgs == null) {
    return;
  }
  if (!isJsonObject(pkgs)) {
    throw new Error(
      'package.json "packages" must be a JSON object when present'
    );
  }
  const next = omitJsonKey(pkgs, packageName);
  if (Object.keys(next).length === 0) {
    delete data.packages;
  } else {
    data.packages = next;
  }
};

/**
 * Set package.json#dependencies or #devDependencies[name] to a file: URL pointing at inrepo_modules.
 * Removes the name from the other deps bucket and from legacy package.json#packages.
 * No-op if package.json is missing (e.g. vendoring outside an npm project).
 */
export const upsertRootPackageJsonDependency =
  async function upsertRootPackageJsonDependency(
    cwd: string,
    packageName: string,
    dev: boolean,
    module: string = packageName
  ): Promise<void> {
    const path = packageJsonPath(cwd);
    if (!existsSync(path)) {
      return;
    }

    const raw = await readFile(path, "utf-8");
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse produces a JSON value from file contents.
      parsed = JSON.parse(raw) as JsonValue;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Invalid package.json: ${err.message}`, { cause: error });
    }
    if (!isJsonObject(parsed)) {
      throw new Error("package.json must be a JSON object");
    }
    const data = parsed;

    const primaryKey = dev ? "devDependencies" : "dependencies";
    const otherKey = dev ? "dependencies" : "devDependencies";

    const primary = ensureDepObject(data, primaryKey);
    const specifier = localFilePackageSpecifier(cwd, module);
    primary[packageName] = specifier;

    if (otherKey === "dependencies") {
      const other = data.dependencies;
      if (isJsonObject(other)) {
        const nextOther = omitJsonKey(other, packageName);
        if (Object.keys(nextOther).length === 0) {
          delete data.dependencies;
        } else {
          data.dependencies = nextOther;
        }
      }
    } else {
      const other = data.devDependencies;
      if (isJsonObject(other)) {
        const nextOther = omitJsonKey(other, packageName);
        if (Object.keys(nextOther).length === 0) {
          delete data.devDependencies;
        } else {
          data.devDependencies = nextOther;
        }
      }
    }

    pruneLegacyPackagesMap(data, packageName);

    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  };
