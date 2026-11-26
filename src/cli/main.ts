import nodePath from "node:path";

import {
  createCliContext,
  dispatchCommand,
  isVersionRequest,
  printVersionInfo,
  startBackgroundUpdateCheck,
} from "hexbus";
import type { CliContext } from "hexbus";

import {
  canPromptInteractively,
  InrepoSetupCancelledError,
  isInrepoInitialized,
} from "../config/ensure-inrepo-initialized.js";
import { APP_NAME, readOwnPackageInfo } from "./app-info.js";
import type { InrepoPackageInfo } from "./app-info.js";
import { commands } from "./command-table.js";
import { cmdInit } from "./commands/init.js";
import { EXIT, exitCodeFor, InrepoError, toErrorPayload } from "./errors.js";
import { cmdInteractive } from "./interactive.js";
import {
  configureOutput,
  emitFailure,
  emitResult,
  isDryRun,
  isJsonMode,
} from "./output.js";
import type { HelpData } from "./output.js";
import { inrepoGlobalFlags, showInrepoHelp } from "./rendering.js";
import { createInrepoTelemetryOptions } from "./telemetry.js";
import { error as printError } from "./ui.js";

const startUpdateCheck = function startUpdateCheck(
  context: CliContext,
  packageInfo: InrepoPackageInfo
): void {
  // Update hints are human-facing noise in a JSON session.
  if (isJsonMode()) {
    return;
  }
  startBackgroundUpdateCheck({
    appName: APP_NAME,
    currentVersion: packageInfo.version,
    logger: context.logger,
    packageName: packageInfo.name,
  });
};

const handleNoCommand = async function handleNoCommand(
  context: CliContext,
  packageInfo: InrepoPackageInfo
): Promise<void> {
  if (isJsonMode() || isDryRun()) {
    // The bare invocation can run first-time setup or an interactive menu;
    // neither has a JSON result or a dry-run preview.
    throw new InrepoError("USAGE", "No command given.", {
      hint: "Run: inrepo --help",
      nextCommand: "inrepo status --json",
    });
  }

  // Bare `inrepo` invocation:
  //   - interactive TTY: first-time init wizard if needed.
  //   - interactive TTY + initialized project: action menu.
  //   - otherwise: print help. Exit 1 if uninitialized so CI/scripts get a
  //     clear pointer that something needs doing.
  if (canPromptInteractively()) {
    if (!isInrepoInitialized(context.cwd)) {
      await cmdInit(context.cwd);
      return;
    }

    await cmdInteractive(context.cwd);
    return;
  }

  showInrepoHelp(context, packageInfo, commands);
  if (!isInrepoInitialized(context.cwd)) {
    process.exitCode = 1;
  }
};

/** Machine-readable help: the command table plus inrepo's global flags. */
const helpData = function helpData(packageInfo: InrepoPackageInfo): HelpData {
  return {
    commands: commands.map((command) => ({
      description: command.description,
      name: command.name,
    })),
    globalFlags: inrepoGlobalFlags.flatMap((flag) => flag.names),
    version: packageInfo.version,
  };
};

const reportFailure = function reportFailure(
  err: Error,
  commandName: string
): void {
  const payload = toErrorPayload(err);
  if (isJsonMode()) {
    emitFailure(commandName, payload);
  } else {
    printError(err.message);
    if (payload.hint !== undefined && !err.message.includes(payload.hint)) {
      printError(`Hint: ${payload.hint}`);
    }
  }
  // Exit-status classes are part of the --json contract. Human runs keep the
  // historical "every failure exits 1" behavior so existing scripts don't break.
  process.exitCode = isJsonMode() ? exitCodeFor(err) : EXIT.FAILURE;
};

/** Flags are parsed by hexbus later; peek early so output is routed first. */
const hasRawFlag = function hasRawFlag(
  rawArgs: string[],
  flag: string
): boolean {
  return rawArgs.includes(flag);
};

export const main = async function main(): Promise<void> {
  const cwd = nodePath.resolve(process.cwd());
  const rawArgs = process.argv.slice(2);
  const packageInfo = readOwnPackageInfo();

  configureOutput({
    dryRun: hasRawFlag(rawArgs, "--dry-run"),
    json: hasRawFlag(rawArgs, "--json"),
  });

  if (isVersionRequest(rawArgs)) {
    if (isJsonMode()) {
      emitResult("version", {
        name: packageInfo.name,
        version: packageInfo.version,
      });
      return;
    }
    await printVersionInfo({
      appName: APP_NAME,
      currentVersion: packageInfo.version,
      packageName: packageInfo.name,
    });
    return;
  }

  let context: CliContext;
  try {
    context = await createCliContext({
      appName: APP_NAME,
      commands,
      configName: APP_NAME,
      cwd,
      globalFlags: inrepoGlobalFlags,
      interactivePackageManagerDetection: false,
      rawArgs,
      telemetry: createInrepoTelemetryOptions(packageInfo),
    });
  } catch (error) {
    // Argument parsing runs inside context creation; report it as usage.
    const err = error instanceof Error ? error : new Error(String(error));
    reportFailure(
      new InrepoError("USAGE", err.message, { cause: error }),
      "inrepo"
    );
    return;
  }

  if (context.flags.help === true) {
    if (isJsonMode()) {
      emitResult("help", helpData(packageInfo));
      return;
    }
    showInrepoHelp(context, packageInfo, commands);
    return;
  }

  try {
    const result = await dispatchCommand(context, commands, {
      hooks: {
        onCommandStart: ({ commandNames, context: commandContext }) => {
          startUpdateCheck(commandContext, packageInfo);
          commandContext.telemetry.trackCommand(
            commandNames.join(" "),
            commandContext.commandArgs,
            commandContext.flags
          );
        },
      },
      noCommand: {
        action: async ({ context: noCommandContext }) => {
          await handleNoCommand(noCommandContext, packageInfo);
        },
        mode: "custom",
      },
      unknownCommand: {
        action: ({ commandName }) => {
          throw new InrepoError(
            "USAGE",
            `Unknown command: ${commandName}\nRun: inrepo --help`
          );
        },
      },
    });

    if (result.type === "command_failed") {
      throw result.error;
    }

    await context.telemetry.flush();
  } catch (error) {
    if (error instanceof InrepoSetupCancelledError) {
      // Setup already printed its own cancel banner; exit silently.
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    context.telemetry.trackError(err, context.commandName ?? "interactive");
    await context.telemetry.flush();
    reportFailure(err, context.commandName ?? "inrepo");
  }
};
