import type { InrepoPackage } from './inrepo-package.js';

export type LoadedConfig = {
  packages: InrepoPackage[];
  /** Paths relative to each vendored module root removed after clone (before finalize). */
  exclude: string[];
  /** Path prefixes to keep under each vendored module when non-empty (before `exclude`). */
  keep: string[];
  /** Basename of the resolved config file (e.g. `inrepo.json`, `inrepo.yaml`, `inrepo.ts`) or `package.json`. */
  source: string;
};
