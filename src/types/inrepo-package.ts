export type InrepoPackage = {
  name: string;
  git?: string;
  ref?: string;
  /** When true, sync wires package.json#devDependencies instead of #dependencies. */
  dev?: boolean;
  /** Paths relative to the vendored module root removed after clone (merged with root `exclude`). */
  exclude?: string[];
  /** Path prefixes under the vendored module to retain when non-empty (merged with root `keep`); runs before `exclude`. */
  keep?: string[];
};
