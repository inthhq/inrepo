import { resolve } from 'node:path';
import type { CliCommand } from 'hexbus';
import { cmdAdd } from './commands/add.js';
import { cmdInit } from './commands/init.js';
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
      'Capture edits from inrepo_modules back into committed overlay files under inrepo_patches/.',
    hint: 'Capture local edits',
    label: 'Patch',
    name: 'patch',
  },
  {
    action: async (context) => {
      if (context.commandArgs.length) throw new Error('verify does not take arguments');
      await cmdVerify(resolve(context.cwd));
    },
    description: 'Check vendored dirs match the lockfile plus any committed overlays.',
    hint: 'Check generated output',
    label: 'Verify',
    name: 'verify',
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
