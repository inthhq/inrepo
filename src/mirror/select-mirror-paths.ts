import { parseExcludeEntries } from "../git/apply-vendor-excludes.js";

/** Directory prefixes along rel (e.g. "a/b/c" -> ["a", "a/b"]). */
const ancestorDirectories = function ancestorDirectories(
  relPosix: string
): string[] {
  const parts = relPosix.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
};

const underPrefix = function underPrefix(
  relPosix: string,
  prefix: string
): boolean {
  return relPosix === prefix || relPosix.startsWith(`${prefix}/`);
};

export interface MirrorSelection {
  /** Paths that will be published. */
  included: string[];
  /** Paths left out by `keep` or `exclude`. */
  excluded: string[];
}

/**
 * Decide which committed file paths a mirror publishes. Uses the same rules as
 * vendored-module filtering: `keep` prefixes first, then `exclude` literals
 * (a file or a whole directory) and `/regex/` patterns, which match a file or
 * any of its parent directories.
 */
export const selectMirrorPaths = function selectMirrorPaths(
  paths: string[],
  keep: string[],
  exclude: string[]
): MirrorSelection {
  const keepPrefixes = keep
    .map((p) => p.replaceAll("\\", "/").replace(/\/+$/u, ""))
    .filter(Boolean);
  const parsed = parseExcludeEntries(exclude);
  const { regexes } = parsed;
  const literals = parsed.literals
    .map((lit) => lit.replace(/^\.\/+/u, "").replace(/\/+$/u, ""))
    .filter(Boolean);

  const isExcluded = (relPosix: string): boolean => {
    if (literals.some((lit) => underPrefix(relPosix, lit))) {
      return true;
    }
    if (regexes.length === 0) {
      return false;
    }
    const candidates = [relPosix, ...ancestorDirectories(relPosix)];
    return regexes.some((re) =>
      candidates.some((candidate) => {
        re.lastIndex = 0;
        return re.test(candidate);
      })
    );
  };

  const included: string[] = [];
  const excluded: string[] = [];
  for (const relPosix of paths) {
    const kept =
      keepPrefixes.length === 0 ||
      keepPrefixes.some((prefix) => underPrefix(relPosix, prefix));
    if (kept && !isExcluded(relPosix)) {
      included.push(relPosix);
    } else {
      excluded.push(relPosix);
    }
  }
  return { excluded, included };
};
