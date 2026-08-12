import { isCliError, parseCommandArgs } from 'hexbus';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';
import type { AddArgs, DiffArgs, MigrateArgs, PatchArgs, SyncArgs, UpdateArgs } from './types.js';

function parserDetails(error: unknown): string {
  if (!isCliError(error)) return '';
  const details = error.context?.details;
  return typeof details === 'string' ? details : '';
}

function rethrowCommandArgError(error: unknown, messages: Partial<Record<string, string>>): never {
  if (!isCliError(error)) throw error;

  const details = parserDetails(error);
  if (error.code === 'UNKNOWN_OPTION') {
    throw new Error(`Unknown option: ${details}`);
  }
  if (error.code === 'UNEXPECTED_POSITIONAL') {
    throw new Error(messages.UNEXPECTED_POSITIONAL ?? `Unexpected arguments: ${details}`);
  }
  if (error.code === 'POSITIONAL_REQUIRED' && messages.POSITIONAL_REQUIRED) {
    throw new Error(messages.POSITIONAL_REQUIRED);
  }
  if (error.code === 'FLAG_VALUE_REQUIRED' && messages[details]) {
    throw new Error(messages[details]);
  }

  throw error;
}

export function parseAddArgs(argv: string[]): AddArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        dev: { names: ['-D', '--dev'], type: 'boolean', defaultValue: false },
        git: { names: ['--git'], type: 'string', valueName: 'url' },
        repositoryDirectory: {
          names: ['--repository-directory'],
          type: 'string',
          valueName: 'path',
        },
        ref: { names: ['--ref'], type: 'string', valueName: 'ref' },
        save: {
          names: ['--save'],
          type: 'boolean',
          defaultValue: true,
          negatedName: '--no-save',
        },
        withDeps: { names: ['--with-deps'], type: 'boolean', defaultValue: false },
      },
      positionals: [{ name: 'name', required: true }],
    });

    if (parsed.flags.git !== undefined && parsed.flags.git.trim() === '') {
      throw new Error('--git requires a URL');
    }
    if (parsed.flags.ref !== undefined && parsed.flags.ref.trim() === '') {
      throw new Error('--ref requires a value');
    }
    const repositoryDirectory =
      parsed.flags.repositoryDirectory === undefined
        ? undefined
        : normalizeRepositoryDirectory(parsed.flags.repositoryDirectory, '--repository-directory');
    if (parsed.flags.repositoryDirectory !== undefined && repositoryDirectory == null) {
      throw new Error('--repository-directory requires a package subdirectory');
    }
    // The dependency graph is only replayable from committed files, so there is
    // nothing meaningful `--with-deps --no-save` could leave behind.
    if (parsed.flags.withDeps && !parsed.flags.save) {
      throw new Error('--with-deps cannot be combined with --no-save');
    }

    return {
      name: parsed.positionals.name,
      save: parsed.flags.save,
      git: parsed.flags.git?.trim() || undefined,
      ...(repositoryDirectory == null ? {} : { repositoryDirectory }),
      ref: parsed.flags.ref?.trim() || undefined,
      dev: parsed.flags.dev,
      withDeps: parsed.flags.withDeps,
    };
  } catch (error) {
    rethrowCommandArgError(error, {
      POSITIONAL_REQUIRED: 'add requires a package <name>',
      '--git': '--git requires a URL',
      '--repository-directory': '--repository-directory requires a path',
      '--ref': '--ref requires a value',
    });
  }
}

export function parseSyncArgs(argv: string[], globalForce = false): SyncArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        force: { names: ['--force'], type: 'boolean', defaultValue: globalForce },
      },
    });

    return { force: parsed.flags.force };
  } catch (error) {
    rethrowCommandArgError(error, {
      UNEXPECTED_POSITIONAL: 'sync does not take arguments',
    });
  }
}

export function parsePatchArgs(argv: string[]): PatchArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        message: { names: ['-m', '--message'], type: 'string', valueName: 'reason' },
      },
      positionals: [{ name: 'name' }],
    });

    const message = parsed.flags.message?.trim();
    if (parsed.flags.message !== undefined && !message) {
      throw new Error('-m requires a message');
    }

    return {
      ...(parsed.positionals.name === undefined ? {} : { name: parsed.positionals.name }),
      ...(message ? { message } : {}),
    };
  } catch (error) {
    rethrowCommandArgError(error, {
      '-m': '-m requires a message',
      '--message': '-m requires a message',
    });
  }
}

export function parseDiffArgs(argv: string[]): DiffArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        stat: { names: ['--stat'], type: 'boolean', defaultValue: false },
      },
      positionals: [{ name: 'name' }],
    });

    return {
      ...(parsed.positionals.name === undefined ? {} : { name: parsed.positionals.name }),
      stat: parsed.flags.stat,
    };
  } catch (error) {
    rethrowCommandArgError(error, {
      UNEXPECTED_POSITIONAL: 'diff takes a single package <name>',
    });
  }
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        ref: { names: ['--ref'], type: 'string', valueName: 'ref' },
        continue: { names: ['--continue'], type: 'boolean', defaultValue: false },
        abort: { names: ['--abort'], type: 'boolean', defaultValue: false },
      },
      positionals: [{ name: 'name', required: true }],
    });

    const ref = parsed.flags.ref?.trim();
    if (parsed.flags.ref !== undefined && !ref) {
      throw new Error('--ref requires a value');
    }
    if (parsed.flags.continue && parsed.flags.abort) {
      throw new Error('update takes either --continue or --abort, not both');
    }
    if (ref && (parsed.flags.continue || parsed.flags.abort)) {
      throw new Error('--ref cannot be combined with --continue or --abort');
    }

    return {
      name: parsed.positionals.name,
      ...(ref ? { ref } : {}),
      continue: parsed.flags.continue,
      abort: parsed.flags.abort,
    };
  } catch (error) {
    rethrowCommandArgError(error, {
      POSITIONAL_REQUIRED: 'update requires a package <name>',
      UNEXPECTED_POSITIONAL: 'update takes a single package <name>',
      '--ref': '--ref requires a value',
    });
  }
}

export function parseMigrateArgs(argv: string[]): MigrateArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      positionals: [{ name: 'name', required: true }],
    });

    return { name: parsed.positionals.name };
  } catch (error) {
    rethrowCommandArgError(error, {
      POSITIONAL_REQUIRED: 'migrate requires a package <name>',
      UNEXPECTED_POSITIONAL: 'migrate takes a single package <name>',
    });
  }
}
