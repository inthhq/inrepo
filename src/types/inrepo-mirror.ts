/**
 * A one-way mirror of part of this repository into another git repository.
 * The host repository is the source of truth; the target only receives
 * filtered snapshot commits made by `inrepo mirror`.
 */
export interface InrepoMirror {
  /** Unique label used to select the mirror on the command line. */
  name: string;
  /** Target repository URL (anything `git push` accepts). */
  git: string;
  /** Target branch that receives mirror commits. Defaults to `main`. */
  branch: string;
  /**
   * Directory in this repository, relative to the inrepo config, that becomes
   * the target repository root. Omitted for the config directory itself.
   */
  directory?: string;
  /** Path prefixes under `directory` to publish when non-empty (runs before `exclude`). */
  keep: string[];
  /** Paths or `/regex/` patterns under `directory` that are never published. */
  exclude: string[];
}
