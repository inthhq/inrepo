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

/** How a file differs from its base, as reported under `--json`. */
export type FileChangeStatus = "added" | "deleted" | "modified";

export interface FileChange {
  /** POSIX path relative to the package root. */
  path: string;
  status: FileChangeStatus;
}

export interface FileChangeStat extends FileChange {
  /** Added lines; `null` for a binary file. */
  additions: number | null;
  /** Deleted lines; `null` for a binary file. */
  deletions: number | null;
}

/** One patch file in a package's series. */
export interface SeriesPatchRef {
  /** Numeric `NNNN-` prefix. */
  number: number;
  /** POSIX path relative to the project root, e.g. `inrepo_patches/x/series/0001-y.patch`. */
  file: string;
  subject: string;
}

export interface PatchPackageResult {
  module: string;
  /** `series` appends a numbered patch; `overlay` rewrites legacy snapshot files. */
  format: "overlay" | "series";
  /**
   * Whether this run wrote (or, under `--dry-run`, would write) anything new.
   * `false` means the checkout had no uncaptured edits.
   */
  captured: boolean;
  /**
   * The appended series patch. Under `--dry-run` without `-m`, `file` and
   * `subject` are `null` because the file name is derived from the message.
   */
  patch?: {
    number: number;
    file: string | null;
    subject: string | null;
  };
  /**
   * Series: the paths the new patch touches. Overlay: every path the overlay
   * holds relative to the pinned upstream tree.
   */
  files: FileChange[];
}

export interface PatchResult {
  packages: PatchPackageResult[];
}

export interface DiffPackageResult {
  module: string;
  /** Where the committed changes come from. */
  source: "legacy-overlay" | "none" | "series";
  /** Full pinned upstream commit. */
  commit: string;
  patches: SeriesPatchRef[];
  /** Effective delta, upstream -> patched tree, sorted by path. */
  files: FileChangeStat[];
  /** Full unified diff; omitted under `--stat`. Empty when nothing differs. */
  diff?: string;
}

export interface DiffResult {
  packages: DiffPackageResult[];
}

export interface MigrateResult {
  module: string;
  /** The series that now carries the package's changes. */
  patches: SeriesPatchRef[];
  /** Paths the generated series touches, sorted. */
  files: FileChange[];
  /** Top-level legacy overlay entries removed from `inrepo_patches/<pkg>/`. */
  removedOverlayEntries: string[];
  /** Empty directories the overlay created that git cannot record. */
  droppedEmptyDirectories: string[];
}

export interface MirrorArgs {
  /** Mirror to publish; omitted publishes every configured mirror. */
  name?: string;
  /** Source revision to publish. */
  ref: string;
  overwrite: boolean;
  /** Subject line for the mirror commit. */
  message?: string;
}
