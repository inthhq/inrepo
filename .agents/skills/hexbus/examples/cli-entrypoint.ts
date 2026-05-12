#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import {
  CliError,
  createCliContext,
  createCliLogger,
  displayIntro,
  extendErrorCatalog,
  globalFlags,
  isVersionRequest,
  printVersionInfo,
  showHelpMenu,
  startBackgroundUpdateCheck,
  withErrorHandling,
  withSpinner,
} from "hexbus";
import type { CliCommand, CliContext } from "hexbus";

interface PackageInfo {
  name: string;
  version: string;
}

extendErrorCatalog({
  CONFIG_EXISTS: {
    code: "CONFIG_EXISTS",
    hint: "Re-run with --force to overwrite the existing configuration.",
    message: "Configuration already exists",
  },
});

function readOwnPackageInfo(): PackageInfo {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf-8")) as Record<
      string,
      unknown
    >;

    return {
      name: typeof parsed.name === "string" ? parsed.name : "my-cli",
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
    };
  } catch {
    return { name: "my-cli", version: "unknown" };
  }
}

async function initCommand(context: CliContext): Promise<void> {
  context.logger.step(1, 2, "Inspect project");

  const configPath = `${context.projectRoot}/my-cli.config.json`;
  const configExists = await context.fs.exists(configPath);

  if (configExists && !context.flags.force) {
    throw new CliError("CONFIG_EXISTS", { details: configPath });
  }

  const shouldWrite = await context.confirm("Write my-cli.config.json?", true);

  if (!shouldWrite) {
    context.error.handleCancel("No files changed.", {
      command: "init",
      stage: "confirm-write",
    });
  }

  context.logger.step(2, 2, "Write config");

  await withSpinner(
    "Creating config",
    () =>
      context.fs.write(
        configPath,
        `${JSON.stringify({ schema: 1 }, null, 2)}\n`
      ),
    {
      successMessage: "Created my-cli.config.json",
    }
  );

  context.logger.success(
    `Run ${context.packageManager.runCommand} my-cli doctor to verify setup.`
  );
}

async function doctorCommand(context: CliContext): Promise<void> {
  const packageInfo = context.fs.getPackageInfo();
  context.logger.info(`Project: ${packageInfo.name}`);
  context.logger.info(`Package manager: ${context.packageManager.name}`);

  if (context.framework.framework) {
    context.logger.info(`Framework: ${context.framework.framework}`);
  }

  context.logger.success("Project looks ready.");
}

const commands: CliCommand[] = [
  {
    action: initCommand,
    description: "Create the project configuration file.",
    hint: "Set up config",
    label: "Initialize",
    name: "init",
  },
  {
    action: doctorCommand,
    description: "Check whether the current project is ready.",
    hint: "Verify setup",
    label: "Doctor",
    name: "doctor",
  },
];

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const packageInfo = readOwnPackageInfo();

  if (isVersionRequest(rawArgs)) {
    await printVersionInfo({
      appName: "my-cli",
      currentVersion: packageInfo.version,
      packageName: packageInfo.name,
    });
    process.exit(0);
  }

  const context = await createCliContext({
    appName: "my-cli",
    commands,
    configName: "my-cli",
    rawArgs,
  });

  startBackgroundUpdateCheck({
    appName: "my-cli",
    currentVersion: packageInfo.version,
    logger: context.logger,
    packageName: packageInfo.name,
  });

  if (context.flags.help) {
    showHelpMenu(
      context,
      { appName: "my-cli", version: packageInfo.version },
      commands,
      globalFlags
    );
    process.exit(0);
  }

  await displayIntro(context, {
    appName: "my-cli",
    tagline: "Project automation for my product.",
    version: packageInfo.version,
  });

  const command = commands.find((item) => item.name === context.commandName);

  if (!command) {
    showHelpMenu(
      context,
      { appName: "my-cli", version: packageInfo.version },
      commands,
      globalFlags
    );
    process.exit(1);
  }

  await command.action(context);
}

const startupLogger = createCliLogger("error");
await withErrorHandling(main, startupLogger, { command: "startup" })();
