import { loadMirrors } from "../../config/load-config.js";
import { runMirror } from "../../mirror/run-mirror.js";
import type { MirrorOptions, MirrorResult } from "../../mirror/run-mirror.js";
import type { InrepoMirror } from "../../types/inrepo-mirror.js";
import { parseMirrorArgs } from "../args.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts } from "../types.js";
import { intro, outro, ui } from "../ui.js";

const short = (sha: string): string => sha.slice(0, 7);

const describeResult = function describeResult(
  mirror: InrepoMirror,
  result: MirrorResult,
  dryRun: boolean
): string {
  const target = `${mirror.git} (${mirror.branch})`;
  if (result.upToDate) {
    return `Mirror "${mirror.name}" is up to date with ${short(result.sourceCommit)} at ${target}`;
  }
  const commit = short(result.commit ?? "");
  if (dryRun) {
    return `Mirror "${mirror.name}": would push ${commit} (from ${short(result.sourceCommit)}) to ${target}`;
  }
  return `Mirror "${mirror.name}": pushed ${commit} (from ${short(result.sourceCommit)}) to ${target}`;
};

export const cmdMirror = async function cmdMirror(
  cwd: string,
  argv: string[] = [],
  opts: DispatchOpts = {}
): Promise<void> {
  const args = parseMirrorArgs(argv);
  if (!opts.suppressBanners) {
    printBanner();
  }

  const mirrors = await loadMirrors(cwd);
  if (mirrors.length === 0) {
    throw new Error(
      'No mirrors configured. Add a "mirrors" array to inrepo.json.'
    );
  }
  const selected =
    args.name === undefined
      ? mirrors
      : mirrors.filter((m) => m.name === args.name);
  if (selected.length === 0) {
    throw new Error(
      `No mirror named "${args.name}". Configured: ${mirrors.map((m) => m.name).join(", ")}`
    );
  }

  if (!opts.suppressBanners) {
    intro(
      `inrepo mirror — ${selected.length} mirror(s)${args.dryRun ? " (dry run)" : ""}`
    );
  }
  for (const mirror of selected) {
    const mirrorOpts: MirrorOptions = {
      dryRun: args.dryRun,
      overwrite: args.overwrite,
      ref: args.ref,
    };
    if (args.message !== undefined) {
      mirrorOpts.message = args.message;
    }
    const result = await runMirror(cwd, mirror, mirrorOpts);
    ui.message(
      `${result.includedCount} file(s) published, ${result.excludedCount} left out`
    );
    if (args.dryRun) {
      for (const change of result.changes) {
        ui.message(`  ${change.status}  ${change.path}`);
      }
    }
    ui.message(describeResult(mirror, result, args.dryRun));
  }
  if (!opts.suppressBanners) {
    outro(
      args.dryRun
        ? "Dry run complete; nothing was pushed."
        : "Mirrors published."
    );
  }
};
