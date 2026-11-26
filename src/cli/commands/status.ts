import { existsSync } from "node:fs";
import nodePath from "node:path";

import { isCliError, parseCommandArgs } from "hexbus";

import { isString } from "../../json/unknown.js";
import { inrepoConfigPath } from "../../paths/inrepo-config-path.js";
import { lockfilePath } from "../../paths/lockfile-path.js";
import { packageJsonPath } from "../../paths/package-json-path.js";
import {
  assertKnownPackage,
  readKnownPackages,
} from "../../status/known-packages.js";
import type { KnownPackages } from "../../status/known-packages.js";
import { readPackageStatus } from "../../status/package-status.js";
import type { PackageStatus } from "../../status/package-status.js";
import { InrepoError } from "../errors.js";
import { isJsonMode } from "../output.js";
import { selectPackages } from "../package-selection.js";

export type {
  PackageCondition,
  PackageStatus,
  StatusCheckout,
  StatusPatch,
  StatusPatches,
  StatusUpdate,
} from "../../status/package-status.js";

/** JSON `data` of `inrepo status`. */
export interface StatusReport {
  /** Project-relative config file (`inrepo.json` or `package.json`); null without config. */
  configPath: string | null;
  /** Project-relative lockfile; null when none exists yet. */
  lockfilePath: string | null;
  packages: PackageStatus[];
  /** Every package's next actions, deduplicated, most urgent package first. */
  nextActions: string[];
}

const parseStatusArgs = function parseStatusArgs(argv: string[]): {
  name?: string;
} {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {},
      positionals: [{ name: "name" }],
    });
    const { name } = parsed.positionals;
    return isString(name) ? { name } : {};
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    const details = error.context?.details;
    const extra = isString(details) ? details : "";
    if (error.code === "UNKNOWN_OPTION") {
      throw new InrepoError("USAGE", `Unknown option: ${extra}`, {
        hint: "Usage: inrepo status [<name>] [--json]",
      });
    }
    if (error.code === "UNEXPECTED_POSITIONAL") {
      throw new InrepoError(
        "USAGE",
        "status takes at most one package <name>",
        {
          hint: "Usage: inrepo status [<name>] [--json]",
        }
      );
    }
    throw new InrepoError("USAGE", error.message, {
      hint: "Usage: inrepo status [<name>] [--json]",
    });
  }
};

const configPathOf = function configPathOf(
  cwd: string,
  known: KnownPackages
): string | null {
  if (!known.config) {
    return null;
  }
  const path =
    known.config.source === "inrepo.json"
      ? inrepoConfigPath(cwd)
      : packageJsonPath(cwd);
  return nodePath.relative(cwd, path);
};

const URGENCY: PackageStatus["condition"][] = [
  "update-in-progress",
  "diverged",
  "uncaptured-edits",
  "not-locked",
  "missing",
  "needs-sync",
  "unverified",
  "clean",
];

const projectNextActions = function projectNextActions(
  known: KnownPackages,
  packages: PackageStatus[]
): string[] {
  if (packages.length === 0) {
    return known.config ? ["inrepo add <name>"] : ["inrepo init"];
  }
  const ordered = packages.toSorted(
    (a, b) => URGENCY.indexOf(a.condition) - URGENCY.indexOf(b.condition)
  );
  return [...new Set(ordered.flatMap((pkg) => pkg.nextActions))];
};

const short = function short(commit: string | null): string {
  return commit ? commit.slice(0, 7) : "unlocked";
};

const patchLabel = function patchLabel(pkg: PackageStatus): string {
  const { patches } = pkg;
  if (patches.format === "series") {
    return `${patches.count} ${patches.count === 1 ? "patch" : "patches"}`;
  }
  if (patches.format === "overlay") {
    return `legacy overlay (${patches.count} ${patches.count === 1 ? "file" : "files"})`;
  }
  return "no patches";
};

const CONDITION_LABEL = {
  clean: "clean",
  diverged: "checkout and inrepo_patches/ both changed since the last sync",
  missing: "checkout missing",
  "needs-sync": "checkout is out of date",
  "not-locked": "not in the lockfile yet",
  "uncaptured-edits": "uncaptured edits",
  unverified: "checkout has no sync record to compare against",
  "update-in-progress": "update in progress",
} as const satisfies Record<PackageStatus["condition"], string>;

const renderPackage = function renderPackage(pkg: PackageStatus): string[] {
  const ref = pkg.ref ?? "default branch";
  const lines = [
    `${pkg.name}${pkg.dev ? " (dev)" : ""}  @ ${short(pkg.commit)} (${ref})  ${patchLabel(pkg)}`,
    `  state: ${CONDITION_LABEL[pkg.condition]}`,
  ];
  const changed = pkg.checkout.changedFiles ?? [];
  if (pkg.checkout.uncapturedEdits === true && changed.length > 0) {
    lines.push(...changed.map((file) => `    ${file}`));
  }
  if (pkg.update) {
    const { update } = pkg;
    if (update.stoppedAt) {
      const number = String(update.stoppedAt.number).padStart(4, "0");
      lines.push(
        `  stopped on patch ${number} "${update.stoppedAt.subject}" (resolve in ${update.repoPath})`
      );
    }
    if (update.unresolvedFiles.length > 0) {
      lines.push(
        "  unresolved conflicts:",
        ...update.unresolvedFiles.map((file) => `    ${file}`)
      );
    } else if (update.readyToContinue) {
      lines.push("  conflicts resolved; ready to continue");
    }
  }
  for (const action of pkg.nextActions) {
    lines.push(`  next: ${action}`);
  }
  return lines;
};

const renderReport = function renderReport(report: StatusReport): void {
  if (report.packages.length === 0) {
    console.log(
      report.configPath
        ? `No vendored packages in ${report.configPath}.`
        : "No inrepo config or lockfile in this directory."
    );
    for (const action of report.nextActions) {
      console.log(`next: ${action}`);
    }
    return;
  }
  const blocks = report.packages.map((pkg) => renderPackage(pkg).join("\n"));
  console.log(blocks.join("\n\n"));
};

/**
 * Read-only report of every vendored package: pin, patches, whether the
 * checkout has uncaptured edits, any paused update, and the command that
 * moves each one forward. Never fetches and never writes to the project.
 */
export const cmdStatus = async function cmdStatus(
  cwd: string,
  argv: string[] = []
): Promise<StatusReport> {
  const args = parseStatusArgs(argv);
  const known =
    args.name === undefined
      ? await readKnownPackages(cwd)
      : await assertKnownPackage(cwd, args.name);

  const lock = lockfilePath(cwd);
  let packages: PackageStatus[] = [];
  if (known.names.length > 0) {
    const selection = await selectPackages(cwd, args.name, "inspect");
    const configured = new Set(
      (known.config?.packages ?? []).map((pkg) => pkg.module ?? pkg.name)
    );
    packages = await Promise.all(
      selection.packages.map(
        async (pkg) =>
          await readPackageStatus({
            configured: configured.has(pkg.module ?? pkg.name),
            cwd,
            globalExclude: selection.globalExclude,
            globalKeep: selection.globalKeep,
            lockEntry: selection.modules[pkg.module ?? pkg.name],
            pkg,
          })
      )
    );
  }

  const report: StatusReport = {
    configPath: configPathOf(cwd, known),
    lockfilePath: existsSync(lock) ? nodePath.relative(cwd, lock) : null,
    nextActions: projectNextActions(known, packages),
    packages,
  };
  // Agents read the envelope; the human listing would only be stderr noise.
  if (!isJsonMode()) {
    renderReport(report);
  }
  return report;
};
