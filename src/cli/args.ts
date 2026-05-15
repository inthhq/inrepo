import { isCliError, parseCommandArgs } from 'hexbus';
import type { AddArgs, PatchArgs, SyncArgs } from './types.js';

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
        ref: { names: ['--ref'], type: 'string', valueName: 'ref' },
        save: {
          names: ['--save'],
          type: 'boolean',
          defaultValue: true,
          negatedName: '--no-save',
        },
      },
      positionals: [{ name: 'name', required: true }],
    });

    if (parsed.flags.git !== undefined && parsed.flags.git.trim() === '') {
      throw new Error('--git requires a URL');
    }
    if (parsed.flags.ref !== undefined && parsed.flags.ref.trim() === '') {
      throw new Error('--ref requires a value');
    }

    return {
      name: parsed.positionals.name,
      save: parsed.flags.save,
      git: parsed.flags.git?.trim() || undefined,
      ref: parsed.flags.ref?.trim() || undefined,
      dev: parsed.flags.dev,
    };
  } catch (error) {
    rethrowCommandArgError(error, {
      POSITIONAL_REQUIRED: 'add requires a package <name>',
      '--git': '--git requires a URL',
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
      positionals: [{ name: 'name' }],
    });

    return parsed.positionals.name === undefined ? {} : { name: parsed.positionals.name };
  } catch (error) {
    rethrowCommandArgError(error, {});
  }
}
