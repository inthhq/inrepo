import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecFileFailure extends Error {
  code?: string;
  stderr?: string | Buffer;
  status?: number | null;
}

const formatExecError = function formatExecError(
  error: ExecFileFailure,
  args: string[]
): Error {
  if (error.code === "ENOENT") {
    return new Error(
      `Failed to spawn git: ${error.message}. Is git installed and on your PATH?`,
      { cause: error }
    );
  }
  let stderr = "";
  if (error.stderr != null) {
    stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf-8")
      : error.stderr;
  }
  const tail = stderr.trim().slice(-2000);
  const code = error.status ?? "unknown";
  return new Error(
    `git ${args.join(" ")} failed (exit ${code})${tail ? `: ${tail}` : ""}`,
    { cause: error }
  );
};

export const runGit = async function runGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd: opts.cwd,
      env: opts.env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof Error) {
      // SAFETY: node execFile rejects with Error & { code, stderr, status }.
      throw formatExecError(error as ExecFileFailure, args);
    }
    throw new Error(`git ${args.join(" ")} failed: ${String(error)}`, {
      cause: error,
    });
  }
};
