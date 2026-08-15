import type { LockModule } from "../types/lock-module.js";
import type { PublishedArtifact } from "../types/published-artifact.js";

export interface AddArgs {
  name: string;
  git?: string;
  /** Package root within a manually supplied git repository. */
  repositoryDirectory?: string;
  ref?: string;
  save: boolean;
  dev: boolean;
  /** Also vendor the package's transitive runtime dependency closure. */
  withDeps: boolean;
}

export interface SyncArgs {
  force: boolean;
}

export interface PatchArgs {
  name?: string;
  /** Reason recorded as the patch subject; required for patch-series capture. */
  message?: string;
}

export interface DiffArgs {
  name?: string;
  /** Show a per-file `+/-` summary instead of the full unified diff. */
  stat: boolean;
}

export interface MigrateArgs {
  name: string;
}

export interface UpdateArgs {
  name: string;
  /** New branch, tag, or commit to pin; persisted to config on success. */
  ref?: string;
  /** Finish an update whose rebase stopped on a conflict. */
  continue: boolean;
  /** Throw away an in-progress update and leave the project untouched. */
  abort: boolean;
}

export interface PackageSpec {
  name: string;
  /** Storage identity under inrepo_modules; defaults to name. */
  module?: string;
  git?: string;
  /** Package root within the git repository; omitted for the repository root. */
  repositoryDirectory?: string;
  ref?: string;
  /** Locked commit to reuse. Null/omitted fetches the moving tip of `ref`. */
  commit?: string | null;
  dev?: boolean;
  exclude?: string[];
  keep?: string[];
  /** Registry payload used only to fill files absent from the git checkout. */
  artifact?: PublishedArtifact;
}

export interface MaterializeOptions {
  mode: "sync" | "add";
  force: boolean;
  lockEntry?: LockModule;
  /** Exact graph commit already resolved and preflighted by `add --with-deps`. */
  resolvedCommit?: string;
}

export interface DispatchOpts {
  force?: boolean;
  suppressBanners?: boolean;
}
