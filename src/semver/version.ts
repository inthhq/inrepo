import { isNumber } from "../json/unknown.js";
/**
 * A parsed semantic version.
 *
 * inrepo only needs enough of semver to turn an npm dependency range into one
 * exact published version, so this module implements the comparison rules from
 * the spec rather than depending on a full semver package.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; numeric ones are kept as numbers. */
  prerelease: (string | number)[];
  /** Dot-separated build identifiers. Ignored by every comparison. */
  build: string[];
}

const VERSION_PATTERN =
  /^v?(?<g1>\d+)\.(?<g2>\d+)\.(?<g3>\d+)(?:-(?<g4>[0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+(?<g5>[0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/iu;

const NUMERIC_IDENTIFIER = /^\d+$/u;

const parseIdentifiers = function parseIdentifiers(
  raw: string | undefined
): (string | number)[] {
  if (raw == null || raw === "") {
    return [];
  }
  return raw
    .split(".")
    .map((part) => (NUMERIC_IDENTIFIER.test(part) ? Number(part) : part));
};

/** Parse an exact version string. Returns null when it is not a valid semver version. */
export const parseVersion = function parseVersion(
  raw: string
): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) {
    return null;
  }
  return {
    build: match[5] == null ? [] : match[5].split("."),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: parseIdentifiers(match[4]),
  };
};

export const isValidVersion = function isValidVersion(raw: string): boolean {
  return parseVersion(raw) != null;
};

const compareIdentifiers = function compareIdentifiers(
  a: string | number,
  b: string | number
): number {
  const aNumeric = isNumber(a);
  const bNumeric = isNumber(b);
  if (aNumeric && bNumeric) {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) {
    return -1;
  }
  if (bNumeric) {
    return 1;
  }
  const aText = String(a);
  const bText = String(b);
  if (aText < bText) {
    return -1;
  }
  if (aText > bText) {
    return 1;
  }
  return 0;
};

const comparePrerelease = function comparePrerelease(
  a: (string | number)[],
  b: (string | number)[]
): number {
  // A version without a prerelease outranks the same version with one.
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const cmp = compareIdentifiers(left, right);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return 0;
};

/** Compare two parsed versions by semver precedence. Build metadata is ignored. */
export const compareParsedVersions = function compareParsedVersions(
  a: ParsedVersion,
  b: ParsedVersion
): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
};

/** Compare two version strings. Throws when either side is not a valid version. */
export const compareVersions = function compareVersions(
  a: string,
  b: string
): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) {
    throw new Error(`Invalid semver version: ${a}`);
  }
  if (!right) {
    throw new Error(`Invalid semver version: ${b}`);
  }
  return compareParsedVersions(left, right);
};

/** True when the version carries a prerelease tag (`1.0.0-beta.1`). */
export const isPrerelease = function isPrerelease(
  version: ParsedVersion
): boolean {
  return version.prerelease.length > 0;
};
