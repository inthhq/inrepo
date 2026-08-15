import {
  isLoadConfigNotFoundError,
  loadConfig,
} from "../config/load-config.js";
import { performAdd, promptAddArgs } from "./commands/add.js";
import { cmdPatch } from "./commands/patch.js";
import { cmdSync } from "./commands/sync.js";
import { cmdVerify } from "./commands/verify.js";
import { printBanner } from "./rendering.js";
import { cancel, intro, isCancel, outro, select, text } from "./ui.js";

/**
 * Bare-invocation menu: when the user runs `inrepo` with no arguments in an
 * interactive terminal and the project is already initialized, present common
 * actions and dispatch into the matching command.
 */
export const cmdInteractive = async function cmdInteractive(
  cwd: string
): Promise<void> {
  let packagesCount: number | null = null;
  try {
    const cfg = await loadConfig(cwd);
    packagesCount = cfg.packages.length;
  } catch (error) {
    if (!isLoadConfigNotFoundError(error)) {
      throw error;
    }
  }

  printBanner();
  intro("inrepo");

  type Action = "sync" | "add" | "verify" | "patch" | "exit";
  // The default action is always `add`. Sync is destructive enough that it
  // should be a deliberate choice, never something a stray Enter triggers.
  const action = await select<Action>({
    initialValue: "add",
    message: "What would you like to do?",
    options: [
      {
        hint: "vendor a new git dependency",
        label: "Add a package",
        value: "add",
      },
      {
        hint: "clone/refresh all configured packages",
        label: `Sync packages${packagesCount == null ? "" : ` (${packagesCount})`}`,
        value: "sync",
      },
      {
        hint: "check vendored dirs match the lockfile",
        label: "Verify lockfile",
        value: "verify",
      },
      {
        hint: "capture edits into inrepo_patches",
        label: "Patch packages",
        value: "patch",
      },
      { label: "Exit", value: "exit" },
    ],
  });

  if (isCancel(action) || action === "exit") {
    cancel("Goodbye.");
    return;
  }

  try {
    if (action === "sync") {
      await cmdSync(cwd, [], { suppressBanners: true });
      outro("Sync complete.");
    } else if (action === "verify") {
      const ok = await cmdVerify(cwd, { suppressBanners: true });
      if (ok) {
        outro("All vendored modules match the lockfile.");
      } else {
        cancel("inrepo verify: lockfile and checkouts disagree.");
      }
    } else if (action === "patch") {
      // Series capture records the reason as the patch subject, so ask for it
      // here rather than making the user rerun with -m.
      const reason = await text({
        message: "Why are you capturing these changes?",
        placeholder: "Replace the event emitter for static compilation",
      });
      if (isCancel(reason)) {
        cancel("Patch cancelled.");
        return;
      }
      const trimmed = reason.trim();
      await cmdPatch(cwd, trimmed ? ["-m", trimmed] : [], {
        suppressBanners: true,
      });
      outro("Patch capture complete.");
    } else {
      const args = await promptAddArgs({ suppressBanners: true });
      if (args == null) {
        cancel("Add cancelled.");
        return;
      }
      await performAdd(cwd, args, { suppressBanners: true });
      outro(`Recorded "${args.name}" in inrepo config.`);
    }
  } catch (error) {
    const summary =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    cancel(`inrepo ${action} failed: ${summary}`);
    throw error;
  }
};
