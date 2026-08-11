/** One runtime dependency edge of a vendored package. */
export type LockGraphEdge = {
  /** Semver range the dependent declares in its package.json. */
  range: string;
  /** Exact version the range resolved to. Omitted when the target has none. */
  version?: string;
  /** Key under "modules" (and directory under inrepo_modules/) holding that version. */
  module: string;
};

/** One vendored package in the recorded dependency graph. */
export type LockGraphNode = {
  /** package.json "version" of the pinned checkout. Omitted when it declares none. */
  version?: string;
  /** True for a package the user vendored by name rather than through a dependency. */
  root?: boolean;
  /** Runtime dependency edges keyed by the dependency's package name. */
  dependencies?: Record<string, LockGraphEdge>;
};

/**
 * `inrepo.lock.json#graph`: who requires whom, at which range, resolved to which
 * version. Written by `inrepo add --with-deps` and replayed offline by
 * `inrepo sync` and `inrepo verify`.
 */
export type LockGraph = Record<string, LockGraphNode>;
