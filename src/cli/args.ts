import type { AddArgs, PatchArgs, SyncArgs } from './types.js';

export function parseAddArgs(argv: string[]): AddArgs {
  let save = true;
  let dev = false;
  let git: string | undefined;
  let ref: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-save') {
      save = false;
    } else if (arg === '-D' || arg === '--dev') {
      dev = true;
    } else if (arg === '--git') {
      const raw = argv[++i];
      const value = raw == null ? null : raw.trim();
      if (value == null || value === '' || value.startsWith('-')) {
        throw new Error('--git requires a URL');
      }
      git = value;
    } else if (arg === '--ref') {
      const raw = argv[++i];
      const value = raw == null ? null : raw.trim();
      if (value == null || value === '' || value.startsWith('-')) {
        throw new Error('--ref requires a value');
      }
      ref = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) throw new Error('add requires a package <name>');
  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(' ')}`);
  }

  return { name: positional[0], save, git, ref, dev };
}

export function parseSyncArgs(argv: string[], globalForce = false): SyncArgs {
  let force = globalForce;

  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      throw new Error('sync does not take arguments');
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { force };
}

export function parsePatchArgs(argv: string[]): PatchArgs {
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(' ')}`);
  }

  return { name: positional[0] };
}
