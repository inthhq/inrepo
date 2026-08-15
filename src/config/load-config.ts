import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { isBoolean, isJsonObject, isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
import { inrepoConfigPath } from "../paths/inrepo-config-path.js";
import { packageJsonPath } from "../paths/package-json-path.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type { InrepoPackage } from "../types/inrepo-package.js";
import type { LoadedConfig } from "../types/loaded-config.js";
import { validateExcludeList } from "./validate-exclude-list.js";
import { validateKeepList } from "./validate-keep-list.js";

/** Thrown when neither inrepo.json nor package.json declares inrepo config. */
export class LoadConfigNotFoundError extends Error {
  override readonly name = "LoadConfigNotFoundError";
}

const rootExcludeFromParsed = function rootExcludeFromParsed(
  parsed: JsonValue,
  label: string
): string[] {
  if (!isJsonObject(parsed)) {
    return [];
  }
  return validateExcludeList(parsed.exclude, label);
};

const rootKeepFromParsed = function rootKeepFromParsed(
  parsed: JsonValue,
  label: string
): string[] {
  if (!isJsonObject(parsed)) {
    return [];
  }
  return validateKeepList(parsed.keep, label);
};

const rootRewireImportsFromParsed = function rootRewireImportsFromParsed(
  parsed: JsonValue,
  label: string
): boolean {
  if (!isJsonObject(parsed)) {
    return false;
  }
  const raw = parsed.rewireImports;
  if (raw == null) {
    return false;
  }
  if (!isBoolean(raw)) {
    throw new TypeError(`${label} must be a boolean when set`);
  }
  return raw;
};

const normalizePackagesArray = function normalizePackagesArray(
  raw: JsonValue
): JsonValue[] {
  if (raw == null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (isJsonObject(raw)) {
    const pkgs = raw.packages;
    if (pkgs == null) {
      return [];
    }
    if (Array.isArray(pkgs)) {
      return pkgs;
    }
    throw new Error('Config "packages" must be a JSON array');
  }
  throw new Error(
    'Config must be a JSON array or an object with a "packages" array'
  );
};

const validatePackage = function validatePackage(
  entry: JsonValue,
  index: number
): InrepoPackage {
  if (!isJsonObject(entry)) {
    throw new Error(`packages[${index}] must be an object`);
  }
  const rec = entry;
  const { name } = rec;
  if (!isString(name) || !name.trim()) {
    throw new Error(
      `packages[${index}].name is required and must be a non-empty string`
    );
  }
  const pkg: InrepoPackage = { name: name.trim() };
  if (rec.module != null) {
    if (!isString(rec.module) || !rec.module.trim()) {
      throw new Error(
        `packages[${index}].module must be a non-empty string when set`
      );
    }
    pkg.module = rec.module.trim();
  }
  if (rec.git != null) {
    if (!isString(rec.git) || !rec.git.trim()) {
      throw new Error(
        `packages[${index}].git must be a non-empty string when set`
      );
    }
    pkg.git = rec.git.trim();
  }
  if (rec.repositoryDirectory != null) {
    if (!isString(rec.repositoryDirectory)) {
      throw new TypeError(
        `packages[${index}].repositoryDirectory must be a string when set`
      );
    }
    const repositoryDirectory = normalizeRepositoryDirectory(
      rec.repositoryDirectory,
      `packages[${index}].repositoryDirectory`
    );
    if (repositoryDirectory != null) {
      pkg.repositoryDirectory = repositoryDirectory;
    }
  }
  if (rec.ref != null) {
    if (!isString(rec.ref) || !rec.ref.trim()) {
      throw new Error(
        `packages[${index}].ref must be a non-empty string when set`
      );
    }
    pkg.ref = rec.ref.trim();
  }
  if (rec.dev != null) {
    if (!isBoolean(rec.dev)) {
      throw new TypeError(`packages[${index}].dev must be a boolean when set`);
    }
    pkg.dev = rec.dev;
  }
  if (rec.exclude != null) {
    pkg.exclude = validateExcludeList(
      rec.exclude,
      `packages[${index}].exclude`
    );
  }
  if (rec.keep != null) {
    pkg.keep = validateKeepList(rec.keep, `packages[${index}].keep`);
  }
  if (rec.rewireImports != null) {
    if (!isBoolean(rec.rewireImports)) {
      throw new TypeError(
        `packages[${index}].rewireImports must be a boolean when set`
      );
    }
    pkg.rewireImports = rec.rewireImports;
  }
  return pkg;
};

/** Load declarative config from inrepo.json (preferred) or package.json#inrepo. */
export const loadConfig = async function loadConfig(
  cwd: string
): Promise<LoadedConfig> {
  const inrepoPath = inrepoConfigPath(cwd);
  if (existsSync(inrepoPath)) {
    const contents = await readFile(inrepoPath, "utf-8");
    if (!contents.trim()) {
      throw new Error(`${inrepoPath} is empty`);
    }
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse produces a JSON value from file contents.
      parsed = JSON.parse(contents) as JsonValue;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Invalid JSON in inrepo.json: ${err.message}`, {
        cause: error,
      });
    }
    const packagesRaw = Array.isArray(parsed)
      ? parsed
      : normalizePackagesArray(parsed);
    const packages = packagesRaw.map((p, i) => validatePackage(p, i));
    const exclude = rootExcludeFromParsed(parsed, 'inrepo.json "exclude"');
    const keep = rootKeepFromParsed(parsed, 'inrepo.json "keep"');
    const rewireImports = rootRewireImportsFromParsed(
      parsed,
      'inrepo.json "rewireImports"'
    );
    return { exclude, keep, packages, rewireImports, source: "inrepo.json" };
  }

  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) {
    throw new LoadConfigNotFoundError(
      'No inrepo.json or package.json found. Create inrepo.json or add an "inrepo" field to package.json.'
    );
  }
  let pkgJson: JsonValue;
  try {
    // SAFETY: JSON.parse produces a JSON value from file contents.
    pkgJson = JSON.parse(await readFile(pkgPath, "utf-8")) as JsonValue;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid package.json: ${err.message}`, { cause: error });
  }
  if (!isJsonObject(pkgJson)) {
    throw new Error("package.json must be a JSON object");
  }
  const { inrepo } = pkgJson;
  if (inrepo == null) {
    throw new LoadConfigNotFoundError(
      'No inrepo.json and package.json has no "inrepo" field.'
    );
  }
  const packagesRaw = Array.isArray(inrepo)
    ? inrepo
    : normalizePackagesArray(inrepo);
  const packages = packagesRaw.map((p, i) => validatePackage(p, i));
  const exclude = rootExcludeFromParsed(
    inrepo,
    'package.json "inrepo.exclude"'
  );
  const keep = rootKeepFromParsed(inrepo, 'package.json "inrepo.keep"');
  const rewireImports = rootRewireImportsFromParsed(
    inrepo,
    'package.json "inrepo.rewireImports"'
  );
  return { exclude, keep, packages, rewireImports, source: "package.json" };
};

/**
 * Parsed root for global `exclude` / `keep`: prefer inrepo.json, else package.json#inrepo object.
 * Returns null when there is nothing to read (same empty-array behavior as before).
 */
const readGlobalInrepoRaw = async function readGlobalInrepoRaw(
  cwd: string
): Promise<{
  parsed: JsonValue;
  source: "inrepo.json" | "package.json";
} | null> {
  const inrepoPath = inrepoConfigPath(cwd);
  if (existsSync(inrepoPath)) {
    const contents = await readFile(inrepoPath, "utf-8");
    if (!contents.trim()) {
      return null;
    }
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse produces a JSON value from file contents.
      parsed = JSON.parse(contents) as JsonValue;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Invalid JSON in inrepo.json: ${err.message}`, {
        cause: error,
      });
    }
    return { parsed, source: "inrepo.json" };
  }

  const pkgPath = packageJsonPath(cwd);
  if (!existsSync(pkgPath)) {
    return null;
  }
  let pkgJson: JsonValue;
  try {
    // SAFETY: JSON.parse produces a JSON value from file contents.
    pkgJson = JSON.parse(await readFile(pkgPath, "utf-8")) as JsonValue;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid package.json: ${err.message}`, { cause: error });
  }
  if (!isJsonObject(pkgJson)) {
    return null;
  }
  const { inrepo } = pkgJson;
  if (!isJsonObject(inrepo)) {
    return null;
  }
  return { parsed: inrepo, source: "package.json" };
};

/**
 * Root `exclude` list only (no `packages` required). Used by `inrepo add` so global
 * excludes apply even when sync has not been run.
 */
export const loadGlobalExclude = async function loadGlobalExclude(
  cwd: string
): Promise<string[]> {
  const ctx = await readGlobalInrepoRaw(cwd);
  if (!ctx) {
    return [];
  }
  const label =
    ctx.source === "inrepo.json"
      ? 'inrepo.json "exclude"'
      : 'package.json "inrepo.exclude"';
  return rootExcludeFromParsed(ctx.parsed, label);
};

/**
 * Root `keep` list only. Used by `inrepo add` when full `loadConfig` is unavailable.
 */
export const loadGlobalKeep = async function loadGlobalKeep(
  cwd: string
): Promise<string[]> {
  const ctx = await readGlobalInrepoRaw(cwd);
  if (!ctx) {
    return [];
  }
  const label =
    ctx.source === "inrepo.json"
      ? 'inrepo.json "keep"'
      : 'package.json "inrepo.keep"';
  return rootKeepFromParsed(ctx.parsed, label);
};

/** True when loadConfig failed because no config file/field exists (safe to fall back to globals-only). */
export const isLoadConfigNotFoundError = function isLoadConfigNotFoundError<T>(
  error: T
): boolean {
  return error instanceof LoadConfigNotFoundError;
};
