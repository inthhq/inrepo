/**
 * Stable category of a verify finding. Agents branch on `kind`; the message
 * text is for humans and may change.
 */
export type VerifyIssueKind =
  | "assemble-failed"
  | "empty-lockfile"
  | "git-check-failed"
  | "graph"
  | "head-mismatch"
  | "marker-commit-mismatch"
  | "marker-git-url-mismatch"
  | "marker-invalid"
  | "marker-missing"
  | "marker-repository-directory-mismatch"
  | "marker-unreadable"
  | "missing-directory"
  | "not-a-directory"
  | "origin-mismatch"
  | "pristine-unavailable"
  | "tree-drift";

/** Paths (relative to the module root) that differ from the rebuilt tree. */
export interface VerifyTreeDrift {
  /** Present in the checkout but not in the rebuilt tree. */
  added: string[];
  modified: string[];
  /** Present in the rebuilt tree but missing from the checkout. */
  removed: string[];
  typeChanges: string[];
}

export interface VerifyIssue {
  /** Lockfile module the finding is about; null for project-wide findings. */
  module: string | null;
  kind: VerifyIssueKind;
  message: string;
  /** Set on `tree-drift` findings. */
  drift?: VerifyTreeDrift;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  /** `issues[].message`, kept for line-oriented human output. */
  errors: string[];
}
