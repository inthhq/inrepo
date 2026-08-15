import {
  compareParsedVersions,
  isPrerelease,
  parseVersion,
} from "./version.js";
import type { ParsedVersion } from "./version.js";

export type ComparatorOperator = "<" | "<=" | ">" | ">=" | "=";

export interface Comparator {
  op: ComparatorOperator;
  version: ParsedVersion;
}

/** One `||`-separated alternative: every comparator in the set must hold. */
export type ComparatorSet = Comparator[];

/** A parsed npm dependency range: any one of its comparator sets may match. */
export type ParsedRange = ComparatorSet[];

const PARTIAL_PATTERN =
  /^v?(?<g1>\d+|[xX*])(?:\.(?<g2>\d+|[xX*]))?(?:\.(?<g3>\d+|[xX*]))?(?:-(?<g4>[0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+(?:[0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/iu;

const NUMERIC_IDENTIFIER = /^\d+$/u;

interface PartialVersion {
  /** null when the position was a wildcard (`x`, `X`, `*`) or absent. */
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: (string | number)[];
}

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

const partialPart = function partialPart(
  value: string | undefined
): number | null {
  if (value == null || value === "x" || value === "X" || value === "*") {
    return null;
  }
  return Number(value);
};

const parsePartial = function parsePartial(raw: string): PartialVersion | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  const match = PARTIAL_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const major = partialPart(match[1]);
  const minor = partialPart(match[2]);
  const patch = partialPart(match[3]);
  // `1.x.3` is meaningless: once a position is a wildcard the rest must be too.
  if (major == null && (minor != null || patch != null)) {
    return null;
  }
  if (minor == null && patch != null) {
    return null;
  }
  return { major, minor, patch, prerelease: parseIdentifiers(match[4]) };
};

const version = function version(
  major: number,
  minor: number,
  patch: number,
  prerelease: (string | number)[] = []
): ParsedVersion {
  return { build: [], major, minor, patch, prerelease };
};

const lowerBound = function lowerBound(partial: PartialVersion): ParsedVersion {
  return version(
    partial.major ?? 0,
    partial.minor ?? 0,
    partial.patch ?? 0,
    partial.prerelease
  );
};

const anyVersion = function anyVersion(): ComparatorSet {
  return [{ op: ">=", version: version(0, 0, 0) }];
};

const caretUpperBound = function caretUpperBound(
  partial: PartialVersion
): ParsedVersion {
  const major = partial.major ?? 0;
  if (major !== 0) {
    return version(major + 1, 0, 0);
  }
  if (partial.minor == null) {
    return version(1, 0, 0);
  }
  if (partial.minor !== 0) {
    return version(0, partial.minor + 1, 0);
  }
  if (partial.patch == null) {
    return version(0, 1, 0);
  }
  return version(0, 0, partial.patch + 1);
};

const tildeUpperBound = function tildeUpperBound(
  partial: PartialVersion
): ParsedVersion {
  const major = partial.major ?? 0;
  if (partial.minor == null) {
    return version(major + 1, 0, 0);
  }
  return version(major, partial.minor + 1, 0);
};

/** `1.2` with no operator means "any 1.2.x"; `1` means "any 1.x". */
const partialUpperBound = function partialUpperBound(
  partial: PartialVersion
): ParsedVersion | null {
  if (partial.major == null) {
    return null;
  }
  if (partial.minor == null) {
    return version(partial.major + 1, 0, 0);
  }
  if (partial.patch == null) {
    return version(partial.major, partial.minor + 1, 0);
  }
  return null;
};

const expandToken = function expandToken(token: string): ComparatorSet | null {
  const operatorMatch = /^(?<g1>>=|<=|>|<|=|\^|~)?(?<g2>.*)$/u.exec(token);
  if (!operatorMatch) {
    return null;
  }
  const op = operatorMatch[1] ?? "";
  const partial = parsePartial(operatorMatch[2]);
  if (!partial) {
    return null;
  }

  if (op === "^") {
    if (partial.major == null) {
      return anyVersion();
    }
    return [
      { op: ">=", version: lowerBound(partial) },
      { op: "<", version: caretUpperBound(partial) },
    ];
  }

  if (op === "~") {
    if (partial.major == null) {
      return anyVersion();
    }
    return [
      { op: ">=", version: lowerBound(partial) },
      { op: "<", version: tildeUpperBound(partial) },
    ];
  }

  if (op === ">" || op === ">=") {
    if (partial.major == null) {
      return anyVersion();
    }
    const upper = partialUpperBound(partial);
    if (op === ">" && upper) {
      return [{ op: ">=", version: upper }];
    }
    return [{ op: op === ">" ? ">" : ">=", version: lowerBound(partial) }];
  }

  if (op === "<" || op === "<=") {
    if (partial.major == null) {
      return [{ op: "<", version: version(0, 0, 0) }];
    }
    const upper = partialUpperBound(partial);
    if (op === "<=" && upper) {
      return [{ op: "<", version: upper }];
    }
    return [{ op: op === "<=" ? "<=" : "<", version: lowerBound(partial) }];
  }

  // Bare version or explicit `=`.
  if (partial.major == null) {
    return anyVersion();
  }
  const upper = partialUpperBound(partial);
  if (upper) {
    return [
      { op: ">=", version: lowerBound(partial) },
      { op: "<", version: upper },
    ];
  }
  return [{ op: "=", version: lowerBound(partial) }];
};

const HYPHEN_RANGE = /^(?<g1>\S+)\s+-\s+(?<g2>\S+)$/u;

const expandHyphenRange = function expandHyphenRange(
  rawLow: string,
  rawHigh: string
): ComparatorSet | null {
  const low = parsePartial(rawLow);
  const high = parsePartial(rawHigh);
  if (!low || !high) {
    return null;
  }
  const comparators: ComparatorSet = [];
  comparators.push({ op: ">=", version: lowerBound(low) });
  if (high.major == null) {
    return comparators;
  }
  const upper = partialUpperBound(high);
  comparators.push(
    upper
      ? { op: "<", version: upper }
      : { op: "<=", version: lowerBound(high) }
  );
  return comparators;
};

const parseComparatorSet = function parseComparatorSet(
  raw: string
): ComparatorSet | null {
  const normalized = raw.trim().replaceAll(/\s+/gu, " ");
  if (normalized === "") {
    return anyVersion();
  }

  const hyphen = HYPHEN_RANGE.exec(normalized);
  if (hyphen) {
    return expandHyphenRange(hyphen[1], hyphen[2]);
  }

  // `>= 1.2.3` is the same range as `>=1.2.3`.
  const tightened = normalized.replaceAll(/(?<g1>>=|<=|>|<|=|\^|~) /gu, "$1");
  const comparators: ComparatorSet = [];
  for (const token of tightened.split(" ")) {
    if (token === "") {
      continue;
    }
    const expanded = expandToken(token);
    if (!expanded) {
      return null;
    }
    comparators.push(...expanded);
  }
  return comparators.length > 0 ? comparators : anyVersion();
};

/** Parse an npm dependency range. Returns null when the range is not valid semver. */
export const parseRange = function parseRange(raw: string): ParsedRange | null {
  const sets: ParsedRange = [];
  for (const alternative of raw.split("||")) {
    const set = parseComparatorSet(alternative);
    if (!set) {
      return null;
    }
    sets.push(set);
  }
  return sets;
};

export const isValidRange = function isValidRange(raw: string): boolean {
  return parseRange(raw) != null;
};

const testComparator = function testComparator(
  candidate: ParsedVersion,
  comparator: Comparator
): boolean {
  const cmp = compareParsedVersions(candidate, comparator.version);
  switch (comparator.op) {
    case ">": {
      return cmp > 0;
    }
    case ">=": {
      return cmp >= 0;
    }
    case "<": {
      return cmp < 0;
    }
    case "<=": {
      return cmp <= 0;
    }
    case "=": {
      return cmp === 0;
    }
    default: {
      return false;
    }
  }
};

const satisfiesSet = function satisfiesSet(
  candidate: ParsedVersion,
  set: ComparatorSet
): boolean {
  for (const comparator of set) {
    if (!testComparator(candidate, comparator)) {
      return false;
    }
  }
  if (!isPrerelease(candidate)) {
    return true;
  }
  // A prerelease only counts when the range explicitly mentions a prerelease of
  // the same [major, minor, patch] tuple, matching npm's resolution behavior.
  return set.some(
    (comparator) =>
      isPrerelease(comparator.version) &&
      comparator.version.major === candidate.major &&
      comparator.version.minor === candidate.minor &&
      comparator.version.patch === candidate.patch
  );
};

/** True when `version` falls inside `range`. Invalid input never satisfies. */
export const satisfies = function satisfies(
  rawVersion: string,
  rawRange: string
): boolean {
  const candidate = parseVersion(rawVersion);
  const range = parseRange(rawRange);
  if (!candidate || !range) {
    return false;
  }
  return range.some((set) => satisfiesSet(candidate, set));
};

/**
 * Highest version satisfying every range at once. This is how inrepo unifies
 * overlapping requirements from different dependents into a single vendored
 * pin; a null result means the ranges do not overlap on any published version.
 */
export const maxSatisfyingAll = function maxSatisfyingAll(
  versions: string[],
  ranges: string[]
): string | null {
  let best: { raw: string; parsed: ParsedVersion } | null = null;
  const parsedRanges = ranges.map((range) => parseRange(range));
  if (parsedRanges.some((range) => range == null)) {
    return null;
  }

  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (!parsed) {
      continue;
    }
    const ok = parsedRanges.every((range) =>
      range?.some((set) => satisfiesSet(parsed, set))
    );
    if (!ok) {
      continue;
    }
    if (!best || compareParsedVersions(parsed, best.parsed) > 0) {
      best = { parsed, raw };
    }
  }
  return best?.raw ?? null;
};
