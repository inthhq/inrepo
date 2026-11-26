import { existsSync } from "node:fs";

import { isCliError, parseCommandArgs } from "hexbus";

import { writeAgentsGuidance } from "../../agents/agents-block.js";
import type { AgentsResult } from "../../agents/agents-block.js";
import {
  ensureInrepoInitialized,
  isInrepoInitialized,
} from "../../config/ensure-inrepo-initialized.js";
import { isString } from "../../json/unknown.js";
import { inrepoConfigPath } from "../../paths/inrepo-config-path.js";
import { InrepoError } from "../errors.js";
import { printBanner } from "../rendering.js";
import { ui } from "../ui.js";

export type {
  AgentsFileAction,
  AgentsFileResult,
  AgentsResult,
} from "../../agents/agents-block.js";

/** JSON `data` of `inrepo init`. */
export interface InitResult {
  /** True when this run created the config. */
  initialized: boolean;
  /** True when the project already had inrepo config before this run. */
  alreadyInitialized: boolean;
  /** Project-relative config file (`inrepo.json` or `package.json`); null when none exists. */
  configPath: "inrepo.json" | "package.json" | null;
  /** Files `--agents` wrote; null without `--agents`. */
  agents: AgentsResult | null;
}

interface InitArgs {
  agents: boolean;
}

const INIT_USAGE = "Usage: inrepo init [--agents]";

const parseInitArgs = function parseInitArgs(argv: string[]): InitArgs {
  try {
    const parsed = parseCommandArgs(argv, {
      flags: {
        agents: {
          defaultValue: false,
          names: ["--agents"],
          type: "boolean",
        },
      },
    });
    return { agents: parsed.flags.agents };
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    const details = error.context?.details;
    const extra = isString(details) ? details : "";
    if (error.code === "UNKNOWN_OPTION") {
      throw new InrepoError("USAGE", `Unknown option: ${extra}`, {
        hint: INIT_USAGE,
      });
    }
    if (error.code === "UNEXPECTED_POSITIONAL") {
      throw new InrepoError("USAGE", "init does not take arguments", {
        hint: INIT_USAGE,
      });
    }
    throw new InrepoError("USAGE", error.message, { hint: INIT_USAGE });
  }
};

const configPathOf = function configPathOf(
  cwd: string
): InitResult["configPath"] {
  if (existsSync(inrepoConfigPath(cwd))) {
    return "inrepo.json";
  }
  return isInrepoInitialized(cwd) ? "package.json" : null;
};

const reportAgents = function reportAgents(agents: AgentsResult): void {
  for (const file of agents.files) {
    ui.info(`${file.path}: inrepo guidance ${file.action}`);
  }
};

/**
 * Create an empty inrepo config (no-op when one exists). With `--agents`,
 * also upsert the inrepo guidance block into AGENTS.md (and CLAUDE.md when it
 * does not already defer to AGENTS.md) once config exists.
 */
export const cmdInit = async function cmdInit(
  cwd: string,
  argv: string[] = []
): Promise<InitResult> {
  const args = parseInitArgs(argv);
  printBanner();

  const alreadyInitialized = isInrepoInitialized(cwd);
  let initialized = false;
  if (alreadyInitialized) {
    ui.info("inrepo is already initialized in this project.");
  } else {
    // Config comes first. If setup cannot run (no terminal and no
    // INREPO_CONFIG), this throws CONFIG_NOT_FOUND before --agents writes
    // anything, so a failed init never leaves half its work behind.
    await ensureInrepoInitialized(cwd);
    initialized = isInrepoInitialized(cwd);
    // ensureInrepoInitialized already prints intro/outro on success.
    ui.message(
      'Next: run `inrepo add <name>` to pin a package, or edit the config and run `inrepo sync`; later use `inrepo patch <name> -m "reason"` to capture shared changes.'
    );
  }

  let agents: AgentsResult | null = null;
  if (args.agents) {
    agents = await writeAgentsGuidance(cwd);
    reportAgents(agents);
  }

  return {
    agents,
    alreadyInitialized,
    configPath: configPathOf(cwd),
    initialized,
  };
};
