import nodePath from "node:path";

import type { CliCommand } from "hexbus";

import { cmdAdd } from "./commands/add.js";
import { cmdDiff } from "./commands/diff.js";
import { cmdInit } from "./commands/init.js";
import { cmdMigrate } from "./commands/migrate.js";
import { cmdMirror } from "./commands/mirror.js";
import { cmdPatch } from "./commands/patch.js";
import { cmdStatus } from "./commands/status.js";
import { cmdSync } from "./commands/sync.js";
import { cmdUpdate } from "./commands/update.js";
import { cmdVerify } from "./commands/verify.js";
import { InrepoError } from "./errors.js";
import { emitFailure, emitResult, isDryRun, isJsonMode } from "./output.js";

/** Commands that honor the global `--dry-run` flag. */
const DRY_RUN_COMMANDS = new Set(["add", "sync", "patch", "update", "mirror"]);

const assertDryRunSupported = function assertDryRunSupported(
  command: string
): void {
  if (isDryRun() && !DRY_RUN_COMMANDS.has(command)) {
    throw new InrepoError(
      "USAGE",
      `--dry-run is not supported by "${command}"; it never writes anything or has no preview.`,
      { hint: `--dry-run works with: ${[...DRY_RUN_COMMANDS].join(", ")}` }
    );
  }
};

export const commands: CliCommand[] = [
  {
    action: async (context) => {
      assertDryRunSupported("init");
      const data = await cmdInit(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("init", data ?? null);
    },
    description:
      'Create an empty inrepo config (inrepo.json or package.json "inrepo"); no-op if already initialized. --agents adds inrepo guidance to AGENTS.md.',
    hint: "Create config",
    label: "Init",
    name: "init",
  },
  {
    action: async (context) => {
      assertDryRunSupported("status");
      const data = await cmdStatus(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("status", data);
    },
    description:
      "Read-only report of every vendored package: pin, patch count, uncaptured edits, and any in-progress update.",
    hint: "Show vendored package state",
    label: "Status",
    name: "status",
  },
  {
    action: async (context) => {
      const data = await cmdSync(
        nodePath.resolve(context.cwd),
        context.commandArgs,
        { force: context.flags.force === true }
      );
      emitResult("sync", data ?? null);
    },
    description:
      "Build inrepo_modules from the pinned upstream lockfile state plus any committed files in inrepo_patches/.",
    hint: "Refresh vendored packages",
    label: "Sync",
    name: "sync",
  },
  {
    action: async (context) => {
      const data = await cmdPatch(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("patch", data ?? null);
    },
    description:
      'Capture edits from inrepo_modules into inrepo_patches/ as a new numbered patch (-m "reason") or a legacy overlay.',
    hint: "Capture local edits",
    label: "Patch",
    name: "patch",
  },
  {
    action: async (context) => {
      assertDryRunSupported("diff");
      const data = await cmdDiff(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("diff", data ?? null);
    },
    description:
      "Show the effective delta between the pinned upstream commit and the patched tree, with the patch series that produced it.",
    hint: "Review vendored changes",
    label: "Diff",
    name: "diff",
  },
  {
    action: async (context) => {
      assertDryRunSupported("verify");
      if (context.commandArgs.length) {
        throw new InrepoError("USAGE", "verify does not take arguments");
      }
      const result = await cmdVerify(nodePath.resolve(context.cwd));
      if (result.ok) {
        emitResult("verify", result);
        return;
      }
      if (isJsonMode()) {
        // `data` carries the full result; `issues[].kind` is the stable,
        // per-module reason to branch on.
        const modules = [
          ...new Set(
            result.issues.flatMap((issue) =>
              issue.module == null ? [] : [issue.module]
            )
          ),
        ];
        emitFailure(
          "verify",
          {
            code: "VERIFY_FAILED",
            details: { modules },
            hint: "Rebuild with: inrepo sync (capture intended edits first with inrepo patch)",
            message: `Lockfile and checkouts disagree (${result.issues.length} issue(s)).`,
            nextCommand: "inrepo sync",
          },
          result
        );
      }
      process.exitCode = 1;
    },
    description:
      "Check vendored dirs match the lockfile plus any committed overlays.",
    hint: "Check generated output",
    label: "Verify",
    name: "verify",
  },
  {
    action: async (context) => {
      const data = await cmdUpdate(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("update", data ?? null);
    },
    description:
      "Move a package to a newer upstream commit by rebasing its patch series onto it (--ref, --continue, --abort).",
    hint: "Rebase onto new upstream",
    label: "Update",
    name: "update",
  },
  {
    action: async (context) => {
      assertDryRunSupported("migrate");
      const data = await cmdMigrate(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("migrate", data ?? null);
    },
    description:
      "Convert a package's legacy overlay files in inrepo_patches/ into an ordered git patch series.",
    hint: "Convert overlay to patches",
    label: "Migrate",
    name: "migrate",
  },
  {
    action: async (context) => {
      const data = await cmdAdd(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("add", data ?? null);
    },
    description:
      "Vendor or refresh a package pin, then rebuild its generated checkout in inrepo_modules (--with-deps also vendors its runtime dependencies).",
    hint: "Vendor a package",
    label: "Add",
    name: "add",
  },
  {
    action: async (context) => {
      const data = await cmdMirror(
        nodePath.resolve(context.cwd),
        context.commandArgs
      );
      emitResult("mirror", data);
    },
    description:
      "Publish a filtered snapshot of this repository to a configured mirror repository as one fast-forward commit (--dry-run, --ref, --overwrite).",
    hint: "Publish to a mirror repo",
    label: "Mirror",
    name: "mirror",
  },
];
