import { loadMirrors } from "../../config/load-config.js";
import { redactCredentials, runMirror } from "../../mirror/run-mirror.js";
import type {
  MirrorOptions,
  MirrorResult as MirrorOutcome,
} from "../../mirror/run-mirror.js";
import type { InrepoMirror } from "../../types/inrepo-mirror.js";
import { parseMirrorArgs } from "../args.js";
import { InrepoError } from "../errors.js";
import { isDryRun } from "../output.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts, FileChange, FileChangeStatus } from "../types.js";
import { intro, outro, ui } from "../ui.js";

const short = (sha: string): string => sha.slice(0, 7);

const describeResult = function describeResult(
  mirror: InrepoMirror,
  result: MirrorOutcome,
  dryRun: boolean
): string {
  const target = redactCredentials(`${mirror.git} (${mirror.branch})`);
  if (result.upToDate) {
    return `Mirror "${mirror.name}" is up to date with ${short(result.sourceCommit)} at ${target}`;
  }
  const commit = short(result.commit ?? "");
  if (dryRun) {
    return `Mirror "${mirror.name}": would push ${commit} (from ${short(result.sourceCommit)}) to ${target}`;
  }
  return `Mirror "${mirror.name}": pushed ${commit} (from ${short(result.sourceCommit)}) to ${target}`;
};

/** One mirror's outcome, as reported under `--json`. */
export interface MirrorRunResult {
  name: string;
  /** Target URL or path, with any `user:token@` removed. */
  target: string;
  branch: string;
  /** Full source commit that was (or would be) published. */
  sourceCommit: string;
  /** Target branch tip before this run; null when the branch is new. */
  previousTip: string | null;
  /** `up-to-date`: nothing to push. `would-push` only under `--dry-run`. */
  action: "pushed" | "up-to-date" | "would-push";
  /** The mirror commit built by this run; null when up to date. */
  commit: string | null;
  /** Files published, and files left out by keep/exclude. */
  includedCount: number;
  excludedCount: number;
  /** How the target tree changes, sorted by path. Empty when up to date. */
  changes: FileChange[];
}

export interface MirrorResult {
  mirrors: MirrorRunResult[];
}

const changeStatus = function changeStatus(status: string): FileChangeStatus {
  if (status.startsWith("A")) {
    return "added";
  }
  if (status.startsWith("D")) {
    return "deleted";
  }
  return "modified";
};

export const cmdMirror = async function cmdMirror(
  cwd: string,
  argv: string[] = [],
  opts: DispatchOpts = {}
): Promise<MirrorResult> {
  const args = parseMirrorArgs(argv);
  const dryRun = isDryRun();
  if (!opts.suppressBanners) {
    printBanner();
  }

  const mirrors = await loadMirrors(cwd);
  if (mirrors.length === 0) {
    throw new InrepoError(
      "CONFIG_INVALID",
      'No mirrors configured. Add a "mirrors" array to inrepo.json.',
      { hint: 'Add a "mirrors" array to inrepo.json; see docs/mirrors.md.' }
    );
  }
  const selected =
    args.name === undefined
      ? mirrors
      : mirrors.filter((m) => m.name === args.name);
  if (selected.length === 0) {
    throw new InrepoError(
      "MIRROR_NOT_FOUND",
      `No mirror named "${args.name}". Configured: ${mirrors.map((m) => m.name).join(", ")}`,
      {
        details: { known: mirrors.map((m) => m.name), mirror: args.name ?? "" },
      }
    );
  }

  if (!opts.suppressBanners) {
    intro(
      `inrepo mirror — ${selected.length} mirror(s)${dryRun ? " (dry run)" : ""}`
    );
  }
  const results: MirrorRunResult[] = [];
  for (const mirror of selected) {
    const mirrorOpts: MirrorOptions = {
      dryRun,
      overwrite: args.overwrite,
      ref: args.ref,
    };
    if (args.message !== undefined) {
      mirrorOpts.message = args.message;
    }
    const result = await runMirror(cwd, mirror, mirrorOpts);
    ui.message(
      `Mirror "${mirror.name}": ${result.includedCount} file(s) selected, ${result.excludedCount} left out`
    );
    if (dryRun) {
      for (const change of result.changes) {
        ui.message(`  ${change.status}  ${change.path}`);
      }
    }
    ui.message(describeResult(mirror, result, dryRun));
    let action: MirrorRunResult["action"] = "pushed";
    if (result.upToDate) {
      action = "up-to-date";
    } else if (dryRun) {
      action = "would-push";
    }
    results.push({
      action,
      branch: mirror.branch,
      changes: result.changes
        .map((change) => ({
          path: change.path,
          status: changeStatus(change.status),
        }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
      commit: result.commit,
      excludedCount: result.excludedCount,
      includedCount: result.includedCount,
      name: mirror.name,
      previousTip: result.previousTip,
      sourceCommit: result.sourceCommit,
      target: redactCredentials(mirror.git),
    });
  }
  if (!opts.suppressBanners) {
    outro(
      dryRun ? "Dry run complete; nothing was pushed." : "Mirrors published."
    );
  }
  return { mirrors: results };
};
