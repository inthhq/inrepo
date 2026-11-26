import type { JsonObject } from "../json/unknown.js";

/**
 * Typed, machine-readable failures.
 *
 * Every failure an agent or script may want to branch on carries a stable
 * `code`, a process exit status class, an optional recovery `hint`, and an
 * optional `nextCommand` that would move the project forward. Plain `Error`s
 * still work; they surface as code `ERROR` with exit status 1.
 */

/**
 * Exit status classes, used under `--json` (stable contract; documented in
 * docs-src/agents.mdx). Without `--json` every failure exits 1.
 */
export const EXIT = {
  /** A check failed (verify drift) or an unclassified error occurred. */
  FAILURE: 1,
  /** Work is paused and needs resolution (rebase conflict, uncaptured edits). */
  NEEDS_RESOLUTION: 3,
  /** Success. */
  OK: 0,
  /** Upstream, registry, or network failure. Often worth a retry. */
  UPSTREAM: 4,
  /** Bad CLI usage, or invalid/missing config or lockfile. Fix the input. */
  USAGE: 2,
} as const;

export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

interface ErrorCodeSpec {
  exit: ExitStatus;
  /** Default hint used when the throw site does not supply one. */
  hint?: string;
}

/**
 * Catalog of stable error codes. Adding a code is fine; renaming or removing
 * one is a breaking change for agents and scripts.
 */
export const ERROR_CODES = {
  /** Config exists but is malformed or fails validation. */
  CONFIG_INVALID: { exit: EXIT.USAGE },
  /** No inrepo config in this project. */
  CONFIG_NOT_FOUND: {
    exit: EXIT.USAGE,
    hint: "Run: inrepo init",
  },
  /** Unclassified failure. */
  ERROR: { exit: EXIT.FAILURE },
  /** The action needs a prompt, but the session is non-interactive. */
  INTERACTIVE_REQUIRED: { exit: EXIT.USAGE },
  /** Lockfile is malformed or references something inconsistent. */
  LOCKFILE_INVALID: { exit: EXIT.USAGE },
  /** The clone lacks the history needed to check the last mirrored commit. */
  MIRROR_HISTORY_MISSING: {
    exit: EXIT.USAGE,
    hint: "Fetch full history (for example, actions/checkout with fetch-depth: 0)",
  },
  /** No mirror with that name in the config. */
  MIRROR_NOT_FOUND: {
    exit: EXIT.USAGE,
    hint: 'Check the "mirrors" array in the config',
  },
  /**
   * The mirror target has changes inrepo did not make, was written by another
   * mirror, or would be rolled back. `details.reason` says which.
   */
  MIRROR_TARGET_CHANGED: {
    exit: EXIT.NEEDS_RESOLUTION,
    hint: "Port any changes made on the target into this repository, then rerun with --overwrite",
  },
  /** `--continue`/`--abort` with no update in progress. */
  NO_UPDATE_IN_PROGRESS: { exit: EXIT.USAGE },
  /** Named package is not in the config or lockfile. */
  PACKAGE_NOT_FOUND: {
    exit: EXIT.USAGE,
    hint: "Run: inrepo status --json to list known packages",
  },
  /** A patch in the series no longer applies to the pinned commit. */
  PATCH_APPLY_FAILED: { exit: EXIT.NEEDS_RESOLUTION },
  /** inrepo_modules/<pkg> has edits not captured into inrepo_patches/. */
  UNCAPTURED_EDITS: {
    exit: EXIT.NEEDS_RESOLUTION,
    hint: 'Capture them first: inrepo patch <package> -m "<reason>"',
  },
  /** `inrepo update` stopped on a rebase conflict. */
  UPDATE_CONFLICT: { exit: EXIT.NEEDS_RESOLUTION },
  /** An update is already in progress for this package. */
  UPDATE_IN_PROGRESS: {
    exit: EXIT.NEEDS_RESOLUTION,
    hint: "Finish it with: inrepo update <package> --continue, or drop it with --abort",
  },
  /** Git remote, npm registry, or network failure. */
  UPSTREAM_UNAVAILABLE: { exit: EXIT.UPSTREAM },
  /** Unknown command, unknown option, missing or unexpected argument. */
  USAGE: { exit: EXIT.USAGE, hint: "Run: inrepo --help" },
  /** `inrepo verify` found checkouts that disagree with the lockfile. */
  VERIFY_FAILED: {
    exit: EXIT.FAILURE,
    hint: "Rebuild with: inrepo sync (capture intended edits first with inrepo patch)",
  },
} as const satisfies Record<string, ErrorCodeSpec>;

export type InrepoErrorCode = keyof typeof ERROR_CODES;

export interface InrepoErrorOptions {
  /** Recovery guidance; falls back to the catalog default for the code. */
  hint?: string;
  /** A concrete command that would move the project forward. */
  nextCommand?: string;
  /** Structured, JSON-serializable details (files, package names, paths). */
  details?: JsonObject;
  cause?: unknown;
}

export class InrepoError extends Error {
  readonly code: InrepoErrorCode;
  readonly exitCode: ExitStatus;
  readonly hint?: string;
  readonly nextCommand?: string;
  readonly details?: JsonObject;

  constructor(
    code: InrepoErrorCode,
    message: string,
    options: InrepoErrorOptions = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "InrepoError";
    this.code = code;
    const spec: ErrorCodeSpec = ERROR_CODES[code];
    this.exitCode = spec.exit;
    this.hint = options.hint ?? spec.hint;
    this.nextCommand = options.nextCommand;
    this.details = options.details;
  }
}

export const isInrepoError = function isInrepoError(
  error: Error
): error is InrepoError {
  return error instanceof InrepoError;
};

/** JSON shape of a failure, as emitted under `--json`. */
export interface ErrorPayload {
  code: InrepoErrorCode;
  message: string;
  hint?: string;
  nextCommand?: string;
  details?: JsonObject;
}

export const toErrorPayload = function toErrorPayload(
  error: Error
): ErrorPayload {
  if (isInrepoError(error)) {
    const payload: ErrorPayload = { code: error.code, message: error.message };
    if (error.hint !== undefined) {
      payload.hint = error.hint;
    }
    if (error.nextCommand !== undefined) {
      payload.nextCommand = error.nextCommand;
    }
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return payload;
  }
  return { code: "ERROR", message: error.message };
};

export const exitCodeFor = function exitCodeFor(error: Error): ExitStatus {
  return isInrepoError(error) ? error.exitCode : EXIT.FAILURE;
};
