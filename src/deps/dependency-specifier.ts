import { isValidRange } from '../semver/range.js';

export type DependencySpecifier =
  | { supported: true; range: string }
  | { supported: false; reason: string };

const PROTOCOL_REASONS: Record<string, string> = {
  workspace: 'workspace protocol specifiers only resolve inside the upstream monorepo',
  file: 'local path specifiers have no upstream repository to vendor',
  link: 'local path specifiers have no upstream repository to vendor',
  portal: 'local path specifiers have no upstream repository to vendor',
  catalog: 'catalog specifiers only resolve inside the upstream workspace',
  patch: 'patch protocol specifiers are applied by the upstream package manager',
  npm: 'npm alias specifiers point at a different package name',
  git: 'git specifiers are not resolved from the npm registry',
  'git+ssh': 'git specifiers are not resolved from the npm registry',
  'git+https': 'git specifiers are not resolved from the npm registry',
  'git+http': 'git specifiers are not resolved from the npm registry',
  'git+file': 'git specifiers are not resolved from the npm registry',
  ssh: 'git specifiers are not resolved from the npm registry',
  http: 'tarball URL specifiers are not resolved from the npm registry',
  https: 'tarball URL specifiers are not resolved from the npm registry',
  github: 'git host shorthand specifiers are not resolved from the npm registry',
  gitlab: 'git host shorthand specifiers are not resolved from the npm registry',
  bitbucket: 'git host shorthand specifiers are not resolved from the npm registry',
  gist: 'git host shorthand specifiers are not resolved from the npm registry',
};

const PROTOCOL_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const GIT_SHORTHAND_PATTERN = /^[\w.-]+\/[\w.-]+(?:#.*)?$/;

/**
 * Decide whether a `dependencies` entry is something inrepo can vendor.
 *
 * Only npm semver ranges are supported: every other specifier form either has
 * no published version to pin (workspace, file, link) or no registry metadata
 * to map onto a git repository (git URLs, tarballs, aliases, dist-tags).
 */
export function classifyDependencySpecifier(raw: string): DependencySpecifier {
  const trimmed = raw.trim();
  // npm treats an empty specifier as `*`.
  const range = trimmed === '' ? '*' : trimmed;

  const protocol = PROTOCOL_PATTERN.exec(range);
  if (protocol) {
    const key = protocol[1].toLowerCase();
    return {
      supported: false,
      reason: PROTOCOL_REASONS[key] ?? `"${key}:" specifiers are not supported`,
    };
  }

  if (isValidRange(range)) return { supported: true, range };

  if (GIT_SHORTHAND_PATTERN.test(range)) {
    return {
      supported: false,
      reason: 'git host shorthand specifiers are not resolved from the npm registry',
    };
  }

  return {
    supported: false,
    reason: 'not a semver range (dist-tags and other specifiers are not supported)',
  };
}
