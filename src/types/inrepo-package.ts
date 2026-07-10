export type PackageJsonDependencyTarget = 'dependencies' | 'devDependencies';

export type InrepoPackage = {
  name: string;
  git?: string;
  ref?: string;
  /** When set, sync wires the generated module into this root package.json dependency bucket. */
  packageJson?: PackageJsonDependencyTarget;
  /** Paths relative to the vendored module root removed after clone (merged with root `exclude`). */
  exclude?: string[];
  /** Path prefixes under the vendored module to retain when non-empty (merged with root `keep`); runs before `exclude`. */
  keep?: string[];
};
