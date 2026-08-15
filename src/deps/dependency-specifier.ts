import { isValidRange } from "../semver/range.js";

export type DependencySpecifier =
  | { supported: true; range: string }
  | { supported: false; reason: string };

const PROTOCOL_REASONS = {
  bitbucket:
    "git host shorthand specifiers are not resolved from the npm registry",
  catalog: "catalog specifiers only resolve inside the upstream workspace",
  file: "local path specifiers have no upstream repository to vendor",
  gist: "git host shorthand specifiers are not resolved from the npm registry",
  git: "git specifiers are not resolved from the npm registry",
  "git+file": "git specifiers are not resolved from the npm registry",
  "git+http": "git specifiers are not resolved from the npm registry",
  "git+https": "git specifiers are not resolved from the npm registry",
  "git+ssh": "git specifiers are not resolved from the npm registry",
  github:
    "git host shorthand specifiers are not resolved from the npm registry",
  gitlab:
    "git host shorthand specifiers are not resolved from the npm registry",
  http: "tarball URL specifiers are not resolved from the npm registry",
  https: "tarball URL specifiers are not resolved from the npm registry",
  link: "local path specifiers have no upstream repository to vendor",
  npm: "npm alias specifiers point at a different package name",
  patch:
    "patch protocol specifiers are applied by the upstream package manager",
  portal: "local path specifiers have no upstream repository to vendor",
  ssh: "git specifiers are not resolved from the npm registry",
  workspace:
    "workspace protocol specifiers only resolve inside the upstream monorepo",
} as const satisfies Record<string, string>;

const PROTOCOL_PATTERN = /^(?<g1>[a-z][a-z0-9+.-]*):/iu;
const GIT_SHORTHAND_PATTERN = /^[\w.-]+\/[\w.-]+(?:#.*)?$/u;

/**
 * Decide whether a `dependencies` entry is something inrepo can vendor.
 *
 * Only npm semver ranges are supported: every other specifier form either has
 * no published version to pin (workspace, file, link) or no registry metadata
 * to map onto a git repository (git URLs, tarballs, aliases, dist-tags).
 */
export const classifyDependencySpecifier = function classifyDependencySpecifier(
  raw: string
): DependencySpecifier {
  const trimmed = raw.trim();
  // npm treats an empty specifier as `*`.
  const range = trimmed === "" ? "*" : trimmed;

  const protocol = PROTOCOL_PATTERN.exec(range);
  if (protocol) {
    const key = protocol[1].toLowerCase();
    // SAFETY: key is checked with `in` before indexing the const protocol map.
    const knownReason =
      key in PROTOCOL_REASONS
        ? PROTOCOL_REASONS[key as keyof typeof PROTOCOL_REASONS]
        : undefined;
    return {
      reason: knownReason ?? `"${key}:" specifiers are not supported`,
      supported: false,
    };
  }

  if (isValidRange(range)) {
    return { range, supported: true };
  }

  if (GIT_SHORTHAND_PATTERN.test(range)) {
    return {
      reason:
        "git host shorthand specifiers are not resolved from the npm registry",
      supported: false,
    };
  }

  return {
    reason:
      "not a semver range (dist-tags and other specifiers are not supported)",
    supported: false,
  };
};
