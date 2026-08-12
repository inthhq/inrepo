export type InrepoPackage = {
  name: string;
  /** Storage identity for a graph-managed package instance; defaults to name. */
  module?: string;
  git?: string;
  /** Package root within the git repository; omitted for the repository root. */
  repositoryDirectory?: string;
  ref?: string;
  /** When true, sync wires package.json#devDependencies instead of #dependencies. */
  dev?: boolean;
  /** Paths relative to the vendored module root removed after clone (merged with root `exclude`). */
  exclude?: string[];
  /** Path prefixes under the vendored module to retain when non-empty (merged with root `keep`); runs before `exclude`. */
  keep?: string[];
  /** Overrides the root `rewireImports` setting for this package only. */
  rewireImports?: boolean;
};
