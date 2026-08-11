import { resolve } from 'node:path';
import type { CliCommand } from 'hexbus';
import { cmdAdd } from './commands/add.js';
import { cmdDiff } from './commands/diff.js';
import { cmdInit } from './commands/init.js';
import { cmdMigrate } from './commands/migrate.js';
import { cmdPatch } from './commands/patch.js';
import { cmdSync } from './commands/sync.js';
import { cmdVerify } from './commands/verify.js';

export const commands: CliCommand[] = [
  {
    action: async (context) => {
      if (context.commandArgs.length) throw new Error('init does not take arguments');
      await cmdInit(resolve(context.cwd));
    },
    description:
      'Create an empty inrepo config (inrepo.json or package.json "inrepo"); no-op if already initialized.',
    hint: 'Create config',
    label: 'Init',
    name: 'init',
  },
  {
    action: async (context) => {
      await cmdSync(resolve(context.cwd), context.commandArgs, {
        force: context.flags.force === true,
      });
    },
    description:
      'Build inrepo_modules from the pinned upstream lockfile state plus any committed files in inrepo_patches/.',
    hint: 'Refresh vendored packages',
    label: 'Sync',
    name: 'sync',
  },
  {
    action: async (context) => {
      await cmdPatch(resolve(context.cwd), context.commandArgs);
    },
    description:
      'Capture edits from inrepo_modules into inrepo_patches/ as a new numbered patch (-m "reason") or a legacy overlay.',
    hint: 'Capture local edits',
    label: 'Patch',
    name: 'patch',
  },
  {
    action: async (context) => {
      await cmdDiff(resolve(context.cwd), context.commandArgs);
    },
    description:
      'Show the effective delta between the pinned upstream commit and the patched tree, with the patch series that produced it.',
    hint: 'Review vendored changes',
    label: 'Diff',
    name: 'diff',
  },
  {
    action: async (context) => {
      if (context.commandArgs.length) throw new Error('verify does not take arguments');
      const ok = await cmdVerify(resolve(context.cwd));
      if (!ok) process.exitCode = 1;
    },
    description: 'Check vendored dirs match the lockfile plus any committed overlays.',
    hint: 'Check generated output',
    label: 'Verify',
    name: 'verify',
  },
  {
    action: async (context) => {
      await cmdMigrate(resolve(context.cwd), context.commandArgs);
    },
    description:
      'Convert a package\'s legacy overlay files in inrepo_patches/ into an ordered git patch series.',
    hint: 'Convert overlay to patches',
    label: 'Migrate',
    name: 'migrate',
  },
  {
    action: async (context) => {
      await cmdAdd(resolve(context.cwd), context.commandArgs);
    },
    description:
      'Vendor or refresh a single package pin, then rebuild its generated checkout in inrepo_modules.',
    hint: 'Vendor a package',
    label: 'Add',
    name: 'add',
  },
];
