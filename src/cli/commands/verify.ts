import { verifyLock } from "../../verify/verify-lock.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts } from "../types.js";
import { cancel, error, intro, outro, spinner } from "../ui.js";

/**
 * Returns `true` when every lockfile entry matches its checkout, `false`
 * otherwise. Callers decide whether a failed verification should set process
 * exit status or simply drive an interactive branch.
 */
export const cmdVerify = async function cmdVerify(
  cwd: string,
  opts: DispatchOpts = {}
): Promise<boolean> {
  if (!opts.suppressBanners) {
    printBanner();
    intro("inrepo verify");
  }

  const s = spinner();
  s.start("Checking lockfile entries");
  let result;
  try {
    result = await verifyLock(cwd);
  } catch (verifyError) {
    s.error("Verification failed");
    throw verifyError;
  }

  if (!result.ok) {
    s.error("Verification failed");
    for (const line of result.errors) {
      error(line);
    }
    if (!opts.suppressBanners) {
      cancel("inrepo verify: lockfile and checkouts disagree.");
    }
    return false;
  }

  // Final stop message preserves the e2e contract.
  s.stop("inrepo verify: all lockfile entries match checkouts.");
  if (!opts.suppressBanners) {
    outro("All vendored modules match the lockfile.");
  }
  return true;
};
