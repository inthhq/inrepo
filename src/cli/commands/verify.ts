import { verifyLock } from '../../verify/verify-lock.js';
import { printBanner } from '../rendering.js';
import type { DispatchOpts } from '../types.js';
import { cancel, error, intro, outro, spinner } from '../ui.js';

/**
 * Returns `true` when every lockfile entry matches its checkout, `false`
 * otherwise. Also sets `process.exitCode = 1` on failure so standalone
 * invocations surface the correct shell exit code. Interactive callers should
 * branch on the return value rather than reading global process state.
 */
export async function cmdVerify(cwd: string, opts: DispatchOpts = {}): Promise<boolean> {
  if (!opts.suppressBanners) {
    printBanner();
    intro('inrepo verify');
  }

  const s = spinner();
  s.start('Checking lockfile entries');
  let result;
  try {
    result = await verifyLock(cwd);
  } catch (e) {
    s.error('Verification failed');
    process.exitCode = 1;
    throw e;
  }

  if (!result.ok) {
    s.error('Verification failed');
    for (const line of result.errors) {
      error(line);
    }
    if (!opts.suppressBanners) {
      cancel('inrepo verify: lockfile and checkouts disagree.');
    }
    process.exitCode = 1;
    return false;
  }

  // Final stop message preserves the e2e contract.
  s.stop('inrepo verify: all lockfile entries match checkouts.');
  if (!opts.suppressBanners) outro('All vendored modules match the lockfile.');
  return true;
}
