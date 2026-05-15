import { isLoadConfigNotFoundError, loadConfig } from '../config/load-config.js';
import { performAdd, promptAddArgs } from './commands/add.js';
import { cmdPatch } from './commands/patch.js';
import { cmdSync } from './commands/sync.js';
import { cmdVerify } from './commands/verify.js';
import { printBanner } from './rendering.js';
import { cancel, intro, isCancel, outro, select } from './ui.js';

/**
 * Bare-invocation menu: when the user runs `inrepo` with no arguments in an
 * interactive terminal and the project is already initialized, present common
 * actions and dispatch into the matching command.
 */
export async function cmdInteractive(cwd: string): Promise<void> {
  let packagesCount: number | null = null;
  try {
    const cfg = await loadConfig(cwd);
    packagesCount = cfg.packages.length;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
  }

  printBanner();
  intro('inrepo');

  type Action = 'sync' | 'add' | 'verify' | 'patch' | 'exit';
  // The default action is always `add`. Sync is destructive enough that it
  // should be a deliberate choice, never something a stray Enter triggers.
  const action = await select<Action>({
    message: 'What would you like to do?',
    initialValue: 'add',
    options: [
      {
        value: 'add',
        label: 'Add a package',
        hint: 'vendor a new git dependency',
      },
      {
        value: 'sync',
        label: `Sync packages${packagesCount != null ? ` (${packagesCount})` : ''}`,
        hint: 'clone/refresh all configured packages',
      },
      {
        value: 'verify',
        label: 'Verify lockfile',
        hint: 'check vendored dirs match the lockfile',
      },
      {
        value: 'patch',
        label: 'Patch packages',
        hint: 'capture edits into inrepo_patches',
      },
      { value: 'exit', label: 'Exit' },
    ],
  });

  if (isCancel(action) || action === 'exit') {
    cancel('Goodbye.');
    return;
  }

  try {
    if (action === 'sync') {
      await cmdSync(cwd, [], { suppressBanners: true });
      outro('Sync complete.');
    } else if (action === 'verify') {
      const ok = await cmdVerify(cwd, { suppressBanners: true });
      if (ok) {
        outro('All vendored modules match the lockfile.');
      } else {
        cancel('inrepo verify: lockfile and checkouts disagree.');
      }
    } else if (action === 'patch') {
      await cmdPatch(cwd, [], { suppressBanners: true });
      outro('Patch capture complete.');
    } else {
      const args = await promptAddArgs({ suppressBanners: true });
      if (args == null) {
        cancel('Add cancelled.');
        return;
      }
      await performAdd(cwd, args, { suppressBanners: true });
      outro(`Recorded "${args.name}" in inrepo config.`);
    }
  } catch (e) {
    const summary = e instanceof Error ? e.message.split('\n')[0] : String(e);
    cancel(`inrepo ${action} failed: ${summary}`);
    throw e;
  }
}
