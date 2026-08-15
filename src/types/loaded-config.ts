import type { InrepoPackage } from "./inrepo-package.js";

export interface LoadedConfig {
  packages: InrepoPackage[];
  /** Paths relative to each vendored module root removed after clone (before finalize). */
  exclude: string[];
  /** Path prefixes to keep under each vendored module when non-empty (before `exclude`). */
  keep: string[];
  /** Project-wide default for the generated import-rewiring transform. Off unless set. */
  rewireImports: boolean;
  source: "inrepo.json" | "package.json";
}
