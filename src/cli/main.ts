import {
  createCliContext,
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
import { showInrepoHelp } from './rendering.js';
import { error } from './ui.js';

function startUpdateCheck(context: CliContext, packageInfo: InrepoPackageInfo): void {
  startBackgroundUpdateCheck({
    appName: APP_NAME,
    currentVersion: packageInfo.version,
    logger: context.logger,
    packageName: packageInfo.name,
  });
}

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
  });

  if (context.flags.help === true) {
    showInrepoHelp(context, packageInfo, commands);
    return;
  }

  try {
    if (!context.commandName) {
      if (context.commandArgs.length > 0) {
        throw new Error(`Unknown command: ${context.commandArgs[0]}\nRun: inrepo --help`);
      }

      // Bare `inrepo` invocation:
      //   - interactive TTY: first-time init wizard if needed.
      //   - otherwise: print help. Exit 1 if uninitialized so CI/scripts get a
      //     clear pointer that something needs doing.
      if (canPromptInteractively() && !isInrepoInitialized(cwd)) {
        startUpdateCheck(context, packageInfo);
        await cmdInit(cwd);
        return;
      }

      showInrepoHelp(context, packageInfo, commands);
      if (!isInrepoInitialized(cwd)) process.exitCode = 1;
      return;
    }

    const command = commands.find((item) => item.name === context.commandName);
    if (!command) {
      throw new Error(`Unknown command: ${context.commandName}\nRun: inrepo --help`);
    }

    startUpdateCheck(context, packageInfo);
    context.telemetry.trackCommand(context.commandName, context.commandArgs, context.flags);
    await command.action(context);
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
