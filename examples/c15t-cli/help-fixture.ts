import type { CliCommand, CliContext, CliFlag } from "./harness-types.ts";

export const VERSION = "2.2.0";

// Descriptors from packages/cli/src/index.ts at the pinned commit. Actions are
// deliberately absent: this benchmark measures only the help renderer.
export const commands: CliCommand[] = [
  { name: "setup", description: "Set up c15t in your project." },
  {
    name: "codemods",
    description:
      "Run project codemods (for example translations -> i18n migration).",
  },
  {
    name: "skills",
    description:
      "Install c15t skills for AI-assisted development (Claude, Cursor, etc.)",
  },
  {
    name: "docs",
    description: "Open the c15t documentation in your browser.",
  },
  {
    name: "changelog",
    description: "Open the c15t changelog in your browser.",
  },
  {
    name: "self-host",
    description: "Self-host workflow commands (migrations).",
  },
  {
    name: "github",
    description: "Open our GitHub repository to give us a star.",
  },
  {
    name: "projects",
    description: "List, select, and create c15t projects.",
  },
  { name: "instances", description: "Alias for `projects`", hidden: true },
];

// Flags from packages/cli/src/context/parser.ts at the pinned commit.
export const flags: CliFlag[] = [
  {
    names: ["--help", "-h"],
    description: "Show this help message.",
    expectsValue: false,
  },
  {
    names: ["--version", "-v"],
    description: "Show the CLI version.",
    expectsValue: false,
  },
  {
    names: ["--logger"],
    description: "Set log level (fatal, error, warn, info, debug).",
    expectsValue: true,
  },
  {
    names: ["--config"],
    description: "Specify path to configuration file.",
    expectsValue: true,
  },
  {
    names: ["-y", "--yes"],
    description: "Skip confirmation prompts (use with caution).",
    expectsValue: false,
  },
  {
    names: ["--no-telemetry"],
    description: "Disable telemetry data collection.",
    expectsValue: false,
  },
  {
    names: ["--telemetry-debug"],
    description:
      "Enable debug mode for telemetry (shows detailed telemetry logs).",
    expectsValue: false,
  },
];

export const context: CliContext = {
  logger: {
    debug(_message: string): void {},
    note(message: string, title: string): void {
      console.log(`${title}\n${message}`);
    },
  },
};
