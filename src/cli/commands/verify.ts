import type { VerifyResult } from "../../types/verify-result.js";
import { verifyLock } from "../../verify/verify-lock.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts } from "../types.js";
import { cancel, error, intro, outro, spinner } from "../ui.js";

export type {
  VerifyIssue,
  VerifyIssueKind,
  VerifyResult,
  VerifyTreeDrift,
} from "../../types/verify-result.js";

/**
 * Returns `{ ok: true, issues: [] }` when every lockfile entry matches its
 * checkout, `{ ok: false, issues }` otherwise. Each issue names its module and
 * a stable `kind`; `errors` repeats the messages for line-oriented output.
 * Callers decide whether a failed verification should set process exit status
 * or simply drive an interactive branch.
 */
export const cmdVerify = async function cmdVerify(
  cwd: string,
  opts: DispatchOpts = {}
): Promise<VerifyResult> {
  if (!opts.suppressBanners) {
    printBanner();
    intro("inrepo verify");
  }

  const s = spinner();
  s.start("Checking lockfile entries");
  let result: VerifyResult;
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
    return result;
  }

  // Final stop message preserves the e2e contract.
  s.stop("inrepo verify: all lockfile entries match checkouts.");
  if (!opts.suppressBanners) {
    outro("All vendored modules match the lockfile.");
  }
  return result;
};
