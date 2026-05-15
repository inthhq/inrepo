import {
  createCliContext,
  dispatchCommand,
  isVersionRequest,
  printVersionInfo,
  startBackgroundUpdateCheck,
  type CliContext,
} from 'hexbus';
import { resolve } from 'node:path';
import {
  canPromptInteractively,
  InrepoSetupCancelledError,
  isInrepoInitialized,
} from '../config/ensure-inrepo-initialized.js';
import { APP_NAME, readOwnPackageInfo, type InrepoPackageInfo } from './app-info.js';
import { cmdInit } from './commands/init.js';
import { commands } from './command-table.js';
import { cmdInteractive } from './interactive.js';
import { showInrepoHelp } from './rendering.js';
import { createInrepoTelemetryOptions } from './telemetry.js';
import { error } from './ui.js';

export async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const rawArgs = process.argv.slice(2);
  const packageInfo = readOwnPackageInfo();

  if (isVersionRequest(rawArgs)) {
    await printVersionInfo({
      appName: APP_NAME,
      currentVersion: packageInfo.version,
      packageName: packageInfo.name,
    });
    return;
  }

  const context = await createCliContext({
    appName: APP_NAME,
    commands,
    configName: APP_NAME,
    cwd,
    interactivePackageManagerDetection: false,
    rawArgs,
    telemetry: createInrepoTelemetryOptions(packageInfo),
  });

  if (context.flags.help === true) {
    showInrepoHelp(context, packageInfo, commands);
    return;
  }

  try {
    const result = await dispatchCommand(context, commands, {
      hooks: {
        onCommandStart: ({ commandNames, context: commandContext }) => {
          startUpdateCheck(commandContext, packageInfo);
          commandContext.telemetry.trackCommand(
            commandNames.join(' '),
            commandContext.commandArgs,
            commandContext.flags,
          );
        },
      },
      noCommand: {
        mode: 'custom',
        action: async ({ context: noCommandContext }) => {
          await handleNoCommand(noCommandContext, packageInfo);
        },
      },
      unknownCommand: {
        action: ({ commandName }) => {
          throw new Error(`Unknown command: ${commandName}\nRun: inrepo --help`);
        },
      },
    });

    if (result.type === 'command_failed') {
      throw result.error;
    }

    await context.telemetry.flush();
  } catch (e) {
    if (e instanceof InrepoSetupCancelledError) {
      // Setup already printed its own cancel banner; exit silently.
      return;
    }

    const err = e instanceof Error ? e : new Error(String(e));
    context.telemetry.trackError(err, context.commandName ?? 'interactive');
    await context.telemetry.flush();
    error(err.message);
    process.exitCode = 1;
  }
}

function startUpdateCheck(context: CliContext, packageInfo: InrepoPackageInfo): void {
  startBackgroundUpdateCheck({
    appName: APP_NAME,
    currentVersion: packageInfo.version,
    logger: context.logger,
    packageName: packageInfo.name,
  });
}

async function handleNoCommand(
  context: CliContext,
  packageInfo: InrepoPackageInfo,
): Promise<void> {
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
}
