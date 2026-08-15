import { isCliError, parseCommandArgs } from "hexbus";
import type { CliError } from "hexbus";

import { isString } from "../json/unknown.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type {
  AddArgs,
  DiffArgs,
  MigrateArgs,
  PatchArgs,
  SyncArgs,
  UpdateArgs,
} from "./types.js";

const parserDetails = function parserDetails(error: CliError): string {
  const details = error.context?.details;
  return isString(details) ? details : "";
};

const rethrowCommandArgError = function rethrowCommandArgError(
  error: CliError,
  messages: Partial<Record<string, string>>
): never {
  const details = parserDetails(error);
  if (error.code === "UNKNOWN_OPTION") {
    throw new Error(`Unknown option: ${details}`);
  }
  if (error.code === "UNEXPECTED_POSITIONAL") {
    throw new Error(
      messages.UNEXPECTED_POSITIONAL ?? `Unexpected arguments: ${details}`
    );
  }
  if (error.code === "POSITIONAL_REQUIRED" && messages.POSITIONAL_REQUIRED) {
    throw new Error(messages.POSITIONAL_REQUIRED);
  }
  if (error.code === "FLAG_VALUE_REQUIRED" && messages[details]) {
    throw new Error(messages[details]);
  }

  throw error;
};

export const parseAddArgs = function parseAddArgs(argv: string[]): AddArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        dev: { defaultValue: false, names: ["-D", "--dev"], type: "boolean" },
        git: { names: ["--git"], type: "string", valueName: "url" },
        ref: { names: ["--ref"], type: "string", valueName: "ref" },
        repositoryDirectory: {
          names: ["--repository-directory"],
          type: "string",
          valueName: "path",
        },
        save: {
          defaultValue: true,
          names: ["--save"],
          negatedName: "--no-save",
          type: "boolean",
        },
        withDeps: {
          defaultValue: false,
          names: ["--with-deps"],
          type: "boolean",
        },
      },
      positionals: [{ name: "name", required: true }],
    });

    if (parsed.flags.git !== undefined && parsed.flags.git.trim() === "") {
      throw new Error("--git requires a URL");
    }
    if (parsed.flags.ref !== undefined && parsed.flags.ref.trim() === "") {
      throw new Error("--ref requires a value");
    }
    const repositoryDirectory =
      parsed.flags.repositoryDirectory === undefined
        ? undefined
        : normalizeRepositoryDirectory(
            parsed.flags.repositoryDirectory,
            "--repository-directory"
          );
    if (
      parsed.flags.repositoryDirectory !== undefined &&
      repositoryDirectory == null
    ) {
      throw new Error("--repository-directory requires a package subdirectory");
    }
    // The dependency graph is only replayable from committed files, so there is
    // nothing meaningful `--with-deps --no-save` could leave behind.
    if (parsed.flags.withDeps && !parsed.flags.save) {
      throw new Error("--with-deps cannot be combined with --no-save");
    }

    const args: AddArgs = {
      dev: parsed.flags.dev,
      git: parsed.flags.git?.trim() || undefined,
      name: parsed.positionals.name,
      ref: parsed.flags.ref?.trim() || undefined,
      save: parsed.flags.save,
      withDeps: parsed.flags.withDeps,
    };
    if (repositoryDirectory != null) {
      args.repositoryDirectory = repositoryDirectory;
    }
    return args;
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      "--git": "--git requires a URL",
      "--ref": "--ref requires a value",
      "--repository-directory": "--repository-directory requires a path",
      POSITIONAL_REQUIRED: "add requires a package <name>",
    });
  }
};

export const parseSyncArgs = function parseSyncArgs(
  argv: string[],
  globalForce = false
): SyncArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        force: {
          defaultValue: globalForce,
          names: ["--force"],
          type: "boolean",
        },
      },
    });

    return { force: parsed.flags.force };
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      UNEXPECTED_POSITIONAL: "sync does not take arguments",
    });
  }
};

export const parsePatchArgs = function parsePatchArgs(
  argv: string[]
): PatchArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        message: {
          names: ["-m", "--message"],
          type: "string",
          valueName: "reason",
        },
      },
      positionals: [{ name: "name" }],
    });

    const message = parsed.flags.message?.trim();
    if (parsed.flags.message !== undefined && !message) {
      throw new Error("-m requires a message");
    }

    const args: PatchArgs = {};
    if (parsed.positionals.name !== undefined) {
      args.name = parsed.positionals.name;
    }
    if (message) {
      args.message = message;
    }
    return args;
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      "--message": "-m requires a message",
      "-m": "-m requires a message",
    });
  }
};

export const parseDiffArgs = function parseDiffArgs(argv: string[]): DiffArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        stat: { defaultValue: false, names: ["--stat"], type: "boolean" },
      },
      positionals: [{ name: "name" }],
    });

    const args: DiffArgs = {
      stat: parsed.flags.stat,
    };
    if (parsed.positionals.name !== undefined) {
      args.name = parsed.positionals.name;
    }
    return args;
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      UNEXPECTED_POSITIONAL: "diff takes a single package <name>",
    });
  }
};

export const parseUpdateArgs = function parseUpdateArgs(
  argv: string[]
): UpdateArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        abort: { defaultValue: false, names: ["--abort"], type: "boolean" },
        continue: {
          defaultValue: false,
          names: ["--continue"],
          type: "boolean",
        },
        ref: { names: ["--ref"], type: "string", valueName: "ref" },
      },
      positionals: [{ name: "name", required: true }],
    });

    const ref = parsed.flags.ref?.trim();
    if (parsed.flags.ref !== undefined && !ref) {
      throw new Error("--ref requires a value");
    }
    if (parsed.flags.continue && parsed.flags.abort) {
      throw new Error("update takes either --continue or --abort, not both");
    }
    if (ref && (parsed.flags.continue || parsed.flags.abort)) {
      throw new Error("--ref cannot be combined with --continue or --abort");
    }

    const args: UpdateArgs = {
      abort: parsed.flags.abort,
      continue: parsed.flags.continue,
      name: parsed.positionals.name,
    };
    if (ref) {
      args.ref = ref;
    }
    return args;
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      "--ref": "--ref requires a value",
      POSITIONAL_REQUIRED: "update requires a package <name>",
      UNEXPECTED_POSITIONAL: "update takes a single package <name>",
    });
  }
};

export const parseMigrateArgs = function parseMigrateArgs(
  argv: string[]
): MigrateArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      positionals: [{ name: "name", required: true }],
    });

    return { name: parsed.positionals.name };
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    return rethrowCommandArgError(error, {
      POSITIONAL_REQUIRED: "migrate requires a package <name>",
      UNEXPECTED_POSITIONAL: "migrate takes a single package <name>",
    });
  }
};
