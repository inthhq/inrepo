import type { CliCommand, CliContext, CliFlag } from "./harness-types.ts";

export const VERSION = "2.2.0";

// Descriptors from packages/cli/src/index.ts at the pinned commit. Actions are
// deliberately absent: this benchmark measures only the help renderer.
export const commands: CliCommand[] = [
  { description: "Set up c15t in your project.", name: "setup" },
  {
    description:
      "Run project codemods (for example translations -> i18n migration).",
    name: "codemods",
  },
  {
    description:
      "Install c15t skills for AI-assisted development (Claude, Cursor, etc.)",
    name: "skills",
  },
  {
    description: "Open the c15t documentation in your browser.",
    name: "docs",
  },
  {
    description: "Open the c15t changelog in your browser.",
    name: "changelog",
  },
  {
    description: "Self-host workflow commands (migrations).",
    name: "self-host",
  },
  {
    description: "Open our GitHub repository to give us a star.",
    name: "github",
  },
  {
    description: "List, select, and create c15t projects.",
    name: "projects",
  },
  { description: "Alias for `projects`", hidden: true, name: "instances" },
];

// Flags from packages/cli/src/context/parser.ts at the pinned commit.
export const flags: CliFlag[] = [
  {
    description: "Show this help message.",
    expectsValue: false,
    names: ["--help", "-h"],
  },
  {
    description: "Show the CLI version.",
    expectsValue: false,
    names: ["--version", "-v"],
  },
  {
    description: "Set log level (fatal, error, warn, info, debug).",
    expectsValue: true,
    names: ["--logger"],
  },
  {
    description: "Specify path to configuration file.",
    expectsValue: true,
    names: ["--config"],
  },
  {
    description: "Skip confirmation prompts (use with caution).",
    expectsValue: false,
    names: ["-y", "--yes"],
  },
  {
    description: "Disable telemetry data collection.",
    expectsValue: false,
    names: ["--no-telemetry"],
  },
  {
    description:
      "Enable debug mode for telemetry (shows detailed telemetry logs).",
    expectsValue: false,
    names: ["--telemetry-debug"],
  },
];

export const context: CliContext = {
  logger: {
    debug(_message: string): void {
      /* empty */
    },
    note(message: string, title: string): void {
      console.log(`${title}\n${message}`);
    },
  },
};
