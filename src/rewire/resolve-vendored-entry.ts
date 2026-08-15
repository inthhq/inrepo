import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject, JsonValue } from "../json/unknown.js";
import { isJsonObject, isString } from "../json/unknown.js";

/** The parts of a vendored dependency's package.json that entry resolution needs. */
export interface EntryManifest {
  main: string | null;
  module: string | null;
  /** Conventional source entry used by several package build tools. */
  source?: string | null;
  exports: JsonValue | undefined;
}

/** Which set of `exports` conditions to honor, decided by the importing syntax. */
export type EntryCondition = "import" | "require";

/** Node/Bun export conditions. Browser builds are not selected. */
const CONDITION_ORDER = {
  import: ["import", "module", "node", "default"],
  require: ["require", "node", "default"],
} as const satisfies Record<EntryCondition, readonly string[]>;

const FILE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json"];
const INDEX_FILES = FILE_EXTENSIONS.map((extension) => `index${extension}`);
const OUTPUT_DIRECTORIES = new Set(["dist", "build", "out", "lib"]);

/** Read `<dir>/package.json` for entry resolution. Null when it is absent or unreadable. */
export const loadEntryManifest = async function loadEntryManifest(
  dir: string
): Promise<EntryManifest | null> {
  const path = nodePath.join(dir, "package.json");
  if (!existsSync(path)) {
    return null;
  }
  let parsed: JsonValue;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    parsed = JSON.parse(await readFile(path, "utf-8")) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) {
    return null;
  }
  return {
    exports: parsed.exports,
    main: isString(parsed.main) ? parsed.main : null,
    module: isString(parsed.module) ? parsed.module : null,
    source: isString(parsed.source) ? parsed.source : null,
  };
};

/**
 * Reduce one `exports` value to the file paths it can resolve to, best first.
 *
 * Conditions are walked in a fixed order per {@link CONDITION_ORDER} so the
 * result only depends on committed files, never on the host runtime.
 */
const exportsTargets = function exportsTargets(
  value: JsonValue | undefined,
  condition: EntryCondition,
  depth = 0
): string[] {
  if (depth > 8) {
    return [];
  }
  if (isString(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      exportsTargets(entry, condition, depth + 1)
    );
  }
  if (!isJsonObject(value)) {
    return [];
  }

  const out: string[] = [];
  for (const key of CONDITION_ORDER[condition]) {
    if (key in value) {
      out.push(...exportsTargets(value[key], condition, depth + 1));
    }
  }
  return out;
};

/** True when `exports` maps subpaths (`"."`, `"./sub"`) rather than conditions. */
const isSubpathExports = function isSubpathExports(
  value: JsonValue | undefined
): value is JsonObject {
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key.startsWith("."));
};

const normalizeCandidate = function normalizeCandidate(
  candidate: string
): string | null {
  const cleaned = candidate.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (cleaned === "" || cleaned.startsWith("/") || cleaned.includes("*")) {
    return null;
  }
  const parts = nodePath.posix.normalize(cleaned).split("/");
  if (parts.some((part) => part === "..")) {
    return null;
  }
  return parts.join("/");
};

const isFile = async function isFile(path: string): Promise<boolean> {
  try {
    return await (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const isDirectory = async function isDirectory(path: string): Promise<boolean> {
  try {
    return await (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Turn one candidate path into a concrete file inside `depRoot`, applying the
 * extension and directory-index lookups a bundler-free resolver would.
 */
const resolveCandidate = async function resolveCandidate(
  depRoot: string,
  candidate: string
): Promise<string | null> {
  const normalized = normalizeCandidate(candidate);
  if (normalized == null) {
    return null;
  }
  const abs = nodePath.join(depRoot, ...normalized.split("/"));

  if (await isFile(abs)) {
    return normalized;
  }
  const extension = nodePath.posix.extname(normalized);
  const withoutExtension = FILE_EXTENSIONS.includes(extension)
    ? normalized.slice(0, -extension.length)
    : normalized;
  const extensionBase = nodePath.join(depRoot, ...withoutExtension.split("/"));
  for (const candidateExtension of FILE_EXTENSIONS) {
    if (await isFile(`${extensionBase}${candidateExtension}`)) {
      return `${withoutExtension}${candidateExtension}`;
    }
  }
  if (await isDirectory(abs)) {
    for (const index of INDEX_FILES) {
      if (await isFile(nodePath.join(abs, index))) {
        return `${normalized}/${index}`;
      }
    }
  }
  return null;
};

/**
 * Source-tree alternatives for an entry that names publish-only build output.
 * These are only accepted when a concrete file exists, and explicit package
 * metadata always wins before these fallbacks are tried.
 */
const sourceAlternatives = function sourceAlternatives(
  candidate: string
): string[] {
  const normalized = normalizeCandidate(candidate);
  if (normalized == null) {
    return [];
  }
  const segments = normalized.split("/");
  if (!OUTPUT_DIRECTORIES.has(segments[0])) {
    return [];
  }
  const rest = segments.slice(1).join("/");
  return [`src/${rest}`, `source/${rest}`];
};

const withSourceAlternatives = function withSourceAlternatives(
  candidates: string[]
): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    out.push(candidate, ...sourceAlternatives(candidate));
  }
  return out;
};

/** Candidate paths for a bare `dep` specifier, best first. */
const rootCandidates = function rootCandidates(
  manifest: EntryManifest | null,
  condition: EntryCondition
): string[] {
  if (manifest == null) {
    return ["index.js"];
  }
  const candidates: string[] = [];
  const exportsValue = isSubpathExports(manifest.exports)
    ? manifest.exports["."]
    : manifest.exports;
  candidates.push(
    ...withSourceAlternatives(exportsTargets(exportsValue, condition))
  );
  if (manifest.source) {
    candidates.push(manifest.source);
  }
  if (condition === "import") {
    if (manifest.module) {
      candidates.push(manifest.module);
    }
    if (manifest.main) {
      candidates.push(manifest.main);
    }
  } else {
    if (manifest.main) {
      candidates.push(manifest.main);
    }
    if (manifest.module) {
      candidates.push(manifest.module);
    }
  }
  candidates.push("index.js", "src/index", "source/index");
  return candidates;
};

const replaceStars = function replaceStars(
  value: JsonValue | undefined,
  replacement: string
): JsonValue | undefined {
  if (isString(value)) {
    return value.replaceAll("*", replacement);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceStars(entry, replacement) ?? null);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  // SAFETY: Object.fromEntries of string keys and JsonValue entries is a JsonObject.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      replaceStars(entry, replacement) ?? null,
    ])
  ) as JsonObject;
};

const exportedSubpathValue = function exportedSubpathValue(
  exports: JsonObject,
  subpath: string
): JsonValue | undefined {
  const exact = exports[`./${subpath}`];
  if (exact !== undefined) {
    return exact;
  }

  const request = `./${subpath}`;
  for (const key of Object.keys(exports).toSorted(
    (a, b) => b.length - a.length
  )) {
    const star = key.indexOf("*");
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) {
      continue;
    }
    const replacement = request.slice(
      prefix.length,
      request.length - suffix.length
    );
    return replaceStars(exports[key], replacement);
  }
  return undefined;
};

/** Candidate paths for a `dep/sub/path` specifier, best first. */
const subpathCandidates = function subpathCandidates(
  manifest: EntryManifest | null,
  subpath: string,
  condition: EntryCondition
): string[] {
  if (manifest != null && isSubpathExports(manifest.exports)) {
    const mapped = exportedSubpathValue(manifest.exports, subpath);
    // An exports map is an allowlist: unlisted subpaths must not resolve just
    // because a matching file exists on disk. Mapped targets still get the
    // dist → src fallbacks used for missing publish-only output.
    if (mapped === undefined) {
      return [];
    }
    return withSourceAlternatives(exportsTargets(mapped, condition));
  }
  return [subpath, `src/${subpath}`, `source/${subpath}`];
};

/**
 * Resolve a bare specifier's target inside a vendored dependency to a concrete
 * file, returned as a POSIX path relative to `depRoot`.
 *
 * The result is a file rather than the package directory because Node's ESM
 * resolver performs neither directory-index nor `main` lookups for relative
 * specifiers: `import "../picocolors"` fails where `import
 * "../picocolors/picocolors.js"` works. Returns null when nothing resolves, in
 * which case the caller leaves the specifier alone.
 */
export const resolveVendoredEntry = async function resolveVendoredEntry(opts: {
  depRoot: string;
  manifest: EntryManifest | null;
  /** Everything after the package name, without a leading slash. `''` for the package itself. */
  subpath: string;
  condition: EntryCondition;
}): Promise<string | null> {
  const candidates =
    opts.subpath === ""
      ? rootCandidates(opts.manifest, opts.condition)
      : subpathCandidates(opts.manifest, opts.subpath, opts.condition);

  for (const candidate of candidates) {
    const resolved = await resolveCandidate(opts.depRoot, candidate);
    if (resolved != null) {
      return resolved;
    }
  }
  return null;
};
