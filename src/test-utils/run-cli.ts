import { spawn } from "node:child_process";
import { once } from "node:events";
import nodePath from "node:path";
import { text } from "node:stream/consumers";

const CLI_PATH = nodePath.resolve(import.meta.dirname, "..", "cli.ts");
const REGISTER_URL = import.meta.resolve("vite-plus/register");

export interface RunCliOptions {
  cwd: string;
  env?: { readonly [key: string]: string | undefined };
  /** Bytes to write to the CLI's stdin (e.g. answers to interactive prompts). */
  stdin?: string;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn `node --import vite-plus/register src/cli.ts ...args` and capture stdout/stderr/exit code. */
export const runCli = async function runCli(
  args: string[],
  opts: RunCliOptions
): Promise<RunCliResult> {
  const overrides = opts.env ?? {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in overrides)) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  const proc = spawn(
    process.execPath,
    ["--import", REGISTER_URL, CLI_PATH, ...args],
    {
      cwd: opts.cwd,
      env,
      stdio: [opts.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    }
  );

  if (opts.stdin != null && proc.stdin != null) {
    proc.stdin.end(opts.stdin);
  }

  if (proc.stdout == null || proc.stderr == null) {
    throw new Error("Expected piped stdout and stderr for CLI subprocess");
  }

  const [stdout, stderr] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
    once(proc, "close"),
  ]);

  return { exitCode: proc.exitCode ?? 1, stderr, stdout };
};
