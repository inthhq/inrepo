import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { InrepoError } from "../cli/errors.js";

export const AGENTS_BLOCK_START = "<!-- inrepo:agents:start -->";
export const AGENTS_BLOCK_END = "<!-- inrepo:agents:end -->";

/**
 * Guidance `inrepo init --agents` writes into a project's AGENTS.md (and
 * CLAUDE.md). Kept short: it is read on every agent turn. The full contract
 * lives in the package's AGENTS.md and docs/agents.md.
 */
const AGENTS_BLOCK_BODY = [
  "## Vendored packages (inrepo)",
  "",
  "This project vendors upstream packages with inrepo. Run it as `npx inrepo` when `inrepo` is not on PATH.",
  "",
  '- `inrepo_modules/<pkg>/` is generated. Edit files there, then run `inrepo patch <pkg> -m "<reason>"` before any `inrepo sync` or `inrepo update`, or the edits are lost.',
  "- Start with `inrepo status --json`. Each package has a `condition` and `nextActions`.",
  "- Pass `--json` to every command. stdout is one envelope: `{ ok: true, data }` or `{ ok: false, error: { code, message, hint, nextCommand } }`. Branch on `error.code`. Under `--json` the exit code also tells the class: 0 ok, 1 failure, 2 usage or config, 3 needs resolution, 4 upstream or network (without `--json` every failure exits 1).",
  "- Preview `add`, `sync`, `patch`, and `update` with `--dry-run`.",
  "- `inrepo update <pkg>` exits 3 with `UPDATE_CONFLICT` when a patch conflicts: remove the conflict markers from `error.details.conflictedFiles` under `error.details.repoPath`, then run `inrepo update <pkg> --continue`. Repeat until it exits 0, or run `inrepo update <pkg> --abort`.",
  "- Run `inrepo verify` before you finish. It must exit 0.",
  "- Never hand-edit `inrepo.lock.json` or `inrepo_patches/**/*.patch`. Change them only through inrepo commands.",
  "- Commit the inrepo config, `inrepo.lock.json`, and `inrepo_patches/`. Never commit `inrepo_modules/` or `.inrepo/`.",
  "- Full guide: `node_modules/inrepo/AGENTS.md` and `node_modules/inrepo/docs/agents.md` when inrepo is installed; otherwise `npx inrepo --help --json` lists every command.",
];

/** The delimited block, without a trailing newline. */
export const renderAgentsBlock = function renderAgentsBlock(
  eol = "\n"
): string {
  return [AGENTS_BLOCK_START, ...AGENTS_BLOCK_BODY, AGENTS_BLOCK_END].join(eol);
};

export type AgentsFileAction = "created" | "unchanged" | "updated";

export interface AgentsFileResult {
  /** POSIX path relative to the project root. */
  path: string;
  action: AgentsFileAction;
}

export interface AgentsResult {
  files: AgentsFileResult[];
}

const markerError = function markerError(file: string): InrepoError {
  return new InrepoError(
    "ERROR",
    `${file} has an unmatched inrepo marker. Keep both "${AGENTS_BLOCK_START}" and "${AGENTS_BLOCK_END}" (in that order), or delete both, then rerun.`,
    {
      details: { file },
      nextCommand: "inrepo init --agents",
    }
  );
};

/**
 * Insert or replace the inrepo block in `content`. A file without markers gets
 * the block appended after a blank line; a file with markers gets the text
 * between them (inclusive) replaced, so reruns are idempotent.
 */
export const upsertAgentsBlock = function upsertAgentsBlock(
  content: string,
  file: string
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const block = renderAgentsBlock(eol);
  const start = content.indexOf(AGENTS_BLOCK_START);
  const end = content.indexOf(AGENTS_BLOCK_END);
  if (start === -1 && end === -1) {
    if (content.trim() === "") {
      return `${block}${eol}`;
    }
    const trimmed = content.replace(/\s+$/u, "");
    return `${trimmed}${eol}${eol}${block}${eol}`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw markerError(file);
  }
  if (content.includes(AGENTS_BLOCK_START, start + 1)) {
    throw markerError(file);
  }
  return `${content.slice(0, start)}${block}${content.slice(end + AGENTS_BLOCK_END.length)}`;
};

const writeBlock = async function writeBlock(
  absolute: string,
  file: string
): Promise<AgentsFileAction> {
  if (!existsSync(absolute)) {
    await writeFile(absolute, upsertAgentsBlock("", file), "utf-8");
    return "created";
  }
  const before = await readFile(absolute, "utf-8");
  const after = upsertAgentsBlock(before, file);
  if (after === before) {
    return "unchanged";
  }
  await writeFile(absolute, after, "utf-8");
  return "updated";
};

/** True when both paths exist and resolve to the same file (e.g. a symlink). */
const isSameFile = function isSameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Whether CLAUDE.md should carry its own copy of the block. It does when it
 * already has one (keep it current), and otherwise only when it does not
 * already point the agent at AGENTS.md.
 */
const claudeNeedsBlock = async function claudeNeedsBlock(
  claudePath: string,
  agentsPath: string
): Promise<boolean> {
  if (!existsSync(claudePath) || isSameFile(claudePath, agentsPath)) {
    return false;
  }
  const content = await readFile(claudePath, "utf-8");
  if (content.includes(AGENTS_BLOCK_START)) {
    return true;
  }
  return !/AGENTS\.md/u.test(content);
};

/**
 * Upsert the inrepo guidance block into `<cwd>/AGENTS.md` (created when
 * missing) and, when needed, into an existing `<cwd>/CLAUDE.md`.
 */
export const writeAgentsGuidance = async function writeAgentsGuidance(
  cwd: string
): Promise<AgentsResult> {
  const agentsPath = nodePath.join(cwd, "AGENTS.md");
  const claudePath = nodePath.join(cwd, "CLAUDE.md");
  // Read CLAUDE.md before AGENTS.md changes: when one is a symlink to the
  // other, writing AGENTS.md would otherwise look like CLAUDE.md content.
  const includeClaude = await claudeNeedsBlock(claudePath, agentsPath);

  const files: AgentsFileResult[] = [
    { action: await writeBlock(agentsPath, "AGENTS.md"), path: "AGENTS.md" },
  ];
  if (includeClaude && !isSameFile(claudePath, agentsPath)) {
    files.push({
      action: await writeBlock(claudePath, "CLAUDE.md"),
      path: "CLAUDE.md",
    });
  }
  return { files };
};
