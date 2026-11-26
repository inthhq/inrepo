import { ensureInrepoInitialized } from "../../config/ensure-inrepo-initialized.js";
import { loadConfig } from "../../config/load-config.js";
import { orderByDependencies } from "../../deps/vendored-graph.js";
import { readLockfile } from "../../lockfile/read-lockfile.js";
import { parseSyncArgs } from "../args.js";
import { InrepoError } from "../errors.js";
import { isDryRun } from "../output.js";
import { printBanner } from "../rendering.js";
import type { DispatchOpts } from "../types.js";
import { intro, outro } from "../ui.js";
import { materializePackage, planMaterialize } from "../vendor.js";
import type { MaterializeAction, MaterializeResult } from "../vendor.js";

export type { MaterializeAction, MaterializeResult } from "../vendor.js";

export interface SyncResult {
  /** One entry per configured package, in the order they were vendored. */
  packages: MaterializeResult[];
}

const countByAction = function countByAction(
  packages: MaterializeResult[]
): string {
  const counts = new Map<MaterializeAction, number>();
  for (const pkg of packages) {
    counts.set(pkg.action, (counts.get(pkg.action) ?? 0) + 1);
  }
  return [...counts].map(([action, count]) => `${count} ${action}`).join(", ");
};

export const cmdSync = async function cmdSync(
  cwd: string,
  argv: string[] = [],
  opts: DispatchOpts = {}
): Promise<SyncResult> {
  const args = parseSyncArgs(argv, opts.force);
  const dryRun = isDryRun();
  if (!opts.suppressBanners) {
    printBanner();
  }

  // First-time setup may write a config stub; a dry run must not, so it only
  // reads the config (and fails with CONFIG_NOT_FOUND when there is none).
  if (!dryRun) {
    await ensureInrepoInitialized(cwd);
  }
  const {
    packages,
    exclude: globalExclude,
    keep: globalKeep,
  } = await loadConfig(cwd);
  const { modules, graph } = await readLockfile(cwd);
  if (packages.length === 0) {
    throw new InrepoError(
      "CONFIG_INVALID",
      'Config has an empty "packages" array. Add at least one package.',
      {
        hint: "Vendor a package first: inrepo add <package>",
        nextCommand: "inrepo add <package>",
      }
    );
  }

  if (!opts.suppressBanners) {
    intro(
      `inrepo sync${dryRun ? " (dry run)" : ""} — ${packages.length} package(s)`
    );
  }
  const results: MaterializeResult[] = [];
  for (const pkg of orderByDependencies(packages, graph)) {
    const module = pkg.module ?? pkg.name;
    const materializeOpts = {
      force: args.force,
      lockEntry: modules[module],
      mode: "sync" as const,
    };
    results.push(
      dryRun
        ? await planMaterialize(cwd, pkg, materializeOpts)
        : await materializePackage(
            cwd,
            pkg,
            globalExclude,
            globalKeep,
            materializeOpts
          )
    );
  }
  if (!opts.suppressBanners) {
    outro(
      dryRun
        ? `Dry run — no files written. ${packages.length} package(s): ${countByAction(results)}.`
        : `Done. ${packages.length} package(s) synced.`
    );
  }
  return { packages: results };
};
